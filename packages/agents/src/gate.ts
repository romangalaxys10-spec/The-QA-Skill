import type { ReleaseGateInput, ReleaseGateResult, ReleaseVerdict } from '@the-qa-skill/core';

/**
 * Local release-gate computation for the agents package.
 *
 * The canonical gate lives in `@the-qa-skill/reporting`, which this package
 * must NOT import (parallel build; agents depend on core only). This local
 * implementation follows the same documented rules so the orchestrator can
 * gate pipelines without a cross-package dependency:
 *
 *   1. No inputs at all (nothing assessed, nothing executed) → UNKNOWN.
 *   2. real regressions > 0                               → BLOCKED.
 *   3. Nothing executed AND nothing triaged (no execution evidence) → UNKNOWN.
 *   4. unknowns > 2        → warning.
 *   5. critical flakes > 0 → warning.
 *   6. coverage < 60       → warning.
 *   7. evidenceComplete false, or any warning → downgrades PASS to PASS_WITH_WARNINGS.
 *
 * The gate label is honest about its nature: OBSERVED only when the caller
 * attests the evidence set is complete, otherwise INFERRED (UNKNOWN verdicts
 * carry NOT_VERIFIED — an unverifiable gate verifies nothing).
 */
export function computeGate(input: ReleaseGateInput): ReleaseGateResult {
  const warnings: string[] = [];
  const blockingFindings: string[] = [];
  const reasons: string[] = [];

  const hasAnyInput =
    input.riskAssessments.length > 0 ||
    input.triageResults.length > 0 ||
    input.flakeAssessments.length > 0 ||
    input.coverage !== undefined ||
    input.failedRealRegressions > 0 ||
    input.openUnknownCategories > 0 ||
    input.criticalFlakeCount > 0;

  if (!hasAnyInput) {
    return {
      verdict: 'UNKNOWN',
      reasons: ['no gate inputs provided — nothing has been assessed, executed, or triaged'],
      blockingFindings: [],
      warnings: [],
      label: 'NOT_VERIFIED',
    };
  }

  // Rule 2: a real regression always blocks (qualityGates.blockOnRealRegression).
  if (input.failedRealRegressions > 0) {
    blockingFindings.push(
      `${input.failedRealRegressions} REAL_REGRESSION triage result(s) — real regressions block release`,
    );
  }

  // Rule 4-6: warnings.
  if (input.openUnknownCategories > 2) {
    warnings.push(
      `${input.openUnknownCategories} UNKNOWN triage results exceed the open-unknown budget of 2`,
    );
  }
  if (input.criticalFlakeCount > 0) {
    warnings.push(`${input.criticalFlakeCount} critical flaky test(s) — flake health warning`);
  }
  if (input.coverage && input.coverage.weightedCoverage < 60) {
    warnings.push(
      `weighted coverage ${Math.round(input.coverage.weightedCoverage)}% is below the 60% gate minimum`,
    );
  }

  // Rule 3: nothing executed and nothing triaged — an unverifiable gate.
  const noExecutionEvidence = !input.evidenceComplete && input.triageResults.length === 0;

  let verdict: ReleaseVerdict;
  if (blockingFindings.length > 0) {
    verdict = 'BLOCKED';
  } else if (noExecutionEvidence) {
    verdict = 'UNKNOWN';
    reasons.push('no execution evidence: nothing was run and nothing was triaged, so the gate cannot be verified');
  } else if (warnings.length > 0 || !input.evidenceComplete) {
    verdict = 'PASS_WITH_WARNINGS';
    if (!input.evidenceComplete) {
      warnings.push('evidence set is incomplete — PASS downgraded to PASS_WITH_WARNINGS');
    }
  } else {
    verdict = 'PASS';
  }

  if (input.failedRealRegressions > 0) reasons.push(...blockingFindings);
  reasons.push(...warnings);
  if (verdict === 'PASS') reasons.push('all gate checks passed with complete evidence');
  if (verdict === 'UNKNOWN' && blockingFindings.length === 0) {
    reasons.push('gate is UNKNOWN — resolve the missing evidence and re-run VERIFY');
  }

  const label: ReleaseGateResult['label'] = verdict === 'UNKNOWN' ? 'NOT_VERIFIED' : input.evidenceComplete ? 'OBSERVED' : 'INFERRED';

  return { verdict, reasons, blockingFindings, warnings, label };
}
