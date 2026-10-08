import { SeededRandom } from './random.js';

/**
 * @the-qa-skill/data — deterministic unique identities for test runs.
 *
 * `uniqueIdentity` derives email / username / orderRef from a seeded PRNG plus
 * a per-instance sequence counter, so identities are:
 *  - reproducible (same seed → same identities, in the same order),
 *  - collision-free within a seeded session (the counter guarantees the
 *    `user-<seq>` part never repeats for a given SeededRandom instance).
 */

/** Unambiguous lowercase alphabet for slugs (no 0/O/1/I/L look-alikes). */
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Shared default PRNG for `slug()` calls that do not pass one explicitly. */
const DEFAULT_SLUG_RANDOM = new SeededRandom('the-qa-skill-data');

/** Per-PRNG identity sequence counters — uniqueIdentity is session-scoped. */
const identityCounters = new WeakMap<SeededRandom, number>();

/** A deterministic test identity triple. */
export interface UniqueIdentity {
  email: string;
  username: string;
  orderRef: string;
}

/**
 * Generate the next identity for this PRNG session. Each call advances an
 * internal per-instance counter, so emails never collide within a session
 * (e.g. `user-1@example.test`, `user-2@example.test`, ...). Same seed → same
 * sequence across instances; that is the determinism contract, not a bug.
 */
export function uniqueIdentity(rnd: SeededRandom, opts?: { domain?: string }): UniqueIdentity {
  const seq = (identityCounters.get(rnd) ?? 0) + 1;
  identityCounters.set(rnd, seq);
  const domain = opts?.domain ?? 'example.test';
  return {
    email: `user-${seq}@${domain}`,
    username: `user-${seq}-${slug(6, rnd)}`,
    orderRef: `ORD-${String(seq).padStart(4, '0')}-${slug(8, rnd).toUpperCase()}`,
  };
}

/**
 * Random lowercase alphanumeric slug of exactly `len` characters drawn from an
 * unambiguous alphabet. When `rnd` is omitted, a shared deterministic PRNG is
 * used (still reproducible, but not tied to your session seed — prefer passing
 * the session's SeededRandom).
 */
export function slug(len: number, rnd: SeededRandom = DEFAULT_SLUG_RANDOM): string {
  if (!Number.isInteger(len) || len < 1) {
    throw new Error(`slug() requires a positive integer length, got ${len}`);
  }
  let out = '';
  for (let i = 0; i < len; i++) {
    out += SLUG_ALPHABET.charAt(rnd.int(0, SLUG_ALPHABET.length - 1));
  }
  return out;
}
