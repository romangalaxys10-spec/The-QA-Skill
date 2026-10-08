import { describe, expect, it } from 'vitest';
import { scoreFlake, suiteFlakeHealth } from '../src/flake/score.js';
import { buildSignature, clusterFailures, normalizeMessage, signatureSimilarity } from '../src/triage/signature.js';
import { strongestLabel, weakestLabel, canConfirm, describeLabel } from '../src/labels.js';
import { GOLDEN_RULES } from '../src/golden-rules.js';
import { classifyAction, requiresConfirmation, assertAuthorized } from '../src/policies.js';
import { LIFECYCLE_PHASES, LifecycleTracker, LifecycleError } from '../src/lifecycle.js';

describe('flake intelligence', () => {
  it('scores an alternating failure pattern as flaky with reasons', () => {
    const outcomes = Array.from({ length: 8 }, (_, i) => ({
      status: (i % 2 === 0 ? 'failed' : 'passed') as 'failed' | 'passed',
      timestamp: `2026-10-0${(i % 7) + 1}T10:00:00Z`,
    }));
    const a = scoreFlake({ testId: 't1', outcomes, retryCount: 2, environments: ['ci', 'local'], browsers: ['chromium'] });
    expect(a.score).toBeGreaterThanOrEqual(45);
    expect(['flaky', 'critical_flaky']).toContain(a.verdict);
    expect(a.reasons.some((r) => r.includes('intermittent'))).toBe(true);
    expect(a.reasons.some((r) => r.includes('retr'))).toBe(true);
  });

  it('scores a stable passing test as stable', () => {
    const outcomes = Array.from({ length: 10 }, () => ({ status: 'passed' as const, timestamp: '2026-10-01T10:00:00Z' }));
    const a = scoreFlake({ testId: 't2', outcomes, retryCount: 0, environments: [], browsers: [] });
    expect(a.verdict).toBe('stable');
    expect(a.score).toBeLessThan(20);
  });

  it('marks multi-environment failures as more suspicious', () => {
    const mk = (envs: string[]) => scoreFlake({
      testId: 't3',
      outcomes: [{ status: 'failed', timestamp: 'x' }, { status: 'passed', timestamp: 'y' }],
      retryCount: 1,
      environments: envs,
      browsers: ['chromium'],
    });
    const spread = mk(['ci', 'local', 'staging']);
    const narrow = mk(['ci']);
    expect(spread.score).toBeGreaterThan(narrow.score);
  });

  it('aggregates suite flake health', () => {
    const good = { testId: 'a', score: 5, verdict: 'stable' as const, reasons: [], failRate: 0, label: 'OBSERVED' as const };
    const bad = { testId: 'b', score: 90, verdict: 'critical_flaky' as const, reasons: [], failRate: 0.9, label: 'OBSERVED' as const };
    expect(suiteFlakeHealth([good, good]).score).toBe(100);
    expect(suiteFlakeHealth([good, bad]).score).toBeLessThan(100);
    expect(suiteFlakeHealth([]).score).toBe(100);
  });
});

