import { describe, expect, it } from 'vitest';
import { classifyFailure } from '../src/triage/classify.js';
import type { AttemptRecord, FailedTestRecord } from '../src/types.js';

const attempt = (status: AttemptRecord['status'], errorType?: string, errorMessage?: string, errorStack?: string): AttemptRecord => ({
  status,
  durationMs: 1200,
  timestamp: '2026-10-07T10:00:00Z',
  environment: 'ci',
  browser: 'chromium',
  errorType,
  errorMessage,
  errorStack,
});

const record = (over: Partial<FailedTestRecord>): FailedTestRecord => ({
  testId: 't1',
  name: 'login works',
  filePath: 'tests/auth.spec.ts',
  layer: 'e2e',
  attempts: [attempt('failed', 'AssertionError', 'expected 200 to equal 401')],
  changedFiles: [],
  recentRuns: ['passed', 'passed', 'passed'],
  ...over,
});

const NO_CTX = { coversChangedCode: false, relevantChangedFiles: [], selectorChangedInDiff: false };

describe('triage decision table', () => {
  it('classifies deterministic assertion failure over changed code as REAL_REGRESSION', () => {
    const result = classifyFailure(record({ attempts: [attempt('failed', 'AssertionError', 'expected total to equal 30') ] }), { ...NO_CTX, coversChangedCode: true, relevantChangedFiles: ['src/cart/total.ts'] });
    expect(result.category).toBe('REAL_REGRESSION');
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.signals.some((s) => s.description.includes('covers changed code'))).toBe(true);
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it('classifies assertion failure over unchanged code as TEST_DEFECT', () => {
    const result = classifyFailure(record({ attempts: [attempt('failed', 'AssertionError', 'expected header to contain Welcome')] }), NO_CTX);
    expect(result.category).toBe('TEST_DEFECT');
    expect(result.recommendedAction).toMatch(/specification|test/i);
  });

  it('refuses to let a retry wash out a regression (golden rule 2)', () => {
    const result = classifyFailure(
      record({ attempts: [attempt('failed', 'AssertionError', 'expected status to be 200'), attempt('passed')] }),
      { ...NO_CTX, coversChangedCode: true, relevantChangedFiles: ['src/api/orders.ts'] },
    );
    expect(result.category).toBe('REAL_REGRESSION');
  });

  it('classifies retry-pass with no relevant change and intermittent history as FLAKE', () => {
    const result = classifyFailure(
      record({
        attempts: [attempt('failed', 'TimeoutError', 'Timeout 30000ms exceeded waiting for element'), attempt('passed')],
        recentRuns: ['passed', 'failed', 'passed'],
      }),
      NO_CTX,
    );
    expect(result.category).toBe('FLAKE');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('classifies selector wait failure with selector changed in diff as SELECTOR_FAILURE', () => {
    const result = classifyFailure(
      record({
        attempts: [attempt('failed', 'TimeoutError', 'locator click: Timeout 30000ms exceeded waiting for selector .btn-submit')],
        changedFiles: ['src/components/submit-button.tsx'],
      }),
      { ...NO_CTX, selectorChangedInDiff: true },
    );
    expect(result.category).toBe('SELECTOR_FAILURE');
    expect(result.recommendedAction).toMatch(/do not weaken the assertion/);
  });

  it('classifies connection-refused with healthy evidence gap as ENVIRONMENT_FAILURE', () => {
    const result = classifyFailure(
      record({ attempts: [attempt('failed', 'Error', 'Error: connect ECONNREFUSED 127.0.0.1:5432')], networkVerified: false }),
      NO_CTX,
    );
    expect(result.category).toBe('ENVIRONMENT_FAILURE');
    expect(result.recommendedAction).toMatch(/environment/i);
  });

  it('classifies missing module as DEPENDENCY_FAILURE', () => {
    const result = classifyFailure(record({ attempts: [attempt('failed', 'Error', 'Cannot find module \'@acme/billing-core\'')] }), NO_CTX);
    expect(result.category).toBe('DEPENDENCY_FAILURE');
  });

  it('classifies duplicate key violation as TEST_DATA_DEFECT', () => {
    const result = classifyFailure(
      record({ attempts: [attempt('failed', 'DatabaseError', 'duplicate key value violates unique constraint "users_email_key"')] }),
      NO_CTX,
    );
    expect(result.category).toBe('TEST_DATA_DEFECT');
    expect(result.recommendedAction).toMatch(/factory|fixture/i);
  });

  it('classifies pure timeout with retry-pass as TIMING_FAILURE', () => {
    const result = classifyFailure(
      record({ attempts: [attempt('timedout', 'TimeoutError', 'test timeout of 5000ms exceeded'), attempt('passed')] }),
      NO_CTX,
    );
    expect(result.category).toBe('TIMING_FAILURE');
    expect(result.recommendedAction).toMatch(/golden|web-first|profile/i);
  });

  it('classifies SyntaxError as CONFIGURATION_FAILURE', () => {
    const result = classifyFailure(record({ attempts: [attempt('failed', 'SyntaxError', 'SyntaxError: Unexpected token \'}\' in config')] }), NO_CTX);
    expect(result.category).toBe('CONFIGURATION_FAILURE');
  });

  it('returns UNKNOWN with low confidence when nothing matches', () => {
    const result = classifyFailure(record({ attempts: [attempt('failed', 'WeirdError', 'the flux capacitor over-capacitated')] }), NO_CTX);
    expect(result.category).toBe('UNKNOWN');
    expect(result.confidence).toBeLessThanOrEqual(0.2);
  });

  it('every verdict carries signals, action, and evidence (explainability contract)', () => {
    for (const rec of [
      record({ attempts: [attempt('failed', 'AssertionError', 'expected A to equal B')] }),
      record({ attempts: [attempt('failed', 'Error', 'ECONNREFUSED 127.0.0.1:8080')] }),
      record({ attempts: [attempt('timedout', 'TimeoutError', 'deadline exceeded')] }),
    ]) {
      const result = classifyFailure(rec, NO_CTX);
      expect(result.signals.length + result.contradictingSignals.length).toBeGreaterThan(0);
      expect(result.recommendedAction.length).toBeGreaterThan(10);
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(['INFERRED', 'OBSERVED', 'CONFIRMED']).toContain(result.label);
    }
  });
});
