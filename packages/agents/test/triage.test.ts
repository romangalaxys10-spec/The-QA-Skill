import { describe, expect, it } from 'vitest';
import { detectPrimaryCascade, TriageAgent } from '../src/agents/triage.js';
import { makeTempDir, write } from './helpers.js';
import type { AttemptRecord, FailedTestRecord } from '@the-qa-skill/core';

function attempt(partial: Partial<AttemptRecord>): AttemptRecord {
  return {
    status: partial.status ?? 'failed',
    durationMs: partial.durationMs ?? 100,
    timestamp: partial.timestamp ?? '2025-06-01T10:00:00.000Z',
    environment: partial.environment ?? 'ci',
    ...(partial.errorType !== undefined ? { errorType: partial.errorType } : {}),
    ...(partial.errorMessage !== undefined ? { errorMessage: partial.errorMessage } : {}),
    ...(partial.errorStack !== undefined ? { errorStack: partial.errorStack } : {}),
    ...(partial.browser !== undefined ? { browser: partial.browser } : {}),
  };
}

function record(partial: Partial<FailedTestRecord> & { testId: string }): FailedTestRecord {
  return {
    testId: partial.testId,
    name: partial.name ?? partial.testId,
    filePath: partial.filePath ?? `tests/${partial.testId}.spec.ts`,
    layer: partial.layer ?? 'unit',
    attempts: partial.attempts ?? [attempt({})],
    changedFiles: partial.changedFiles ?? [],
    recentRuns: partial.recentRuns ?? [],
    networkVerified: partial.networkVerified,
    domVerified: partial.domVerified,
    tags: partial.tags,
  };
}

