import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GenerationAgent } from '../src/agents/generation.js';
import { makeTempDir } from './helpers.js';
import type { FeatureSpec, TestCase } from '../src/types.js';

const PAYMENT_SPEC: FeatureSpec = {
  name: 'Checkout Payment Flow',
  area: 'payment',
  description: 'Handles card charges during checkout',
  acceptanceCriteria: [
    'Orders with a total over 100 USD receive free shipping',
    'The payment form requires a valid card number and rejects malformed input',
    'Expired discount codes are rejected at checkout',
  ],
  businessRules: ['All monetary amounts are stored in minor units'],
};

const VALID_CATEGORIES = new Set([
  'positive', 'negative', 'boundary', 'state', 'concurrency',
  'security', 'accessibility', 'integration', 'time', 'resilience',
]);

function dirSize(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    if (statSync(join(dir, entry)).isFile()) count += 1;
  }
  return count;
}

describe('GenerationAgent.plan', () => {
  const agent = new GenerationAgent(makeTempDir('gen'));
  const plan = agent.plan(PAYMENT_SPEC);

  it('yields at least 10 cases for a 3-criterion spec', () => {
    expect(plan.summary.total).toBe(plan.cases.length);
    expect(plan.cases.length).toBeGreaterThanOrEqual(10);
  });

  it('assigns well-formed ids, categories, layers, and priorities', () => {
    for (const c of plan.cases) {
      expect(c.id).toMatch(/^checkout-payment-flow-[a-z]+-\d+$/);
      expect(VALID_CATEGORIES.has(c.category)).toBe(true);
      expect(c.rationale.length).toBeGreaterThan(10);
      expect(c.given.length).toBeGreaterThan(0);
      expect(c.when.length).toBeGreaterThan(0);
      expect(c.then.length).toBeGreaterThan(0);
      expect(['critical', 'high', 'medium', 'low']).toContain(c.priority);
    }
    const ids = plan.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('enumerates positive/negative/boundary per criterion and fires payment heuristics', () => {
    const count = (category: string): number => plan.cases.filter((c) => c.category === category).length;
    expect(count('positive')).toBe(3);
    expect(count('negative')).toBe(3);
    expect(count('boundary')).toBeGreaterThanOrEqual(6);
    expect(count('concurrency')).toBe(2); // duplicate submit + idempotency
    expect(count('security')).toBe(4); // authn/authz/IDOR/injection for payment area
    expect(count('time')).toBe(2); // expiry vocabulary
    const security = plan.cases.find((c) => c.category === 'security');
    expect(security?.priority).toBe('critical');
  });

  it('makes summary counts match the cases and documents fired heuristics', () => {
    const categorySum = Object.values(plan.summary.byCategory).reduce((a, b) => a + b, 0);
    const layerSum = Object.values(plan.summary.byLayer).reduce((a, b) => a + b, 0);
    expect(categorySum).toBe(plan.cases.length);
    expect(layerSum).toBe(plan.cases.length);
    for (const [category, n] of Object.entries(plan.summary.byCategory)) {
      expect(plan.cases.filter((c) => c.category === category)).toHaveLength(n);
    }
    expect(plan.heuristicNotes.length).toBeGreaterThanOrEqual(4);
    expect(plan.heuristicNotes.join(' ')).toMatch(/security/);
    expect(plan.label).toBe('INFERRED');
  });

  it('is deterministic — identical specs produce identical plans', () => {
    const again = agent.plan(PAYMENT_SPEC);
    expect(JSON.stringify(again)).toBe(JSON.stringify(plan));
  });

  it('promotes ui user-flow criteria to e2e and adds the a11y matrix', () => {
    const uiPlan = agent.plan({
      name: 'Profile Editor',
      area: 'ui',
      acceptanceCriteria: ['User can edit the profile page and navigate back to settings'],
    });
    expect(uiPlan.cases.some((c) => c.layer === 'e2e')).toBe(true);
    const a11y = uiPlan.cases.filter((c) => c.category === 'accessibility');
    expect(a11y.map((c) => `${c.title} ${c.id}`).join(' ')).toMatch(/role/);
    expect(a11y).toHaveLength(4);
  });

  it('keeps an honest empty plan when no criteria exist', () => {
    const empty = agent.plan({ name: 'Mystery Feature', acceptanceCriteria: [] });
    expect(empty.cases).toEqual([]);
    expect(empty.heuristicNotes.join(' ')).toMatch(/no acceptance criteria/);
  });

  it('documents the rationale of every priority tier decision', () => {
    const byPriority = (p: string): TestCase[] => plan.cases.filter((c) => c.priority === p);
    expect(byPriority('critical').length).toBeGreaterThan(0); // payment area
    expect(byPriority('high').every((c) => ['negative', 'boundary', 'concurrency'].includes(c.category))).toBe(true);
    expect(byPriority('medium').every((c) => c.category === 'positive')).toBe(true);
  });
});

describe('GenerationAgent.scaffold', () => {
  const agent = new GenerationAgent(makeTempDir('scaffold-gen'));
  const plan = agent.plan(PAYMENT_SPEC);
  const uiPlan = agent.plan({
    name: 'Profile Editor',
    area: 'ui',
    acceptanceCriteria: ['User can edit the profile page and navigate back to settings'],
  });

  it('dry-run creates nothing but records would-be bytes', () => {
    const outDir = join(makeTempDir('scaffold-dry'), 'out');
    const results = agent.scaffold(plan, outDir, { dryRun: true });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.action === 'dry-run')).toBe(true);
    expect(results.every((r) => r.bytes > 0)).toBe(true);
    expect(existsSync(outDir)).toBe(false);
  });

  it('writes skipped-vitest scaffolds and a playwright spec for e2e cases', () => {
    const outDir = join(makeTempDir('scaffold-real'), 'out');
    const results = agent.scaffold(uiPlan, outDir);
    expect(results.every((r) => r.action === 'created')).toBe(true);
    expect(existsSync(join(outDir, 'profile-editor.generated.test.ts'))).toBe(true);
    expect(existsSync(join(outDir, 'profile-editor.generated.spec.ts'))).toBe(true);

    const unit = readFileSync(join(outDir, 'profile-editor.generated.test.ts'), 'utf8');
    expect(unit).toContain('it.skip(');
    expect(unit).toContain('// Given:');
    expect(unit).toContain('// When:');
    expect(unit).toContain('// Then:');
    expect(unit).toMatch(/Implement from plan case profile-editor-positive-1/);
    expect(unit).not.toContain('TODO');

    const e2e = readFileSync(join(outDir, 'profile-editor.generated.spec.ts'), 'utf8');
    expect(e2e).toContain("import { test } from '@playwright/test';");
    expect(e2e).toContain('test.skip(');
  });

  it('never overwrites: second run skips, force re-creates', () => {
    const outDir = join(makeTempDir('scaffold-skip'), 'out');
    const first = agent.scaffold(plan, outDir);
    const before = dirSize(outDir);
    const second = agent.scaffold(plan, outDir);
    expect(second.every((r) => r.action === 'skipped')).toBe(true);
    expect(second.every((r) => r.bytes === 0)).toBe(true);
    expect(dirSize(outDir)).toBe(before);

    const forced = agent.scaffold(plan, outDir, { force: true });
    expect(forced.every((r) => r.action === 'created')).toBe(true);
    expect(first[0]?.path).toBe(forced[0]?.path);
  });

  it('records bytes for created files', () => {
    const outDir = join(makeTempDir('scaffold-bytes'), 'out');
    const results = agent.scaffold(plan, outDir);
    for (const r of results) {
      expect(r.bytes).toBeGreaterThan(0);
      expect(statSync(r.path).size).toBe(r.bytes);
    }
  });
});