describe('failure signatures & clustering', () => {
  it('normalizes noise (paths, timestamps, numbers) out of messages', () => {
    const n = normalizeMessage('Error at /repo/node_modules/lib/x.js:42:7 after 2026-10-07T10:00:00Z with id 9f8d2c11-2233-4a5b-8c7d-1234567890ab amount 123.45');
    expect(n).not.toContain('node_modules/lib');
    expect(n).toContain('<ts>');
    expect(n).toContain('<uuid>');
  });

  it('clusters 4 same-cause failures into one cluster (the 87→1 scenario, small case)', () => {
    const failure = (testId: string) => ({
      testId,
      name: testId,
      filePath: 'tests/orders.spec.ts',
      errorType: 'AssertionError',
      errorMessage: `expected 500 to equal 200 at GET /api/auth/session`,
      errorStack: `at orders.test /repo/tests/orders.spec.ts:12:5`,
      browser: 'chromium',
      environment: 'ci',
    });
    const clusters = clusterFailures([failure('a'), failure('b'), failure('c'), failure('d')]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.testIds).toHaveLength(4);
  });

  it('keeps distinct failures in distinct clusters', () => {
    const clusters = clusterFailures([
      { testId: 'a', name: 'a', filePath: 'x.spec.ts', errorType: 'TypeError', errorMessage: 'undefined is not a function', errorStack: '', environment: 'ci' },
      { testId: 'b', name: 'b', filePath: 'y.spec.ts', errorType: 'AssertionError', errorMessage: 'expected 200 to equal 404', errorStack: '', environment: 'ci' },
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('signature similarity is 1 for identical and low for disjoint', () => {
    const mk = (msg: string) => buildSignature({ testId: 't', name: 't', filePath: 'f.spec.ts', errorType: 'E', errorMessage: msg, errorStack: '' });
    expect(signatureSimilarity(mk('login failed for user admin'), mk('login failed for user admin'))).toBe(1);
    expect(signatureSimilarity(mk('login failed for user admin'), mk('database connection refused'))).toBeLessThan(0.4);
  });
});

describe('verification labels', () => {
  it('strongest/weakest composition and confirmability', () => {
    expect(strongestLabel(['NOT_VERIFIED', 'OBSERVED'])).toBe('OBSERVED');
    expect(weakestLabel(['OBSERVED', 'NOT_RUN'])).toBe('NOT_RUN');
    expect(canConfirm([{ id: 'e', kind: 'test_output', summary: 's', collectedAt: 't', label: 'OBSERVED' }])).toBe(true);
    expect(canConfirm([{ id: 'e', kind: 'reasoning', summary: 's', collectedAt: 't', label: 'INFERRED' }])).toBe(false);
  });
  it('describes every label', () => {
    for (const l of ['NOT_VERIFIED', 'NOT_RUN', 'INFERRED', 'OBSERVED', 'CONFIRMED'] as const) {
      expect(describeLabel(l).length).toBeGreaterThan(5);
    }
  });
});

describe('golden rules & safety policy', () => {
  it('defines all 15 rules with enforcement points', () => {
    expect(GOLDEN_RULES).toHaveLength(15);
    for (const r of GOLDEN_RULES) {
      expect(r.enforcedBy.length).toBeGreaterThan(5);
    }
  });

  it('classifies the documented action set', () => {
    expect(requiresConfirmation('discover')).toBe(false);
    expect(requiresConfirmation('test')).toBe(false);
    expect(requiresConfirmation('db.migrate')).toBe(true);
    expect(requiresConfirmation('deploy')).toBe(true);
    expect(requiresConfirmation('test.production')).toBe(true);
    expect(() => assertAuthorized('deploy', {})).toThrow(/--confirm-risk/);
    expect(() => assertAuthorized('deploy', { confirmRisk: true })).not.toThrow();
    // Unknown actions default conservative.
    expect(requiresConfirmation('definitely.unregistered.action')).toBe(true);
  });
});

describe('lifecycle enforcement', () => {
  it('walks the 12 phases in order', () => {
    const t = new LifecycleTracker();
    for (const phase of LIFECYCLE_PHASES) {
      t.begin(phase);
      t.complete(phase);
    }
    expect(t.snapshot().every((p) => p.status === 'complete')).toBe(true);
    expect(t.renderProgress()).toContain('LEARN✓');
  });

  it('refuses to EXECUTE without a PLAN (no "just write tests" jumps)', () => {
    const t = new LifecycleTracker();
    t.begin('DISCOVER'); t.complete('DISCOVER');
    expect(() => t.begin('EXECUTE')).toThrow(LifecycleError);
    expect(() => t.begin('EXECUTE')).toThrow(/MODEL, PLAN, GENERATE, VALIDATE/);
  });

  it('mandatory phases cannot be skipped even with a reason', () => {
    const t = new LifecycleTracker();
    expect(() => t.skip('TRIAGE', 'too busy')).toThrow(/mandatory/);
  });

  it('optional phases can be skipped with a recorded reason', () => {
    const t = new LifecycleTracker();
    for (const phase of ['DISCOVER', 'MODEL', 'PLAN', 'GENERATE'] as const) { t.begin(phase); t.complete(phase); }
    const rec = t.skip('VALIDATE', 'no generated tests in this run');
    expect(rec.status).toBe('skipped');
    expect(rec.note).toMatch(/no generated tests/);
  });
});