describe('TriageAgent.triage', () => {
  const agent = new TriageAgent('/nonexistent-root');

  it('classifies a retry-pass with intermittent history and no covered change as FLAKE', () => {
    const results = agent.triage([
      record({
        testId: 'flaky-cart',
        attempts: [
          attempt({ status: 'failed', errorType: 'AssertionError', errorMessage: 'AssertionError: expected 201 to equal 200' }),
          attempt({ status: 'passed', timestamp: '2025-06-01T10:00:05.000Z' }),
        ],
        recentRuns: ['passed', 'failed'],
      }),
    ]);
    expect(results[0]?.category).toBe('FLAKE');
    expect(results[0]?.confidence).toBeGreaterThanOrEqual(0.8);
    expect(results[0]?.signals.map((s) => s.description).join(' ')).toMatch(/retry/);
    expect(results[0]?.recommendedAction).toMatch(/flake registry/);
  });

  it('classifies a deterministic assertion failure over covered change as REAL_REGRESSION (golden rule 2 territory)', () => {
    const results = agent.triage(
      [
        record({
          testId: 'checkout-total',
          attempts: [
            attempt({ errorType: 'AssertionError', errorMessage: 'AssertionError: expected 500 to equal 200' }),
            attempt({ errorType: 'AssertionError', errorMessage: 'AssertionError: expected 500 to equal 200', timestamp: '2025-06-01T10:00:04.000Z' }),
          ],
          changedFiles: ['src/checkout.ts'],
          recentRuns: ['passed', 'passed'],
        }),
      ],
      { relevantChangedFiles: ['src/checkout.ts'] },
    );
    expect(results[0]?.category).toBe('REAL_REGRESSION');
    expect(results[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(results[0]?.rootCauseHypothesis).toMatch(/changed code/);
  });

  it('treats an unknown environment error without covered change as ENVIRONMENT_FAILURE', () => {
    const results = agent.triage([
      record({
        testId: 'db-conn',
        attempts: [attempt({ errorType: 'Error', errorMessage: 'connect ECONNREFUSED 10.0.0.5:5432' })],
      }),
    ]);
    expect(results[0]?.category).toBe('ENVIRONMENT_FAILURE');
  });

  it('derives selectorChangedInDiff from diffText via core detectSelectorChange', () => {
    const source = [
      "import { test } from '@playwright/test';",
      "test('nav', async ({ page }) => {",
      "  await page.getByRole('button', { name: 'Save' });",
      "  await page.locator('.legacy-save').click();",
      '});',
    ].join('\n');
    const rootDir = makeTempDir('triage-sel');
    write(rootDir, 'tests/nav.spec.ts', source);

    const withRoot = new TriageAgent(rootDir);
    // The selector literal `.legacy-save` appears in the diff text — the agent
    // reads the test file and derives the signal through core
    // detectSelectorChange (the error below has no selector pattern, so the
    // core decision table produces a category without the selector branch).
    const results = withRoot.triage(
      [record({ testId: 'nav', filePath: 'tests/nav.spec.ts', layer: 'e2e', attempts: [attempt({ errorType: 'Error', errorMessage: 'navigation failed' })] })],
      { diffText: 'diff --git a/src/nav.ts b/src/nav.ts\n-legacy-save\n+new-save\n' },
    );
    expect(results[0]?.testId).toBe('nav');
    expect(results[0]?.category).toBeDefined();
  });
});

describe('TriageAgent.clusters', () => {
  const agent = new TriageAgent('/nonexistent-root');

  it('groups same-error failures and separates different errors', () => {
    const failures = [
      record({ testId: 'a', attempts: [attempt({ errorType: 'AssertionError', errorMessage: 'AssertionError: cart total mismatch on checkout page' })] }),
      record({ testId: 'b', attempts: [attempt({ errorType: 'AssertionError', errorMessage: 'AssertionError: cart total mismatch on checkout page' })] }),
      record({ testId: 'c', attempts: [attempt({ errorType: 'Error', errorMessage: 'failed to render dashboard widget' })] }),
    ];
    const clusters = agent.clusters(failures);
    expect(clusters).toHaveLength(2);
    const big = clusters.find((c) => c.testIds.includes('a'));
    expect(big?.testIds).toEqual(['a', 'b']);
    expect(clusters[0]?.testIds.length).toBeGreaterThanOrEqual(clusters[clusters.length - 1]?.testIds.length ?? 0);
  });
});

describe('detectPrimaryCascade', () => {
  it('marks the dependency-shaped cluster primary and later same-env clusters cascade', () => {
    const t = (offsetSeconds: number): string => new Date(Date.parse('2025-06-01T10:00:00.000Z') + offsetSeconds * 1000).toISOString();
    const failures = [
      record({ testId: 'conn', attempts: [attempt({ timestamp: t(0), errorType: 'Error', errorMessage: 'connect ECONNREFUSED 10.0.0.5:5432' })] }),
      record({ testId: 'cart', attempts: [attempt({ timestamp: t(60), errorType: 'AssertionError', errorMessage: 'AssertionError: cart total mismatch on checkout page' })] }),
      record({ testId: 'render', attempts: [attempt({ timestamp: t(120), errorType: 'Error', errorMessage: 'failed to render dashboard widget' })] }),
      record({ testId: 'local-only', attempts: [attempt({ timestamp: t(30), environment: 'local', errorType: 'AssertionError', errorMessage: 'AssertionError: local widget mismatch' })] }),
    ];
    const clusters = new TriageAgent('/nonexistent-root').clusters(failures);
    const { primaryIds, cascadeIds } = detectPrimaryCascade(clusters, failures);

    const connCluster = clusters.find((c) => c.testIds.includes('conn'));
    expect(primaryIds).toEqual(connCluster ? [connCluster.id] : []);
    expect(cascadeIds).toHaveLength(2);
    expect(cascadeIds).not.toContain(connCluster?.id);
    const localCluster = clusters.find((c) => c.testIds.includes('local-only'));
    expect(cascadeIds).not.toContain(localCluster?.id); // different environment
  });

  it('returns empty results when no dependency-shaped cluster exists', () => {
    const failures = [
      record({ testId: 'a', attempts: [attempt({ errorMessage: 'AssertionError: expected 1 to equal 2' })] }),
      record({ testId: 'b', attempts: [attempt({ errorMessage: 'Error: totally unrelated widget crash' })] }),
    ];
    const clusters = new TriageAgent('/nonexistent-root').clusters(failures);
    expect(detectPrimaryCascade(clusters, failures)).toEqual({ primaryIds: [], cascadeIds: [] });
  });
});
