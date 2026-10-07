import { applyProposal, buildProposal } from '@the-qa-skill/core';
import type { ApplyResult, HealCandidate, HealingProposal, LearningStore } from '@the-qa-skill/core';

/**
 * HealingAgent — propose/apply self-healing under the golden rules.
 *
 * `propose()` is a thin, fully-delegating wrapper over the core tier engine
 * (HIGH = pure selector repair observed in a DOM snapshot with untouched
 * assertions; MEDIUM = intent-preserving structural change; LOW = explain
 * only). `apply()` delegates to the core apply policy (backup at
 * `<file>.pre-heal.bak`, source-drift refusal, HIGH-tier + zero violations
 * only) and — when a learning store is present — records the outcome as a
 * 'healing_applied' or 'healing_rejected' record with an explicit effect
 * string, so the learning loop can see every healing decision.
 */
export class HealingAgent {
  constructor(
    private readonly root: string,
    opts: { learning?: LearningStore; confirmRisk?: boolean } = {},
  ) {
    this.learning = opts.learning;
    this.defaultConfirmRisk = opts.confirmRisk ?? false;
  }

  /** Optional learning store — healing decisions are recorded when present. */
  public readonly learning?: LearningStore;

  /** Default confirmation posture for HIGH-risk applies (overridable per call). */
  public readonly defaultConfirmRisk: boolean;

  /** Build a healing proposal through the core tier engine. */
  propose(candidate: HealCandidate): HealingProposal {
    return buildProposal(candidate);
  }

  /**
   * Apply a proposal via the core policy and record the outcome in the
   * learning store when present. Never throws for policy rejections — the
   * ApplyResult carries the reason.
   */
  apply(proposal: HealingProposal, opts: { confirmRisk?: boolean } = {}): ApplyResult {
    const result = applyProposal(proposal, this.root, { confirmRisk: opts.confirmRisk ?? this.defaultConfirmRisk });
    this.learning?.append({
      type: result.applied ? 'healing_applied' : 'healing_rejected',
      tags: ['healing', proposal.kind, proposal.tier.toLowerCase()],
      payload: {
        testId: proposal.testId,
        proposalId: proposal.id,
        kind: proposal.kind,
        tier: proposal.tier,
        reason: result.reason,
      },
      effect: result.applied
        ? `patched ${proposal.filePath} for ${proposal.testId} (${proposal.kind}, tier ${proposal.tier}); backup at ${result.backupPath ?? 'n/a'}`
        : `proposal ${proposal.id} for ${proposal.testId} was NOT applied: ${result.reason}`,
    });
    return result;
  }
}
