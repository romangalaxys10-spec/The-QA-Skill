import { createHash } from 'node:crypto';
import type { Evidence, HealingKind, HealingProposal, HealingTier, VerificationLabel } from '../types.js';

/**
 * Confidence-tiered self-healing.
 *
 * HIGH   — safe automatic patch: pure selector swaps where the new selector is
 *          observed in the DOM snapshot / source of truth, assertion untouched.
 * MEDIUM — propose patch + evidence: structural changes (locator strategy,
 *          data construction) that preserve asserted intent but need review.
 * LOW    — do not modify: anything touching assertion semantics, timeouts,
 *          skipping, or behavior expectations. Explain only.
 */

export interface HealCandidate {
  testId: string;
  filePath: string;
  kind: HealingKind;
  description: string;
  currentCode: string;
  proposedCode: string;
  /** DOM snapshot/source evidence containing the proposed selector, if any. */
  observedInTarget?: string;
  /** Free-text signals from triage. */
  signals: string[];
}

const HIGH_TIER_KINDS: ReadonlySet<HealingKind> = new Set(['selector']);

export function buildProposal(candidate: HealCandidate): HealingProposal {
  const checks: string[] = [];
  const violations: string[] = [];

  // Golden rule 1: never weaken an assertion.
  const assertionUnchanged = !changesAssertions(candidate.currentCode, candidate.proposedCode);
  if (assertionUnchanged) checks.push('rule-1: assertion expressions unchanged');
  else violations.push('rule-1: assertion expressions differ — weakening detected');

  // Golden rule 3: never fix with sleeps.
  const addsSleep = /waitForTimeout|setTimeout|sleep\s*\(/i.test(candidate.proposedCode) && !/waitForTimeout|setTimeout|sleep\s*\(/i.test(candidate.currentCode);
  if (!addsSleep) checks.push('rule-3: no new arbitrary sleeps introduced');
  else violations.push('rule-3: proposal introduces an arbitrary sleep');

  // Never turn a failure into a skip.
  const addsSkip = /\.(skip|only|todo)\s*\(/.test(candidate.proposedCode) && !/\.(skip|only|todo)\s*\(/.test(candidate.currentCode);
  if (!addsSkip) checks.push('no skip/only/todo introduced');
  else violations.push('proposal disables the test (skip/only/todo)');

  // Never raise timeouts as first response.
  const raisesTimeout = raisesTimeoutValue(candidate.currentCode, candidate.proposedCode);
  if (!raisesTimeout) checks.push('no timeout increase');
  else violations.push('proposal increases a timeout — forbidden as first response');

  // Evidence quality for selector healing.
  const selectorObserved = candidate.kind === 'selector' ? Boolean(candidate.observedInTarget) : true;
  if (candidate.kind === 'selector') {
    if (selectorObserved) checks.push('proposed selector observed in target DOM snapshot/source');
    else violations.push('proposed selector not observed in any target snapshot — would be guessing');
  }

  const evidence: Evidence[] = candidate.signals.map((s, i) => ({
    id: `ev-${createHash('sha256').update(`${candidate.testId}:${i}:${s}`).digest('hex').slice(0, 8)}`,
    kind: 'static_analysis',
    summary: s,
    collectedAt: new Date().toISOString(),
    label: 'OBSERVED' as VerificationLabel,
  }));

  if (candidate.observedInTarget) {
    evidence.push({
      id: `ev-${createHash('sha256').update(`${candidate.testId}:observed`).digest('hex').slice(0, 8)}`,
      kind: 'dom_snapshot',
      summary: 'proposed selector located in captured target state',
      collectedAt: new Date().toISOString(),
      label: 'OBSERVED',
    });
  }

  let tier: HealingTier;
  let confidence: number;
  if (violations.length === 0 && HIGH_TIER_KINDS.has(candidate.kind) && selectorObserved && assertionUnchanged) {
    tier = 'HIGH';
    confidence = 0.9;
  } else if (violations.length === 0) {
    tier = 'MEDIUM';
    confidence = 0.6;
  } else {
    tier = 'LOW';
    confidence = 0.2;
  }

  const id = `heal-${createHash('sha256').update(`${candidate.testId}|${candidate.currentCode}|${candidate.proposedCode}`).digest('hex').slice(0, 10)}`;

  return {
    id,
    testId: candidate.testId,
    filePath: candidate.filePath,
    kind: candidate.kind,
    description: candidate.description,
    currentCode: candidate.currentCode,
    proposedCode: candidate.proposedCode,
    tier,
    confidence,
    evidence,
    rationale: rationaleFor(tier, violations),
    policyChecks: checks,
    violations,
  };
}

function rationaleFor(tier: HealingTier, violations: string[]): string {
  if (tier === 'HIGH') {
    return 'HIGH tier: pure selector repair with observed evidence and untouched assertions — safe to apply automatically.';
  }
  if (tier === 'MEDIUM') {
    return 'MEDIUM tier: intent-preserving structural change — review the proposal against the evidence before applying.';
  }
  return `LOW tier: do not modify. Reasons: ${violations.join('; ')}. This proposal exists only to explain what would be required — human decision needed.`;
}

/** Compare assertion-relevant lines between current and proposed code. */
export function changesAssertions(current: string, proposed: string): boolean {
  const assertionRe = /^\s*(?:await\s+)?(?:expect|assert|should)[^;]*;?\s*$/;
  const extract = (src: string): string[] =>
    src.split('\n').map((l) => l.trim()).filter((l) => assertionRe.test(l));
  const a = extract(current);
  const b = extract(proposed);
  if (a.length !== b.length) return true;
  const same = a.every((line, i) => line === b[i]);
  return !same;
}

/** Detect timeout value increases (playwright timeout / testTimeout / setTimeout). */
export function raisesTimeoutValue(current: string, proposed: string): boolean {
  const re = /(?:timeout|TimeOut|testTimeout|setTimeout)\s*[(:=]\s*(\d{3,})/g;
  const values = (src: string): number[] => {
    const out: number[] = [];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      const v = parseInt(m[1] ?? '0', 10);
      if (v > 0) out.push(v);
    }
    return out;
  };
  const oldVals = values(current);
  const newVals = values(proposed);
  if (newVals.length !== oldVals.length) return newVals.some((v) => v > 10_000);
  // Any paired increase counts.
  for (let i = 0; i < oldVals.length; i++) {
    const oldV = oldVals[i];
    const newV = newVals[i];
    if (oldV !== undefined && newV !== undefined && newV > oldV) return true;
  }
  return false;
}

/** Generate selector candidates from a DOM snapshot for selector healing. */
export function selectorCandidatesFromSnapshot(snapshot: string, failedSelector: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (s: string): void => {
    if (s && s !== failedSelector && !seen.has(s)) {
      seen.add(s);
      candidates.push(s);
    }
  };
  const dataTestIds = [...snapshot.matchAll(/data-testid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1] ?? '');
  for (const id of dataTestIds.slice(0, 5)) push(`getByTestId('${id}')`);
  const roles = [...snapshot.matchAll(/<(button|link|heading|textbox|checkbox)\b[^>]*>/gi)].map((m) => (m[1] ?? '').toLowerCase());
  const roleMap: Record<string, string> = { link: 'link', heading: 'heading', textbox: 'textbox', checkbox: 'checkbox', button: 'button' };
  for (const role of [...new Set(roles)].slice(0, 5)) {
    const mapped = roleMap[role];
    if (mapped) push(`getByRole('${mapped}')`);
  }
  const labels = [...snapshot.matchAll(/(?:aria-label|alt)\s*=\s*["']([^"']{3,60})["']/g)].map((m) => m[1] ?? '');
  for (const label of labels.slice(0, 3)) push(`getByLabel('${label}')`);
  return candidates.slice(0, 8);
}
