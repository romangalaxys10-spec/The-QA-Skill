import type { ReleaseGateInput, ReleaseGateResult, VerificationLabel } from '@the-qa-skill/core';

/**
 * Deterministic release gate. Same input → same verdict, every time.
 *
 * Decision table (evaluated top-down; BLOCKED always wins):
 *
 * 1. EMPTY INPUT (no assessments, no triage, no flakes, no failures, no
 *    counts, no coverage) → **UNKNOWN**. A gate with no data is never PASS —
 *    the honest default is "we don't know" (NOT_VERIFIED).
 * 2. failedRealRegressions > 0 and blockOnRealRegression (default true)
 *    → **BLOCKED**, blocking findings name the observed regressions.
 * 3. Any triage result with category REAL_REGRESSION and confidence ≥ 0.9
 *    → **BLOCKED** with the testId in blocking findings.
 * 4. Otherwise, warnings accumulate:
 *    - evidenceComplete is false → PASS would be downgraded to
 *      PASS_WITH_WARNINGS (unverified claims must not read as clean PASS);
 *    - openUnknownCategories > maxUnknownTriage (default 2) → warning;
 *    - criticalFlakeCount > maxCriticalFlakes (default 0) → warning;
 *    - coverage provided and weightedCoverage < minWeightedCoverage
 *      (default 60) → warning;
 *    - failedRealRegressions > 0 with blocking disabled by policy → warning
 *      (the policy choice is recorded, never silent).
 * 5. Warnings present → **PASS_WITH_WARNINGS**; none → **PASS**.
 *
 * FAIL is deliberately NOT produced by this gate: it is reserved for
 * post-human-review overrides downstream. The gate never invents one.
 */

export interface ReleaseGateOptions {
  /** Block the release when observed real regressions failed. Default true. */
  blockOnRealRegression?: boolean;
  /** Max triage results allowed to remain UNKNOWN before warning. Default 2. */
  maxUnknownTriage?: number;
  /** Max critical flaky tests tolerated. Default 0. */
  maxCriticalFlakes?: number;
  /** Minimum risk-weighted coverage percent. Default 60. */
  minWeightedCoverage?: number;
}

const DEFAULTS = {
  blockOnRealRegression: true,
  maxUnknownTriage: 2,
  maxCriticalFlakes: 0,
  minWeightedCoverage: 60,
};

/** Minimum triage confidence for a REAL_REGRESSION classification to block. */
const REAL_REGRESSION_CONFIDENCE = 0.9;

