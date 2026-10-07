import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HealingProposal } from '../types.js';
import { assertAuthorized } from '../policies.js';

/**
 * Healing application policy. HIGH-tier proposals that pass every golden-rule
 * check may be applied automatically; everything else is propose-only.
 * Application is conservative: the original file is preserved as
 * `<file>.pre-heal.bak` (golden rule 13: preserve evidence), and an audit
 * record is appended to the learning store by the caller.
 */

export interface ApplyResult {
  applied: boolean;
  reason: string;
  backupPath?: string;
}

export function canApply(proposal: HealingProposal): boolean {
  return proposal.tier === 'HIGH' && proposal.violations.length === 0;
}

/**
 * Apply a proposal to a file on disk. Reads current content, verifies the
 * `currentCode` fragment still exists (nothing drifted), backs up, then writes.
 */
export function applyProposal(proposal: HealingProposal, root: string, opts: { confirmRisk?: boolean } = {}): ApplyResult {
  if (!canApply(proposal)) {
    return { applied: false, reason: `tier ${proposal.tier} is propose-only (violations: ${proposal.violations.length || 'review required'})` };
  }
  assertAuthorized('heal.apply.high-tier', opts);

  const filePath = join(root, proposal.filePath);
  if (!existsSync(filePath)) {
    return { applied: false, reason: `target file missing: ${proposal.filePath}` };
  }
  const content = readFileSync(filePath, 'utf8');
  if (!content.includes(proposal.currentCode)) {
    return { applied: false, reason: 'source drifted — currentCode fragment no longer present; refusing blind patch' };
  }

  const backupPath = `${filePath}.pre-heal.bak`;
  const backupDir = dirname(backupPath);
  if (backupDir) mkdirSync(backupDir, { recursive: true });
  copyFileSync(filePath, backupPath);
  writeFileSync(filePath, content.replace(proposal.currentCode, proposal.proposedCode), 'utf8');

  return {
    applied: true,
    reason: `HIGH-tier heal applied with backup at ${proposal.filePath}.pre-heal.bak`,
    backupPath: `${proposal.filePath}.pre-heal.bak`,
  };
}

/** Deletion is never automatic (golden rule 7). This exists to classify intents. */
export function classifyDeletionRequest(evidenceCount: number, duplicateOf?: string): { allowed: boolean; reason: string } {
  if (duplicateOf && evidenceCount >= 3) {
    return { allowed: false, reason: `duplicate of ${duplicateOf} — recommend MERGE in a proposal; auto-delete requires human approval` };
  }
  return { allowed: false, reason: 'test deletion requires strong recorded evidence AND human approval (golden rule 7)' };
}
