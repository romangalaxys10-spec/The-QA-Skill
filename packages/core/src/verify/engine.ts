import { createHash } from 'node:crypto';
import type { VerificationLabel } from '../types.js';
import { runProbe, runProbeAsync } from './probes.js';
import type { ProbeOutcome, ProbeSpec } from './probes.js';

/**
 * Ground-truth verification engine — the honest core of the platform.
 *
 * A claim is only ever VERIFIED when deterministic probes pass, and only
 * REFUTED when a probe fails cleanly. Probe ERRORS produce UNKNOWN — an
 * unverifiable claim is never silently treated as either true or false.
 * Refuted claims are recorded in the KNOWN_FALSE registry so agents (and the
 * xRouteLM harness) are blocked from retrying the same refuted claim.
 */

export type ClaimStatus = 'VERIFIED' | 'REFUTED' | 'UNKNOWN';

export interface ClaimVerdict {
  claim: string;
  status: ClaimStatus;
  /** Verification label for the envelope/report layer. */
  label: VerificationLabel;
  probes: ProbeOutcome[];
  /** Machine-readable explanation surfaced in reports and the learning store. */
  explanation: string;
  /** Independent re-execution result when `repeat` was requested. */
  repeat?: {
    status: ClaimStatus;
    probes: ProbeOutcome[];
  };
}

/** Normalize a claim string for registry hashing (stable across trivial edits). */
export function normalizeClaim(claim: string): string {
  return claim.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function claimHash(claim: string): string {
  return createHash('sha256').update(normalizeClaim(claim)).digest('hex').slice(0, 16);
}

export interface VerifyOptions {
  cwd: string;
  /**
   * Run every probe twice and compare. Two agreeing passes upgrade the label
   * to CONFIRMED; disagreement degrades to UNKNOWN with an explanation.
   */
  repeat?: boolean;
  /** Probe timeout override for cmd/http probes (ms). */
  timeoutMs?: number;
}

function combine(probes: ProbeOutcome[]): ClaimStatus {
  if (probes.length === 0) return 'UNKNOWN';
  if (probes.some((p) => p.status === 'FAIL')) return 'REFUTED';
  if (probes.some((p) => p.status === 'ERROR')) return 'UNKNOWN';
  return 'VERIFIED';
}

function labelFor(status: ClaimStatus, confirmed: boolean): VerificationLabel {
  if (status === 'VERIFIED') return confirmed ? 'CONFIRMED' : 'OBSERVED';
  if (status === 'REFUTED') return 'OBSERVED'; // the refutation itself was observed
  return 'NOT_VERIFIED';
}

function explain(status: ClaimStatus, probes: ProbeOutcome[]): string {
  const failed = probes.filter((p) => p.status === 'FAIL');
  const errored = probes.filter((p) => p.status === 'ERROR');
  if (status === 'VERIFIED') return `all ${probes.length} probe(s) passed`;
  if (status === 'REFUTED') {
    const first = failed[0];
    return `refuted by ${first?.spec.kind}: ${first?.observation ?? 'probe failed'}`;
  }
  if (errored.length > 0) {
    const first = errored[0];
    return `could not verify — ${first?.spec.kind} could not run: ${first?.error ?? 'probe error'}`;
  }
  return 'no probes specified — nothing was checked';
}

/** Verify one claim against its probe list (sync probes). */
export function verifyClaim(claim: string, probes: ProbeSpec[], opts: VerifyOptions): ClaimVerdict {
  const outcomes = probes.map((p) => runProbe(p, opts.cwd));
  const status = combine(outcomes);

  let repeat: ClaimVerdict['repeat'];
  let confirmed = false;
  if (opts.repeat === true && status === 'VERIFIED') {
    const again = probes.map((p) => runProbe(p, opts.cwd));
    const status2 = combine(again);
    repeat = { status: status2, probes: again };
    confirmed = status2 === 'VERIFIED';
    if (status2 !== 'VERIFIED') {
      const verdict: ClaimVerdict = {
        claim,
        status: 'UNKNOWN',
        label: 'NOT_VERIFIED',
        probes: outcomes,
        explanation: 'probe runs disagreed between repetitions — result is unstable',
        repeat,
      };
      return verdict;
    }
  }

  return {
    claim,
    status,
    label: labelFor(status, confirmed),
    probes: outcomes,
    explanation: explain(status, outcomes),
    ...(repeat !== undefined ? { repeat } : {}),
  };
}

/** Async variant — required when any probe is `http_status`. */
export async function verifyClaimAsync(claim: string, probes: ProbeSpec[], opts: VerifyOptions): Promise<ClaimVerdict> {
  const outcomes = await Promise.all(probes.map((p) => runProbeAsync(p, opts.cwd)));
  const status = combine(outcomes);

  let repeat: ClaimVerdict['repeat'];
  let confirmed = false;
  if (opts.repeat === true && status === 'VERIFIED') {
    const again = await Promise.all(probes.map((p) => runProbeAsync(p, opts.cwd)));
    const status2 = combine(again);
    repeat = { status: status2, probes: again };
    confirmed = status2 === 'VERIFIED';
    if (status2 !== 'VERIFIED') {
      return {
        claim,
        status: 'UNKNOWN',
        label: 'NOT_VERIFIED',
        probes: outcomes,
        explanation: 'probe runs disagreed between repetitions — result is unstable',
        repeat,
      };
    }
  }

  return {
    claim,
    status,
    label: labelFor(status, confirmed),
    probes: outcomes,
    explanation: explain(status, outcomes),
    ...(repeat !== undefined ? { repeat } : {}),
  };
}
