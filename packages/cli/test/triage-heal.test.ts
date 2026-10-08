import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { commitAll, failureRecord, initRepo, makeTempDir, runCli, write } from './helpers.js';

const dirs: string[] = [];
function tmp(prefix = 'cli-triage'): string {
  const dir = makeTempDir(prefix);
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Build a git repo where app/payments/charge.ts changed in HEAD~1..HEAD. */
function regressionRepo(): string {
  const root = tmp();
  initRepo(root);
  write(root, 'app/payments/charge.ts', 'export function charge(a: number): number {\n  return a * 2;\n}\n');
  write(root, 'tests/charge.spec.ts', "import { test } from 'vitest';\ntest('charge', () => {});\n");
  commitAll(root, 'feat: baseline');
  write(root, 'app/payments/charge.ts', 'export function charge(a: number): number {\n  return a * 3;\n}\n');
  commitAll(root, 'fix: charge multiplier');
  return root;
}

describe('triage command', () => {
  it('classifies a canned REAL_REGRESSION record with diff context (--range) and exits 1', async () => {
    const root = regressionRepo();
    write(root, '.theqa/artifacts/failures.json', JSON.stringify([failureRecord({
      testId: 'charge-test',
      name: 'charge doubles the amount',
      filePath: 'tests/charge.spec.ts',
      layer: 'unit',
      attempts: [{
        status: 'failed',
        durationMs: 30,
        timestamp: '2026-02-01T10:00:00.000Z',
        environment: 'ci',
        errorType: 'AssertionError',
        errorMessage: 'expect(received).toBe(expected) — expected false to be true',
      }],
      changedFiles: ['app/payments/charge.ts'],
      domVerified: true,
      recentRuns: ['passed', 'failed'],
    })], null, 2));
    const res = await runCli(['triage', '--evidence', '.theqa/artifacts/failures.json', '--range', 'HEAD~1..HEAD', '--json'], root);
    expect(res.code).toBe(1);
    const data = res.json<{ ok: boolean; label: string; data: { failures: number; results: Array<{ testId: string; category: string; confidence: number; rootCauseHypothesis: string; recommendedAction: string; signals: Array<{ description: string; polarity: string }>; contradictingSignals: unknown[] }>; clusters: Array<{ id: string; testIds: string[] }>; primaryIds: string[]; cascadeIds: string[]; realRegressions: number } }>().data;
    const result = data.results[0];
    expect(result?.testId).toBe('charge-test');
    expect(result?.category).toBe('REAL_REGRESSION');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result?.rootCauseHypothesis).toMatch(/regression|changed/i);
    expect(result?.recommendedAction.length).toBeGreaterThan(10);
    expect(data.realRegressions).toBe(1);
    expect(data.clusters.length).toBe(1);
    expect(data.clusters[0]?.testIds).toEqual(['charge-test']);
    expect(envelopeOk(res)).toBe(true);
  });

  it('classifies the same record TEST_DEFECT without diff context (honest no-context default)', async () => {
    const root = regressionRepo();
    write(root, 'evidence.json', JSON.stringify([failureRecord({
      testId: 'charge-test',
      attempts: [{
        status: 'failed',
        durationMs: 30,
        timestamp: '2026-02-01T10:00:00.000Z',
        environment: 'ci',
        errorType: 'AssertionError',
        errorMessage: 'expect(received).toBe(expected) — expected false to be true',
      }],
      domVerified: true,
    })], null, 2));
    const res = await runCli(['triage', '--evidence', 'evidence.json', '--json'], root);
    expect(res.code).toBe(0); // TEST_DEFECT is a finding about the test, not a product regression
    const data = res.json<{ data: { results: Array<{ category: string; confidence: number }> } }>().data;
    expect(data.results[0]?.category).toBe('TEST_DEFECT');
    expect(data.results[0]?.confidence).toBe(0.7);
  });

  it('returns ok with no failures and NOT_RUN label when no evidence exists', async () => {
    const root = tmp();
    const res = await runCli(['triage', '--json'], root);
    expect(res.code).toBe(0);
    const env = res.json<{ label: string; data: { failures: number } }>();
    expect(env.label).toBe('NOT_RUN');
    expect(env.data.failures).toBe(0);
  });

  it('scans a directory for failures.json files', async () => {
    const root = tmp();
    write(root, 'ev/nested/failures.json', JSON.stringify([failureRecord({ testId: 'nested-1' })], null, 2));
    const res = await runCli(['triage', '--evidence', 'ev', '--json'], root);
    expect(res.code).toBe(0);
    expect(res.json<{ data: { failures: number } }>().data.failures).toBe(1);
  });

  it('errors with exit 2 when the evidence path does not exist', async () => {
    const root = tmp();
    const res = await runCli(['triage', '--evidence', 'missing.json', '--json'], root);
    expect(res.code).toBe(2);
    expect(res.json<{ data: { error: string } }>().data.error).toMatch(/does not exist/);
  });
});

