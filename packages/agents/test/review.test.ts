import { describe, expect, it } from 'vitest';
import { ReviewAgent, isTestShaped } from '../src/agents/review.js';
import { makeTempDir, write } from './helpers.js';

describe('ReviewAgent', () => {
  it('flags waitForTimeout files with a determinism deduction', async () => {
    const root = makeTempDir('review');
    write(
      root,
      'tests/bad.test.ts',
      [
        "import { it, expect } from 'vitest';",
        "it('loads slowly', () => {",
        '  page.waitForTimeout(3000);',
        '  expect(page.title()).toBeTruthy();',
        '});',
      ].join('\n'),
    );

    const reports = await new ReviewAgent(root).review(['tests/bad.test.ts']);
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report?.filePath).toBe('tests/bad.test.ts');
    const determinism = report?.deductions.find((d) => d.dimension === 'determinism');
    expect(determinism).toBeDefined();
    expect(determinism?.reason).toMatch(/arbitrary sleep/);
    expect(report?.score).toBeLessThan(100);
  });

  it('scores clean files higher and records strengths', async () => {
    const root = makeTempDir('review-good');
    write(
      root,
      'tests/bad.test.ts',
      ["import { it, expect } from 'vitest';", "it('loads slowly', () => {", '  page.waitForTimeout(3000);', '  expect(page.title()).toBeTruthy();', '});'].join('\n'),
    );
    write(
      root,
      'tests/good.test.ts',
      [
        "import { describe, expect, it } from 'vitest';",
        "describe('calculator', () => {",
        "  it('adds two numbers', () => {",
        '    expect(add(1, 2)).toBe(3);',
        '  });',
        "  it('rejects invalid input', () => {",
        '    expect(() => add(null as unknown as number, 2)).toThrow();',
        '  });',
        "  it('handles the zero boundary', () => {",
        '    expect(add(0, 0)).toBe(0);',
        '  });',
        '});',
      ].join('\n'),
    );

    const reports = await new ReviewAgent(root).review();
    expect(reports).toHaveLength(2);
    const bad = reports.find((r) => r.filePath === 'tests/bad.test.ts');
    const good = reports.find((r) => r.filePath === 'tests/good.test.ts');
    expect(good?.deductions.find((d) => d.dimension === 'determinism')).toBeUndefined();
    expect((good?.score ?? 0)).toBeGreaterThan((bad?.score ?? 0));
    expect(good?.strengths.join(' ')).toMatch(/no arbitrary sleeps/);
  });

  it('isTestShaped recognizes test/spec/__tests__ files only', () => {
    expect(isTestShaped('tests/a.test.ts')).toBe(true);
    expect(isTestShaped('e2e/checkout.spec.js')).toBe(true);
    expect(isTestShaped('__tests__/util.ts')).toBe(true);
    expect(isTestShaped('src/index.ts')).toBe(false);
    expect(isTestShaped('src/README.md')).toBe(false);
  });
});
