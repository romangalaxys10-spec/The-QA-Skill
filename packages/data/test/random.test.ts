import { describe, expect, it } from 'vitest';

import { SeededRandom, fnv1a32 } from '../src/index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('SeededRandom — determinism', () => {
  it('produces identical sequences across two instances with the same string seed', () => {
    const a = new SeededRandom('checkout-suite');
    const b = new SeededRandom('checkout-suite');
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces identical sequences for equal numeric seeds', () => {
    const a = new SeededRandom(42);
    const b = new SeededRandom(42);
    expect(Array.from({ length: 20 }, () => a.int(0, 1000))).toEqual(Array.from({ length: 20 }, () => b.int(0, 1000)));
  });

  it('diverges for different seeds', () => {
    const a = new SeededRandom('seed-a');
    const b = new SeededRandom('seed-b');
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('hashes string seeds via FNV-1a to a stable uint32', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
    expect(Number.isInteger(fnv1a32('x'))).toBe(true);
    expect(fnv1a32('x')).toBeGreaterThanOrEqual(0);
    expect(fnv1a32('x')).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('SeededRandom — primitives', () => {
  it('next() stays within [0, 1)', () => {
    const rnd = new SeededRandom(7);
    for (let i = 0; i < 1000; i++) {
      const v = rnd.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int() is inclusive on both ends and bounded', () => {
    const rnd = new SeededRandom(9);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const v = rnd.int(1, 3);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(3);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  it('int() rejects bad bounds', () => {
    const rnd = new SeededRandom(1);
    expect(() => rnd.int(5, 1)).toThrow(/min <= max/);
    expect(() => rnd.int(0.5, 3)).toThrow(/integer bounds/);
  });

  it('pick() throws on empty arrays and draws only present elements', () => {
    const rnd = new SeededRandom(11);
    expect(() => rnd.pick([])).toThrow(/empty/);
    const pool = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 50; i++) {
      expect(pool).toContain(rnd.pick(pool));
    }
  });

  it('shuffle() returns a permuted copy without mutating the input', () => {
    const rnd = new SeededRandom(13);
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const snapshot = [...input];
    const out = rnd.shuffle(input);
    expect(input).toEqual(snapshot);
    expect(out).not.toBe(input);
    expect([...out].sort((a, b) => a - b)).toEqual(snapshot);
    expect(out).not.toEqual(snapshot); // permutation actually happened for this seed
  });

  it('bool() honors the extremes and stays within [0,1] for mid p', () => {
    const rnd = new SeededRandom(17);
    expect(rnd.bool(0)).toBe(false);
    expect(rnd.bool(1)).toBe(true);
    expect(() => rnd.bool(1.5)).toThrow(/0 <= p <= 1/);
    for (let i = 0; i < 100; i++) expect(typeof rnd.bool()).toBe('boolean');
  });

  it('uuid() is v4-shaped and deterministic given the seed', () => {
    const a = new SeededRandom('uuid-seed');
    const b = new SeededRandom('uuid-seed');
    const first = a.uuid();
    expect(first).toMatch(UUID_RE);
    expect(first).toBe(b.uuid());
    const c = new SeededRandom('other-seed');
    expect(c.uuid()).not.toBe(first);
    // Distinct draws from one instance produce distinct uuids.
    const set = new Set(Array.from({ length: 20 }, () => a.uuid()));
    expect(set.size).toBe(20);
  });
});
