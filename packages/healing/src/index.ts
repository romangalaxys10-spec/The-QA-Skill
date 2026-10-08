import {
  buildProposal as coreBuildProposal,
  canApply as coreCanApply,
  applyProposal as coreApplyProposal,
  selectorCandidatesFromSnapshot,
  changesAssertions,
  raisesTimeoutValue,
  LearningStore,
  type HealCandidate,
  type HealingProposal,
  type ApplyResult,
  type FailedTestRecord,
  type TriageResult,
} from '@the-qa-skill/core';

export {
  buildProposal as buildCoreProposal,
  canApply,
  applyProposal,
  selectorCandidatesFromSnapshot,
  changesAssertions,
  raisesTimeoutValue,
} from '@the-qa-skill/core';
export type { HealCandidate, HealingProposal, ApplyResult } from '@the-qa-skill/core';

/**
 * Suite-level healing orchestration.
 *
 * Turns a triaged failure set into a governed proposal set:
 *  - failures classified SELECTOR_FAILURE with a captured DOM snapshot are the
 *    only path to HIGH tier (auto-apply eligible);
 *  - everything else becomes MEDIUM (structural, intent-preserving) or LOW
 *    (explain-only) — proposing is always safe, applying is governed by core;
 *  - previously rejected healing targets (learning store) are demoted to LOW
 *    with the rejection recorded in the rationale — the platform never silently
 *    re-applies a rejected heal.
 */
export class HealingOrchestrator {
  constructor(
    private readonly root: string,
    private readonly opts: { learning?: LearningStore } = {},
  ) {}

  /** Build proposals for a triaged failure set. Read-only. */
  proposeForFailures(
    failures: FailedTestRecord[],
    triage: TriageResult[],
    inputs: Array<{ testId: string; candidate: Omit<HealCandidate, 'testId'> }>,
  ): HealingProposal[] {
    const triageByTest = new Map(triage.map((t) => [t.testId, t] as const));
    const proposals: HealingProposal[] = [];
    for (const input of inputs) {
      const candidate: HealCandidate = { ...input.candidate, testId: input.testId };
      const proposal = coreBuildProposal(candidate);
      const t = triageByTest.get(input.testId);
      const rejection = this.opts.learning?.rejectedHealingsFor(input.testId) ?? [];

      // Demote previously rejected targets — recorded, never silent.
      if (rejection.length > 0 && proposal.tier !== 'LOW') {
        proposal.tier = 'LOW';
        proposal.confidence = Math.min(proposal.confidence, 0.2);
        proposal.violations = [...proposal.violations, `previously rejected ${rejection.length} time(s) — human review required`];
        proposal.rationale = `LOW tier: this target was rejected before (${rejection.length} record(s) in the learning store); re-proposal requires human review.`;
      }

      // Only SELECTOR_FAILURE failures may reach HIGH tier; anything else is
      // capped at MEDIUM regardless of mechanical checks.
      if (t && t.category !== 'SELECTOR_FAILURE' && proposal.tier === 'HIGH') {
        proposal.tier = 'MEDIUM';
        proposal.confidence = Math.min(proposal.confidence, 0.6);
        proposal.rationale =
          'MEDIUM tier: mechanical checks passed but triage category is ' +
          `${t.category}, not SELECTOR_FAILURE — auto-apply is reserved for selector repairs.`;
      }
      proposals.push(proposal);
    }
    return proposals;
  }

  /** Apply a proposal under full governance (tier gate + backup + learning record). */
  apply(proposal: HealingProposal, opts: { confirmRisk?: boolean } = {}): ApplyResult {
    const result = coreApplyProposal(proposal, this.root, opts);
    this.opts.learning?.append({
      type: result.applied ? 'healing_applied' : 'healing_rejected',
      tags: ['healing', proposal.kind, `tier-${proposal.tier}`],
      payload: { testId: proposal.testId, proposalId: proposal.id, reason: result.reason },
      effect: result.applied
        ? `patched ${proposal.filePath} (backup at ${result.backupPath ?? 'n/a'}); VERIFY phase must re-run ${proposal.testId}`
        : `proposal ${proposal.id} not applied: ${result.reason}`,
    });
    return result;
  }
}

/** Convenience: extract a failed selector literal from a failure's error text. */
export function extractFailedSelector(record: FailedTestRecord): string | undefined {
  for (const attempt of record.attempts) {
    const text = `${attempt.errorMessage ?? ''} ${attempt.errorStack ?? ''}`;
    const m =
      text.match(/getBy(?:TestId|Role|Label|Text)\(\s*['"]([^'"]+)['"]/) ??
      text.match(/locator\(\s*['"]([^'"]+)['"]/) ??
      text.match(/waiting for (?:locator|selector)\s+([^\s]+)/i);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

/** Group proposals by tier for reporting. */
export function groupByTier(proposals: HealingProposal[]): Record<'HIGH' | 'MEDIUM' | 'LOW', HealingProposal[]> {
  const out: Record<'HIGH' | 'MEDIUM' | 'LOW', HealingProposal[]> = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const p of proposals) out[p.tier].push(p);
  return out;
}
