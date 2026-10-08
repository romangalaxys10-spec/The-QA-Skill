import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { commitAll, initRepo, makeTempDir, runCli, write } from './helpers.js';

const dirs: string[] = [];
function tmp(prefix = 'cli-risk'): string {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('risk command', () => {
  it('assesses a temp git repo: tier, factors, and explanation starting with "Risk:"', async () => {
    const root = tmp();
    initRepo(root);
    write(root, 'app/payments/charge.ts', 'export function charge(a: number): number {\n  return a * 2;\n}\n');
    commitAll(root, 'feat: charge');
    const res = await runCli(['risk', '--json'], root);
    expect(res.code).toBe(0);
    const envelope = res.json<{ command: string; label: string; data: { assessment: { score: number; tier: string; explanation: string; factors: unknown[]; label: string }; changedFiles: unknown[]; routing: Record<string, unknown>; range: string } }>();
    expect(envelope.command).toBe('risk');
    expect(envelope.data.assessment.score).toBeGreaterThanOrEqual(0);
    expect(['low', 'medium', 'high', 'critical']).toContain(envelope.data.assessment.tier);
    expect(envelope.data.assessment.explanation).toMatch(/^Risk: \d+\/100 \(\w+\)/);
    expect(envelope.data.assessment.factors.length).toBe(8);
    expect(envelope.data.changedFiles.length).toBeGreaterThan(0);
    expect(envelope.data.routing).toHaveProperty('paymentRelated');
    expect(envelope.data.range).toBe('HEAD~1..HEAD');
  });

  it('honors --range for an older diff', async () => {
    const root = tmp();
    initRepo(root);
    write(root, 'src/a.ts', 'export const a = 1;\n');
    commitAll(root, 'feat: a');
    write(root, 'src/b.ts', 'export const b = 2;\n');
    commitAll(root, 'feat: b');
    const res = await runCli(['risk', '--range', 'HEAD~1..HEAD', '--json'], root);
    expect(res.code).toBe(0);
    expect(res.json<{ data: { changedFiles: Array<{ path: string }> } }>().data.changedFiles.map((f) => f.path)).toContain('src/b.ts');
  });

  it('falls back to the empty tree for a first-commit repo', async () => {
    const root = tmp();
    initRepo(root);
    write(root, 'src/only.ts', 'export const only = 1;\n');
    commitAll(root, 'feat: only commit');
    const res = await runCli(['risk', '--json'], root);
    expect(res.code).toBe(0);
    expect(res.json<{ data: { changedFiles: unknown[] } }>().data.changedFiles.length).toBeGreaterThan(0);
  });

  it('errors with exit 2 and a hint outside a git repository', async () => {
    const root = tmp();
    const res = await runCli(['risk', '--json'], root);
    expect(res.code).toBe(2);
    const envelope = res.json<{ ok: boolean; data: { error: string; hint?: string } }>();
    expect(envelope.ok).toBe(false);
    expect(envelope.data.error).toMatch(/needs a git repository/);
    expect(envelope.data.hint).toMatch(/git rev-parse/);
  });
});

describe('impact command', () => {
  it('selects covering tests grouped by priority with file-level reasons (payment critical)', async () => {
    const root = tmp('cli-impact');
    dirs.push(root);
    initRepo(root);
    write(root, 'app/payments/charge.ts', 'export function charge(a: number): number {\n  return a * 2;\n}\n');
    write(root, 'tests/charge.spec.ts', "import { charge } from '../app/payments/charge';\nimport { test, expect } from '@playwright/test';\ntest('charge doubles', () => { expect(charge(2)).toBe(4); });\n");
    write(root, 'tests/unrelated.test.ts', "import { test } from 'vitest';\ntest('unrelated', () => {});\n");
    commitAll(root, 'feat: payments baseline');
    write(root, 'app/payments/charge.ts', 'export function charge(a: number): number {\n  return a * 3;\n}\n');
    commitAll(root, 'fix: charge multiplier');
    const res = await runCli(['impact', '--json'], root);
    expect(res.code).toBe(0);
    const data = res.json<{ ok: boolean; label: string; data: { selected: Array<{ test: { filePath: string }; priority: string; reasons: string[] }>; unaffected: Array<{ filePath: string }>; routing: Array<{ rule: string; triggered: boolean }>; summary: string; changedFiles: unknown[]; addedLines: number; range: string } }>().data;
    const charge = data.selected.find((s) => s.test.filePath === 'tests/charge.spec.ts');
    expect(charge).toBeDefined();
    expect(charge?.priority).toBe('critical');
    expect(charge?.reasons.length).toBeGreaterThan(0);
    expect(charge?.reasons.join(' ')).toMatch(/covers changed file/);
    expect(charge?.reasons.join(' ')).toMatch(/payment area change/);
    expect(data.selected.length).toBe(1);
    expect(data.unaffected.map((t) => t.filePath)).toContain('tests/unrelated.test.ts');
    expect(data.routing.find((h) => h.rule === 'payment-change')?.triggered).toBe(true);
    expect(data.label).toBe('INFERRED');
    expect(data.summary).toMatch(/2 of 2|smallest high-confidence set/);
    expect(data.range).toBe('HEAD~1..HEAD');
  });

  it('honors --suite glob filtering', async () => {
    const root = tmp('cli-impact2');
    dirs.push(root);
    initRepo(root);
    write(root, 'src/util.ts', 'export const u = 1;\n');
    write(root, 'tests/util.test.ts', "import { u } from '../src/util';\nimport { test } from 'vitest';\ntest('u', () => {});\n");
    commitAll(root, 'feat: util');
    write(root, 'src/util.ts', 'export const u = 2;\n');
    commitAll(root, 'fix: util');
    const res = await runCli(['impact', '--suite', '**/util.test.ts', '--json'], root);
    expect(res.code).toBe(0);
    const data = res.json<{ data: { selected: unknown[]; summary: string } }>().data;
    expect(data.selected.length).toBe(1);
    expect(data.summary).toMatch(/--suite/);
  });

  it('errors with exit 2 outside a git repository', async () => {
    const root = tmp('cli-impact3');
    dirs.push(root);
    const res = await runCli(['impact', '--json'], root);
    expect(res.code).toBe(2);
    expect(res.json<{ data: { error: string } }>().data.error).toMatch(/needs a git repository/);
  });

  it('reports a coverage gap honestly when no test covers the change', async () => {
    const root = tmp('cli-impact4');
    dirs.push(root);
    initRepo(root);
    write(root, 'src/lonely.ts', 'export const l = 1;\n');
    commitAll(root, 'feat: lonely');
    write(root, 'src/lonely.ts', 'export const l = 2;\n');
    commitAll(root, 'fix: lonely');
    const res = await runCli(['impact', '--json'], root);
    expect(res.code).toBe(0);
    const data = res.json<{ data: { selected: unknown[]; summary: string } }>().data;
    expect(data.selected.length).toBe(0);
    expect(data.summary).toMatch(/coverage gap|No inventory test covers/);
  });
});

describe('plan command', () => {
  it('produces the deterministic plan shape: objectives, layers, policy, open questions', async () => {
    const root = tmp('cli-plan');
    dirs.push(root);
    write(root, 'package.json', JSON.stringify({ name: 'shop', private: true, devDependencies: { vitest: '^2' } }, null, 2));
    write(root, 'app/payments/charge.ts', 'export const charge = 1;\n');
    write(root, 'README.md', '# Shop\n\n## Checkout flow\n\n- must reject expired cards\n');
    const res = await runCli(['plan', '--json'], root);
    expect(res.code).toBe(0);
    const data = res.json<{ label: string; data: { contextSource: string; objectives: Array<{ area: string; objective: string }>; proposedLayers: Array<{ layer: string }>; policy: { recommended: string; rationale: string }; openQuestions: string[]; requirements: Array<{ id: string; priority: string; title: string }> } }>().data;
    expect(data.contextSource).toBe('discovered');
    expect(data.objectives[0]?.area).toBe('payment');
    expect(data.objectives[0]?.objective).toMatch(/charge|checkout/i);
    expect(data.proposedLayers.map((l) => l.layer)).toContain('unit');
    expect(data.proposedLayers.map((l) => l.layer)).toContain('api');
    expect(['pr', 'pre_merge', 'nightly', 'release', 'post_deploy']).toContain(data.policy.recommended);
    expect(data.policy.recommended).toBe('pre_merge'); // no tests yet → stricter policy
    expect(data.openQuestions.some((q) => q.includes('theqa.config.json'))).toBe(true);
    expect(data.openQuestions.some((q) => q.includes('criticalFlows'))).toBe(true);
    expect(data.requirements.length).toBe(1);
    expect(data.requirements[0]?.priority).toBe('must');
    expect(data.label).toBe('INFERRED');
  });

  it('is deterministic across runs', async () => {
    const root = tmp('cli-plan2');
    dirs.push(root);
    write(root, 'package.json', JSON.stringify({ name: 'det', private: true }, null, 2));
    write(root, 'src/x.ts', 'export const x = 1;\n');
    const first = await runCli(['plan', '--json'], root);
    const second = await runCli(['plan', '--json'], root);
    expect(first.stdout).toBe(second.stdout);
  });
});

describe('coverage command', () => {
  it('computes risk-weighted coverage and surfaces the payment gap area', async () => {
    const root = tmp('cli-coverage');
    dirs.push(root);
    write(root, 'package.json', JSON.stringify({ name: 'shop', private: true, devDependencies: { vitest: '^2' } }, null, 2));
    write(root, 'app/payments/charge.ts', 'export const charge = 1;\n');
    write(root, 'src/util.ts', 'export const u = 1;\n');
    write(root, 'tests/util.test.ts', "import { u } from '../src/util';\nimport { test } from 'vitest';\ntest('u', () => {});\n");
    const res = await runCli(['coverage', '--json'], root);
    expect(res.code).toBe(0);
    const data = res.json<{ label: string; data: { weightedCoverage: number; fileCoverage: number; gaps: Array<{ path: string; area: string; riskWeight: number; reason: string }>; criticalFlowCoverage: unknown[] } }>().data;
    const paymentGap = data.gaps.find((g) => g.area === 'payment');
    expect(paymentGap).toBeDefined();
    expect(paymentGap?.path).toBe('app/payments/charge.ts');
    expect(paymentGap?.reason).toMatch(/payment/i);
    // covered util is not a gap; payment (10) uncovered, util (1) covered:
    expect(data.weightedCoverage).toBeGreaterThan(0);
    expect(data.weightedCoverage).toBeLessThan(100);
    expect(data.label).toBe('INFERRED');
  });

  it('respects configured criticalFlows with --flows', async () => {
    const root = tmp('cli-coverage2');
    dirs.push(root);
    write(root, 'theqa.config.json', JSON.stringify({ schemaVersion: 1, project: { name: 'shop', criticalFlows: [{ name: 'checkout', patterns: ['payments'] }] } }, null, 2));
    write(root, 'app/payments/charge.ts', 'export const charge = 1;\n');
    const res = await runCli(['coverage', '--flows', '--json'], root);
    expect(res.code).toBe(0);
    const flows = res.json<{ data: { criticalFlowCoverage: Array<{ flow: string; covered: boolean; note: string }> } }>().data.criticalFlowCoverage;
    expect(flows).toEqual([{ flow: 'checkout', covered: false, note: 'files exist but no test reaches them' }]);
  });
});