/** Compute the release verdict. Deterministic and explainable — see module doc. */
export function computeReleaseGate(input: ReleaseGateInput, opts: ReleaseGateOptions = {}): ReleaseGateResult {
  const o = { ...DEFAULTS, ...opts };
  const reasons: string[] = [];
  const blockingFindings: string[] = [];
  const warnings: string[] = [];

  // 1. Empty input → UNKNOWN. Never PASS on no data.
  const isEmpty =
    input.riskAssessments.length === 0 &&
    input.triageResults.length === 0 &&
    input.flakeAssessments.length === 0 &&
    !input.coverage &&
    input.failedRealRegressions === 0 &&
    input.openUnknownCategories === 0 &&
    input.criticalFlakeCount === 0;
  if (isEmpty) {
    return {
      verdict: 'UNKNOWN',
      reasons: [
        'no data: no risk assessments, no triage results, no flake data, no failures, no coverage — refusing to invent a verdict (NOT_VERIFIED)',
      ],
      blockingFindings: [],
      warnings: [],
      label: 'NOT_VERIFIED',
    };
  }

  reasons.push(
    `gate inputs: failedRealRegressions=${input.failedRealRegressions}, openUnknownCategories=${input.openUnknownCategories}, criticalFlakeCount=${input.criticalFlakeCount}, evidenceComplete=${String(input.evidenceComplete)} (OBSERVED)`,
  );

  // 2. Observed real regressions.
  if (input.failedRealRegressions > 0) {
    if (o.blockOnRealRegression) {
      blockingFindings.push(
        `${input.failedRealRegressions} real regression failure(s) observed in environment '${input.environment}'`,
      );
      reasons.push(`BLOCKED: ${input.failedRealRegressions} real regression(s) failed and blockOnRealRegression=true`);
    } else {
      warnings.push(
        `${input.failedRealRegressions} real regression(s) failed but blockOnRealRegression=false — policy recorded, not hidden`,
      );
      reasons.push('real regressions failed but blocking is disabled by policy — downgraded to warning');
    }
  }

  // 3. High-confidence triaged REAL_REGRESSIONs block regardless of counts.
  const highConfidenceRegressions = input.triageResults.filter(
    (t) => t.category === 'REAL_REGRESSION' && t.confidence >= REAL_REGRESSION_CONFIDENCE,
  );
  for (const t of highConfidenceRegressions) {
    blockingFindings.push(`REAL_REGRESSION triaged for ${t.testId} (confidence ${t.confidence.toFixed(2)}, ${t.label})`);
  }
  if (highConfidenceRegressions.length > 0) {
    reasons.push(
      `BLOCKED: ${highConfidenceRegressions.length} triage result(s) classified REAL_REGRESSION with confidence >= ${REAL_REGRESSION_CONFIDENCE}`,
    );
  }

  // 4. Warnings.
  if (!input.evidenceComplete) {
    warnings.push('evidence incomplete — unverified claims force PASS downgrades to PASS_WITH_WARNINGS');
    reasons.push('evidenceComplete=false: any PASS would be downgraded to PASS_WITH_WARNINGS');
  }
  if (input.openUnknownCategories > o.maxUnknownTriage) {
    warnings.push(
      `${input.openUnknownCategories} unclassified failures exceed maxUnknownTriage=${o.maxUnknownTriage} — triage backlog required`,
    );
    reasons.push(`openUnknownCategories (${input.openUnknownCategories}) > maxUnknownTriage (${o.maxUnknownTriage})`);
  }
  if (input.criticalFlakeCount > o.maxCriticalFlakes) {
    warnings.push(
      `${input.criticalFlakeCount} critical flaky test(s) exceed maxCriticalFlakes=${o.maxCriticalFlakes} — flake repair required`,
    );
    reasons.push(`criticalFlakeCount (${input.criticalFlakeCount}) > maxCriticalFlakes (${o.maxCriticalFlakes})`);
  }
  if (input.coverage && input.coverage.weightedCoverage < o.minWeightedCoverage) {
    warnings.push(
      `risk-weighted coverage ${input.coverage.weightedCoverage.toFixed(1)}% is below minWeightedCoverage=${o.minWeightedCoverage}`,
    );
    reasons.push(
      `weightedCoverage (${input.coverage.weightedCoverage.toFixed(1)}) < minWeightedCoverage (${o.minWeightedCoverage})`,
    );
  }

  // 5. Final verdict.
  let verdict: ReleaseGateResult['verdict'];
  if (blockingFindings.length > 0) {
    verdict = 'BLOCKED';
  } else if (warnings.length > 0) {
    verdict = 'PASS_WITH_WARNINGS';
  } else {
    verdict = 'PASS';
    reasons.push('no blocking findings and no warnings — all evaluated gates passed');
  }

  return { verdict, reasons, blockingFindings, warnings, label: gateLabel(input, verdict) };
}

/**
 * The gate's own verification label, derived honestly:
 * observed failures/flakes → OBSERVED; only inferred inputs → INFERRED;
 * the empty-input UNKNOWN → NOT_VERIFIED (returned early above).
 */
function gateLabel(input: ReleaseGateInput, verdict: ReleaseGateResult['verdict']): VerificationLabel {
  if (verdict === 'UNKNOWN') return 'NOT_VERIFIED';
  if (input.failedRealRegressions > 0 || input.flakeAssessments.length > 0) return 'OBSERVED';
  if (input.triageResults.length > 0 || input.riskAssessments.length > 0) return 'INFERRED';
  return 'OBSERVED';
}
