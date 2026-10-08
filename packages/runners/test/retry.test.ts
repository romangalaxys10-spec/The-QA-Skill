import { describe, expect, it } from 'vitest';
import type { AttemptRecord, FailedTestRecord } from '@the-qa-skill/core';
import { RETRY_POLICY_NOTE, RetryManager } from '../src/retry.js';

function failedRecord(attemptCount: number, testId = 'tests/x.spec.ts::flaky login'): FailedTestRecord {
  const attempts: AttemptRecord[] = Array.from({ length: attemptCount }, (_, i) => ({
    status: (i === attemptCount - 1 ? 'failed' : 'passed') as 'failed' | 'passed',
    durationMs: 100,
    timestamp: `2026-10-07T10:00:0${i}Z`,
    environment: 'ci',
  }));
  return {
    testId,
    name: 'flaky login',
    filePath: 'tests/x.spec.ts',
    layer: 'e2e',
    attempts,
    changedFiles: [],
    recentRuns: [],
  };
}

describe('RetryManager', () => {
  it('allows the full budget for a first-time failure', () => {
    const rm = new RetryManager(2);
    expect(rm.plan(failedRecord(1))).toBe(2);
  });

  it('decrements by retries already spent in the attempt history', () => {
    const rm = new RetryManager(3);
    // attempts: 1 initial + 2 retries spent → 1 more allowed.
    expect(rm.plan(failedRecord(3))).toBe(1);
    // Budget exhausted → 0, never negative.
    expect(rm.plan(failedRecord(5))).toBe(0);
  });

  it('NEVER retries failures classified REAL_REGRESSION (golden rule 2)', () => {
    const rm = new RetryManager(3);
    const map = new Map([['tests/x.spec.ts::flaky login', 'REAL_REGRESSION' as const]]);
    expect(rm.plan(failedRecord(1), map)).toBe(0);
    const objectLookup = { 'tests/x.spec.ts::flaky login': 'REAL_REGRESSION' as const };
    expect(rm.plan(failedRecord(1), objectLookup)).toBe(0);
  });

  it('supports both Map and plain-object classification lookups for flake', () => {
    const rm = new RetryManager(2);
    const map = new Map([['tests/x.spec.ts::flaky login', 'FLAKE' as const]]);
    expect(rm.plan(failedRecord(1), map)).toBe(2);
    expect(rm.plan(failedRecord(1), { 'tests/x.spec.ts::flaky login': 'FLAKE' as const })).toBe(2);
    expect(rm.plan(failedRecord(1), undefined)).toBe(2);
  });

  it('returns zero when the configured budget is zero', () => {
    expect(new RetryManager(0).plan(failedRecord(1))).toBe(0);
  });

  it('documents the policy: retries diagnose flakes, they never hide regressions', () => {
    expect(RETRY_POLICY_NOTE).toContain('flake diagnostics');
    expect(RETRY_POLICY_NOTE).toContain('never to hide regressions');
    expect(RETRY_POLICY_NOTE).toContain('golden rule 2');
  });
});
