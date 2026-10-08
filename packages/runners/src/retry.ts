import type { FailedTestRecord, FailureCategory } from '@the-qa-skill/core';

/**
 * Retry policy — read this before touching the code.
 *
 * Retries exist for FLAKE DIAGNOSTICS, never to hide regressions.
 * (Golden rule 2: a retry that turns a red run green is a lie told to the
 * release gate.) Therefore:
 *
 * - Failures classified REAL_REGRESSION get ZERO retries — the code is broken;
 *   running it again proves nothing and only burns the rerun budget.
 * - Everything else gets at most `maxRetries` minus the retries already spent
 *   for that test in this record. Exhausted means zero.
 *
 * The classification lookup is injected (a map of testId → FailureCategory) so
 * this module stays deterministic and cheap — the heavy triage classifier is
 * upstream and its results are simply consulted here.
 */
export type ClassificationLookup =
  | ReadonlyMap<string, FailureCategory>
  | Readonly<Record<string, FailureCategory>>
  | undefined;

/** Human-readable statement of the policy, embedded in reports and docs. */
export const RETRY_POLICY_NOTE =
  'Retries exist for flake diagnostics, never to hide regressions (golden rule 2): ' +
  'REAL_REGRESSION failures are never retried, and every retry is recorded as an attempt.';

/** How many MORE attempts a failed test may receive under the retry policy. */
export class RetryManager {
  constructor(private readonly maxRetries: number) {}

  /** Configured ceiling (useful for reports: "retries: 1 per test"). */
  get limit(): number {
    return this.maxRetries;
  }

  /**
   * Plan retries for one failed test.
   *
   * @param record the failed test with its attempt history (attempts include
   *   the failed attempt itself).
   * @param classifications optional testId → FailureCategory map from triage.
   * @returns number of additional attempts allowed (0..maxRetries).
   */
  plan(record: FailedTestRecord, classifications?: ClassificationLookup): number {
    if (this.maxRetries <= 0) return 0;
    const category = this.lookup(record.testId, classifications);
    if (category === 'REAL_REGRESSION') return 0;
    const attemptsUsed = Math.max(0, record.attempts.length - 1);
    return Math.max(0, this.maxRetries - attemptsUsed);
  }

  private lookup(testId: string, classifications: ClassificationLookup): FailureCategory | undefined {
    if (!classifications) return undefined;
    if (classifications instanceof Map) return classifications.get(testId);
    const asRecord = classifications as Readonly<Record<string, FailureCategory>>;
    return asRecord[testId];
  }
}