describe('heal command', () => {
  it('builds a LOW proposal for the naive timeout suggestion (forbidden fix)', async () => {
    const root = tmp('cli-heal');
    dirs.push(root);
    write(root, 'tests/login.spec.ts', [
      "import { test } from '@playwright/test';",
      "test('login', async ({ page }) => {",
      "  await page.goto('/login');",
      '  await page.waitForTimeout(3000);',
      '});',
      '',
    ].join('\n'));
    write(root, 'evidence.json', JSON.stringify([failureRecord({
      testId: 'login-test',
      filePath: 'tests/login.spec.ts',
      attempts: [{
        status: 'failed',
        durationMs: 30500,
        timestamp: '2026-02-01T10:00:00.000Z',
        environment: 'local',
        errorType: 'TestTimeoutError',
        errorMessage: 'Test timeout of 30000ms exceeded.',
      }],
      changedFiles: [],
      recentRuns: ['passed', 'failed'],
    })], null, 2));
    const res = await runCli(['heal', '--evidence', 'evidence.json', '--json'], root);
    expect(res.code).toBe(0);
    const data = res.json<{ data: { proposals: Array<{ id: string; tier: string; kind: string; violations: string[]; description: string; currentCode: string; proposedCode: string }>; triage: Array<{ category: string }> } }>().data;
    expect(data.triage[0]?.category).toBe('TIMING_FAILURE');
    const proposal = data.proposals[0];
    expect(proposal).toBeDefined();
    expect(proposal?.tier).toBe('LOW');
    expect(proposal?.kind).toBe('timing');
    expect(proposal?.violations.join(' ')).toMatch(/timeout/);
    expect(proposal?.currentCode).toContain('waitForTimeout(3000)');
    expect(proposal?.description).toMatch(/web-first/i);
  });

  it('refuses --apply without --confirm-risk (exit 2 with hint)', async () => {
    const root = tmp('cli-heal2');
    dirs.push(root);
    write(root, 'tests/login.spec.ts', 'await page.waitForTimeout(3000);\n');
    write(root, 'evidence.json', JSON.stringify([failureRecord({
      testId: 'login-test',
      filePath: 'tests/login.spec.ts',
      attempts: [{
        status: 'failed',
        durationMs: 1,
        timestamp: '2026-02-01T10:00:00.000Z',
        environment: 'local',
        errorMessage: 'Test timeout of 30000ms exceeded.',
      }],
    })], null, 2));
    const res = await runCli(['heal', '--evidence', 'evidence.json', '--apply', '--json'], root);
    expect(res.code).toBe(2);
    const env = res.json<{ ok: boolean; data: { error: string; hint?: string } }>();
    expect(env.ok).toBe(false);
    expect(env.data.error).toMatch(/--confirm-risk/);
    expect(env.data.hint).toMatch(/--confirm-risk/);
  });

  it('applies a HIGH-tier selector proposal with snapshot evidence, backup written, learning recorded', async () => {
    const root = tmp('cli-heal3');
    dirs.push(root);
    const testSource = [
      "import { test, expect } from '@playwright/test';",
      "test('submit', async ({ page }) => {",
      "  await page.locator('#submit-old').click();",
      "  await expect(page.locator('#submit-old')).toBeVisible();",
      '});',
      '',
    ].join('\n');
    write(root, 'tests/submit.spec.ts', testSource);
    write(root, 'evidence.json', JSON.stringify({
      domSnapshots: { 'submit-test': '<button data-testid="submit-new">Go</button><button>Cancel</button>' },
      failures: [failureRecord({
        testId: 'submit-test',
        filePath: 'tests/submit.spec.ts',
        layer: 'e2e',
        attempts: [{
          status: 'failed',
          durationMs: 5000,
          timestamp: '2026-02-01T10:00:00.000Z',
          environment: 'local',
          errorType: 'TimeoutError',
          errorMessage: "TimeoutError: locator('#submit-old') waiting for element to be visible",
        }],
        changedFiles: [],
        domVerified: true,
      })],
    }, null, 2));
    const classify = await runCli(['triage', '--evidence', 'evidence.json', '--json'], root);
    expect(classify.json<{ data: { results: Array<{ category: string }> } }>().data.results[0]?.category).toBe('SELECTOR_FAILURE');

    const res = await runCli(['heal', '--evidence', 'evidence.json', '--apply', '--confirm-risk', '--json'], root);
    expect(res.code).toBe(0);
    const data = res.json<{ data: { proposals: Array<{ id: string; tier: string; kind: string }>; applied: Array<{ id: string; applied: boolean; reason: string; backupPath?: string }> } }>().data;
    const proposal = data.proposals[0];
    expect(proposal?.tier).toBe('HIGH');
    expect(proposal?.kind).toBe('selector');
    const applied = data.applied.find((a) => a.id === proposal?.id);
    expect(applied?.applied).toBe(true);
    const patched = readFileSync(join(root, 'tests', 'submit.spec.ts'), 'utf8');
    expect(patched).toContain('getByTestId(\'submit-new\')');
    expect(existsSync(join(root, 'tests', 'submit.spec.ts.pre-heal.bak'))).toBe(true);
    expect(readFileSync(join(root, '.theqa', 'learning.jsonl'), 'utf8')).toMatch(/healing_applied/);
  });

  it('builds an explain-only LOW proposal without a DOM snapshot', async () => {
    const root = tmp('cli-heal4');
    dirs.push(root);
    write(root, 'tests/submit.spec.ts', "await page.locator('#gone').click();\n");
    write(root, 'evidence.json', JSON.stringify([failureRecord({
      testId: 'submit-test',
      filePath: 'tests/submit.spec.ts',
      layer: 'e2e',
      attempts: [{
        status: 'failed',
        durationMs: 5000,
        timestamp: '2026-02-01T10:00:00.000Z',
        environment: 'local',
        errorMessage: "TimeoutError: locator('#gone') not found",
      }],
    })], null, 2));
    const res = await runCli(['heal', '--evidence', 'evidence.json', '--json'], root);
    expect(res.code).toBe(0);
    const data = res.json<{ data: { proposals: Array<{ tier: string; violations: string[] }> } }>().data;
    expect(data.proposals[0]?.tier).toBe('LOW');
    expect(data.proposals[0]?.violations.join(' ')).toMatch(/snapshot|guessing/i);
  });
});

function envelopeOk(res: { json: <T>() => T }): boolean {
  const env = res.json<{ ok: boolean }>();
  return env.ok === true || env.ok === false;
}
