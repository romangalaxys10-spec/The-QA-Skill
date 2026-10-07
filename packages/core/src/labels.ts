import type { Evidence, VerificationLabel } from './types.js';

/**
 * Verification label semantics:
 *  NOT_VERIFIED — a claim exists but no evidence was collected.
 *  NOT_RUN      — work was planned but never executed (blocked, skipped, dry-run).
 *  INFERRED     — conclusion produced by reasoning over evidence; not directly observed.
 *  OBSERVED     — directly measured from an execution or artifact.
 *  CONFIRMED    — observed and independently re-verified (e.g. reproduced on retry).
 */

export const VERIFICATION_LABELS: readonly VerificationLabel[] = [
  'NOT_VERIFIED',
  'NOT_RUN',
  'INFERRED',
  'OBSERVED',
  'CONFIRMED',
] as const;

/** Strength ordering — higher wins. */
const STRENGTH: Record<VerificationLabel, number> = {
  NOT_VERIFIED: 0,
  NOT_RUN: 1,
  INFERRED: 2,
  OBSERVED: 3,
  CONFIRMED: 4,
};

/** Combine evidence labels into the strongest honest label for a claim. */
export function strongestLabel(labels: VerificationLabel[]): VerificationLabel {
  if (labels.length === 0) return 'NOT_VERIFIED';
  let best: VerificationLabel = 'NOT_VERIFIED';
  for (const l of labels) {
    if (STRENGTH[l] > STRENGTH[best]) best = l;
  }
  return best;
}

/** Weakest label across a set — used for composite claims (a chain is as weak as its weakest link). */
export function weakestLabel(labels: VerificationLabel[]): VerificationLabel {
  if (labels.length === 0) return 'NOT_VERIFIED';
  let worst: VerificationLabel = 'CONFIRMED';
  for (const l of labels) {
    if (STRENGTH[l] < STRENGTH[worst]) worst = l;
  }
  return worst;
}

/** CONFIRMED requires at least one OBSERVED-quality or better evidence item. */
export function canConfirm(evidence: Evidence[]): boolean {
  return evidence.some((e) => STRENGTH[e.label] >= STRENGTH.OBSERVED);
}

export function describeLabel(label: VerificationLabel): string {
  switch (label) {
    case 'NOT_VERIFIED':
      return 'No evidence collected — treat as unproven';
    case 'NOT_RUN':
      return 'Planned but not executed';
    case 'INFERRED':
      return 'Derived from evidence by reasoning, not directly observed';
    case 'OBSERVED':
      return 'Directly measured during execution';
    case 'CONFIRMED':
      return 'Observed and independently re-verified';
  }
}
