/**
 * Ground-truth verification: claim → deterministic probes → VERIFIED /
 * REFUTED / UNKNOWN, with a persistent KNOWN_FALSE registry that bans
 * retrying refuted claims.
 */
export {
  verifyClaim,
  verifyClaimAsync,
  claimHash,
  normalizeClaim,
} from './engine.js';
export type { ClaimStatus, ClaimVerdict, VerifyOptions } from './engine.js';

export {
  runProbe,
  runProbeAsync,
} from './probes.js';
export type { ProbeSpec, ProbeStatus, ProbeOutcome } from './probes.js';

export { KnownFalseRegistry } from './known-false.js';
export type { KnownFalseEntry } from './known-false.js';
