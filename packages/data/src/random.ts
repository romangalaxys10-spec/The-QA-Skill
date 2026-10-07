/**
 * @the-qa-skill/data — deterministic seeded randomness (mulberry32 + FNV-1a).
 *
 * Every consumer of test data in the platform draws from a SeededRandom so a
 * failing run can be reproduced bit-for-bit from its seed. Nothing here touches
 * Math.random() or Date.now() — determinism is the contract.
 */

/**
 * FNV-1a 32-bit hash of a string, returned as an unsigned 32-bit integer.
 * Used to map string seeds onto the numeric seed space of mulberry32.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Create a mulberry32 generator — a tiny, fast, well-distributed 32-bit PRNG.
 * Returned function yields successive unsigned 32-bit values scaled into
 * [0, 1). Same seed → same sequence on every platform (pure integer math).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic seeded PRNG. String seeds are hashed with FNV-1a to uint32.
 * Two instances constructed with the same seed always produce identical
 * sequences — that is the reproducibility contract of the data package.
 */
export class SeededRandom {
  private readonly generator: () => number;

  /** The normalized numeric seed actually in use (hashed when given a string). */
  public readonly seed: number;

  constructor(seed: number | string) {
    const numeric = typeof seed === 'string' ? fnv1a32(seed) : seed >>> 0;
    this.seed = numeric;
    this.generator = mulberry32(numeric);
  }

  /** Next float in [0, 1). */
  next(): number {
    return this.generator();
  }

  /** Next raw unsigned 32-bit integer. */
  nextUint32(): number {
    // next() is uint32 / 2^32 exactly, so scaling back recovers the integer.
    return Math.floor(this.next() * 0x100000000) >>> 0;
  }

  /**
   * Next integer in [min, max], inclusive on both ends.
   * Throws when arguments are not integers or min > max.
   */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new Error(`int() requires integer bounds, got min=${min}, max=${max}`);
    }
    if (min > max) {
      throw new Error(`int() requires min <= max, got min=${min}, max=${max}`);
    }
    const span = max - min + 1;
    return min + Math.floor(this.next() * span);
  }

  /**
   * Pick a uniform random element. Throws on an empty array — silent
   * undefined returns from factories hide data bugs.
   */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) {
      throw new Error('pick() called on an empty array');
    }
    const index = this.int(0, arr.length - 1);
    const value = arr[index];
    if (value === undefined) {
      // Unreachable (index is within bounds); guards the type honestly.
      throw new Error(`pick() index ${index} out of bounds for length ${arr.length}`);
    }
    return value;
  }

  /**
   * Fisher–Yates shuffle. Returns a new array; the input is never mutated,
   * and the multiset of elements is preserved exactly.
   */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmpI = out[i];
      const tmpJ = out[j];
      if (tmpI === undefined || tmpJ === undefined) {
        // Unreachable for a dense array; guards noUncheckedIndexedAccess honestly.
        throw new Error(`shuffle() encountered a hole at index ${i}/${j}`);
      }
      out[i] = tmpJ;
      out[j] = tmpI;
    }
    return out;
  }

  /**
   * Bernoulli trial: true with probability `p` (default 0.5).
   * p = 0 always false, p = 1 always true.
   */
  bool(p = 0.5): boolean {
    if (p < 0 || p > 1) {
      throw new Error(`bool() requires 0 <= p <= 1, got ${p}`);
    }
    return this.next() < p;
  }

  /**
   * UUID v4-shaped identifier derived purely from the PRNG (no crypto, no
   * clock): version nibble fixed to '4', variant nibble constrained to
   * 8/9/a/b. Deterministic given the seed; NOT cryptographically random —
   * never use where unguessability matters.
   */
  uuid(): string {
    const hex = (): string => this.nextUint32().toString(16).padStart(8, '0');
    const h = hex() + hex() + hex() + hex(); // 128 bits
    const variantChar = '89ab'.charAt(parseInt(h.charAt(16), 16) % 4);
    return [
      h.slice(0, 8),
      h.slice(8, 12),
      `4${h.slice(13, 16)}`,
      `${variantChar}${h.slice(17, 20)}`,
      h.slice(20, 32),
    ].join('-');
  }
}
