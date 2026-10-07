import { describe, expect, it } from 'vitest';
import { classifyRouting } from '../src/impact/diff.js';
import { selectTests } from '../src/impact/select.js';
import { classifyArea } from '../src/risk/factors.js';
import type { ChangedFile, TestInventoryEntry } from '../src/types.js';

const file = (path: string): ChangedFile => ({
  path,
  status: 'modified',
  additions: 30,
  deletions: 5,
  area: classifyArea(path),
  language: 'typescript',
  symbols: [],
});

const test = (id: string, filePath: string, layer: TestInventoryEntry['layer'], covers: string[], framework = 'vitest'): TestInventoryEntry => ({
  testId: id,
  name: `${id} suite`,
  filePath,
  layer,
  framework,
  covers,
});

describe('intelligent test selection', () => {
  it('selects tests that cover changed files with explicit reasons', () => {
    const result = selectTests([file('src/payments/charge.ts')], [
      test('pay-unit', 'tests/charge.test.ts', 'unit', ['src/payments/charge.ts']),
      test('unrelated', 'tests/ui.test.ts', 'e2e', ['src/ui/widget.tsx']),
    ]);
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]?.test.testId).toBe('pay-unit');
    expect(result.selected[0]?.reasons[0]).toMatch(/covers changed file/);
    expect(result.selected[0]?.priority).toBe('critical');
    expect(result.unaffected.map((t) => t.testId)).toContain('unrelated');
    expect(result.summary).toMatch(/1 of 2/);
  });

  it('routes CSS-only changes away from API suites', () => {
    const changed = [file('src/theme/button.css')];
    const routing = classifyRouting(changed);
    expect(routing.cssOnly).toBe(true);
    const result = selectTests(changed, [
      test('api-suite', 'tests/api/payments.test.ts', 'api', ['src/theme/button.css']),
      test('visual', 'tests/visual/button.spec.ts', 'visual', ['src/theme/button.css']),
    ], routing);
    const api = result.selected.find((s) => s.test.testId === 'api-suite');
    const visual = result.selected.find((s) => s.test.testId === 'visual');
    expect(api?.priority).toBe('low');
    expect(api?.reasons.join(' ')).toMatch(/css-only/);
    expect(visual?.priority).not.toBe('low');
  });

  it('elevates data-integrity tests for migration changes', () => {
    const changed = [file('migrations/0042_orders.sql')];
    const routing = classifyRouting(changed);
    expect(routing.migrationRelated).toBe(true);
    const result = selectTests(changed, [
      test('data-integrity', 'tests/data/integrity.test.ts', 'integration', ['migrations/0042_orders.sql']),
    ], routing);
    expect(result.selected[0]?.priority).toBe('critical');
    expect(result.selected[0]?.reasons.join(' ')).toMatch(/migration change/);
  });

  it('demotes E2E when lower layers cover the same file (pyramid intelligence)', () => {
    const changed = [file('src/cart/total.ts')];
    const result = selectTests(changed, [
      test('unit-total', 'tests/total.test.ts', 'unit', ['src/cart/total.ts']),
      test('e2e-checkout', 'tests/e2e/checkout.spec.ts', 'e2e', ['src/cart/total.ts', 'src/cart/page.tsx']),
    ]);
    const e2e = result.selected.find((s) => s.test.testId === 'e2e-checkout');
    expect(e2e?.reasons.join(' ')).toMatch(/lower-layer tests already cover/);
  });

  it('warns about known-flaky tests instead of silently running them', () => {
    const result = selectTests([file('src/search/index.ts')], [
      test('search', 'tests/search.test.ts', 'api', ['src/search/index.ts']),
    ]);
    const entry = result.selected[0];
    expect(entry).toBeDefined();
    const flakyInventory = selectTests([file('src/search/index.ts')], [{ ...entry!.test, flakeScore: 82 }]);
    expect(flakyInventory.selected[0]?.reasons.join(' ')).toMatch(/known flaky/);
  });

  it('reports a coverage gap when nothing covers the change', () => {
    const result = selectTests([file('src/new-feature/thing.ts')], [test('other', 'tests/other.test.ts', 'unit', ['src/old.ts'])]);
    expect(result.selected).toHaveLength(0);
    expect(result.summary).toMatch(/coverage gap/);
  });

  it('sorts critical before high before low', () => {
    const result = selectTests([file('src/auth/token.ts'), file('src/utils/slug.ts')], [
      test('util', 'tests/slug.test.ts', 'unit', ['src/utils/slug.ts']),
      test('auth', 'tests/token.test.ts', 'api', ['src/auth/token.ts']),
    ]);
    expect(result.selected[0]?.test.testId).toBe('auth');
    expect(result.selected[0]?.priority).toBe('critical');
  });
});
