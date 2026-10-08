import { describe, expect, it } from 'vitest';

import { SeededRandom, slug, uniqueIdentity } from '../src/index.js';

describe('uniqueIdentity', () => {
  it('is deterministic for a given seed', () => {
    const a = uniqueIdentity(new SeededRandom('checkout-session'));
    const b = uniqueIdentity(new SeededRandom('checkout-session'));
    expect(a).toEqual(b);
  });

  it('never collides across a seeded session', () => {
    const rnd = new SeededRandom('session-under-test');
    const emails = new Set<string>();
    const orderRefs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const identity = uniqueIdentity(rnd);
      emails.add(identity.email);
      orderRefs.add(identity.orderRef);
    }
    expect(emails.size).toBe(100);
    expect(orderRefs.size).toBe(100);
  });

  it('follows the user-<seq>@domain shape and honors custom domains', () => {
    const rnd = new SeededRandom('shapes');
    const first = uniqueIdentity(rnd);
    const second = uniqueIdentity(rnd);
    expect(first.email).toBe('user-1@example.test');
    expect(second.email).toBe('user-2@example.test');
    expect(first.username).toMatch(/^user-1-[a-z2-9]{6}$/);
    expect(first.orderRef).toMatch(/^ORD-0001-[A-Z2-9]{8}$/);
    const custom = uniqueIdentity(rnd, { domain: 'staging.corp.example' });
    expect(custom.email).toBe('user-3@staging.corp.example');
  });

  it('keeps separate counters for separate SeededRandom instances', () => {
    const rndA = new SeededRandom('a');
    const rndB = new SeededRandom('b');
    expect(uniqueIdentity(rndA).email).toBe('user-1@example.test');
    expect(uniqueIdentity(rndB).email).toBe('user-1@example.test'); // own session
    expect(uniqueIdentity(rndA).email).toBe('user-2@example.test'); // A continued
  });
});

describe('slug', () => {
  it('produces exactly len unambiguous characters', () => {
    const rnd = new SeededRandom('slugs');
    for (const len of [1, 4, 8, 32]) {
      const value = slug(len, rnd);
      expect(value).toHaveLength(len);
      expect(value).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]+$/);
    }
  });

  it('is deterministic for a seed and rejects bad lengths', () => {
    expect(slug(8, new SeededRandom('s'))).toBe(slug(8, new SeededRandom('s')));
    expect(() => slug(0, new SeededRandom('s'))).toThrow(/positive integer/);
    expect(() => slug(2.5, new SeededRandom('s'))).toThrow(/positive integer/);
  });

  it('works without an explicit PRNG via the shared deterministic default', () => {
    // The shared default PRNG is session-scoped too: calls are shape-stable
    // and mutually distinct, but NOT tied to a caller's seed — prefer passing one.
    const first = slug(6);
    const second = slug(6);
    expect(first).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
    expect(second).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{6}$/);
    expect(first).not.toBe(second);
  });
});
