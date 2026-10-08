import type { FlakeAssessment, FlakeInput, VerificationLabel } from '../types.js';

/**
 * Flake scoring — documented formula, deterministic.
 *
 *   score = 40×failRate + 25×retrySignal + 20×intermittency + 15×envSpread
 *
 *   failRate       fraction of failed outcomes in the window (0..1)
 *   retrySignal    min(1, retryCount / 5)                — needed retries to pass
 *   intermittency  alternating pass/fail pattern strength (0..1)
 *   envSpread      min(1, distinctFailingEnvs/3)*0.6 + min(1, distinctFailingBrowsers/3)*0.4
 *
 * Verdicts: <20 stable · <45 suspect · <70 flaky · ≥70 critical_flaky.
 * Every score lists the reasons that moved it.
 */

export function scoreFlake(input: FlakeInput): FlakeAssessment {
  const reasons: string[] = [];
  const n = input.outcomes.length;
  const fails = input.outcomes.filter((o) => o.status === 'failed').length;
  const failRate = n > 0 ? fails / n : 0;

  // Intermittency: count direction changes in the outcome sequence.
  let changes = 0;
  for (let i = 1; i < n; i++) {
    const prev = input.outcomes[i - 1];
    const cur = input.outcomes[i];
    if (prev && cur && prev.status !== cur.status) changes += 1;
  }
  const intermittency = n > 1 ? changes / (n - 1) : 0;

  const envSpread =
    Math.min(1, input.environments.length / 3) * 0.6 + Math.min(1, input.browsers.length / 3) * 0.4;

  const retrySignal = Math.min(1, input.retryCount / 5);

  const score = Math.round(
    40 * failRate + 25 * retrySignal + 20 * intermittency + 15 * envSpread,
  );

  if (failRate > 0) reasons.push(`${fails}/${n} outcomes failed in the window (${(failRate * 100).toFixed(0)}%)`);
  else reasons.push('no failures in the observed window');
  if (input.retryCount > 0) reasons.push(`required ${input.retryCount} retr${input.retryCount === 1 ? 'y' : 'ies'} historically`);
  if (intermittency > 0.3) reasons.push('alternating pass/fail pattern (intermittent)');
  if (input.environments.length > 1) reasons.push(`failed across ${input.environments.length} environments: ${input.environments.join(', ')}`);
  if (input.browsers.length > 1) reasons.push(`failed across ${input.browsers.length} browsers: ${input.browsers.join(', ')}`);
  if (envSpread < 0.2 && fails > 0) reasons.push('failures confined to one env/browser — possibly environment-specific');

  const verdict =
    score >= 70 ? 'critical_flaky' :
    score >= 45 ? 'flaky' :
    score >= 20 ? 'suspect' : 'stable';

  const label: VerificationLabel = n >= 5 ? 'OBSERVED' : 'INFERRED';

  return {
    testId: input.testId,
    score,
    verdict,
    reasons,
    failRate,
    label,
  };
}

/** Aggregate flake state for a suite from per-test histories. */
export function suiteFlakeHealth(assessments: FlakeAssessment[]): { score: number; critical: number; flaky: number } {
  if (assessments.length === 0) return { score: 100, critical: 0, flaky: 0 };
  const critical = assessments.filter((a) => a.verdict === 'critical_flaky').length;
  const flaky = assessments.filter((a) => a.verdict === 'flaky').length;
  const penalty = (critical * 12 + flaky * 5) / Math.max(1, Math.sqrt(assessments.length));
  return {
    score: Math.max(0, Math.round(100 - penalty * 10)),
    critical,
    flaky,
  };
}
