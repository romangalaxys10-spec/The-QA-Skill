import { describe, expect, it } from 'vitest';

import { defineFactory, uniqueIdentity } from '../src/index.js';
import type { Factory } from '../src/index.js';

interface User {
  id: number;
  email: string;
  username: string;
  plan: string;
}

/** Fresh factory per test — the sequence counter must never leak between tests. */
const makeUserFactory = (): Factory<User> =>
  defineFactory<User>({
    name: 'user',
    seed: 'users-seed',
    attributes: (seq, rnd) => ({
      id: seq,
      email: `user-${seq}@example.test`,
      username: `user-${seq}-${rnd.int(1000, 9999)}`,
      plan: 'free',
    }),
    traits: {
      pro: (base) => ({ ...base, plan: 'pro' }),
      banned: (base) => ({ ...base, plan: 'banned' }),
    },
  });

describe('defineFactory — sequencing', () => {
  it('starts the sequence at 1 and increments per build', () => {
    const factory = makeUserFactory();
    const first = factory.build();
    const second = factory.build();
    expect(first.id).toBe(1);
    expect(second.id).toBe(2);
    expect(second.email).not.toBe(first.email);
  });

  it('is deterministic: same name and seed rebuild the same sequence', () => {
    const a = makeUserFactory();
    const b = makeUserFactory();
    expect(a.buildMany(5)).toEqual(b.buildMany(5));
  });

  it('buildMany yields unique identities for every object', () => {
    const users = makeUserFactory().buildMany(25);
    expect(users).toHaveLength(25);
    const emails = new Set(users.map((u) => u.email));
    const usernames = new Set(users.map((u) => u.username));
    expect(emails.size).toBe(25);
    expect(usernames.size).toBe(25);
    expect(users.map((u) => u.id)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('buildMany returns an empty array for zero and rejects bad counts', () => {
    const factory = makeUserFactory();
    expect(factory.buildMany(0)).toEqual([]);
    expect(() => factory.buildMany(-1)).toThrow(/non-negative integer/);
    expect(() => factory.buildMany(1.5)).toThrow(/non-negative integer/);
  });

  it('falls back to a name-derived seed when none is given (reproducible)', () => {
    const make = (): Factory<{ seq: number; code: string }> =>
      defineFactory<{ seq: number; code: string }>({
        name: 'order-line',
        attributes: (seq, rnd) => ({ seq, code: `C-${rnd.int(0, 999999)}` }),
      });
    expect(make().buildMany(3).map((u) => u.seq)).toEqual([1, 2, 3]);
    // Same factory name → same derived seed → identical random draws.
    expect(make().buildMany(3).map((u) => u.code)).toEqual(make().buildMany(3).map((u) => u.code));
  });
});

describe('defineFactory — overrides & traits', () => {
  it('lets overrides win over generated attributes', () => {
    const user = makeUserFactory().build({ email: 'pinned@override.test' });
    expect(user.email).toBe('pinned@override.test');
    expect(user.id).toBe(1);
    expect(user.plan).toBe('free');
  });

  it('applies a trait for a single build', () => {
    const factory = makeUserFactory();
    expect(factory.build(undefined, { trait: 'pro' }).plan).toBe('pro');
    expect(factory.build(undefined, { trait: 'banned' }).plan).toBe('banned');
  });

  it('composes a trait with overrides', () => {
    const user = makeUserFactory().build({ username: 'fixed' }, { trait: 'pro' });
    expect(user.plan).toBe('pro');
    expect(user.username).toBe('fixed');
  });

  it('withTrait returns a NEW factory applying the trait by default', () => {
    const factory = makeUserFactory();
    const pro = factory.withTrait('pro');
    expect(pro).not.toBe(factory);
    expect(pro.name).toBe(factory.name);
    expect(pro.build().plan).toBe('pro');
    expect(factory.build().plan).toBe('free');
    // A per-build trait can still override the factory default trait.
    expect(pro.build(undefined, { trait: 'banned' }).plan).toBe('banned');
  });

  it('withTrait shares the sequence counter with its parent', () => {
    const factory = makeUserFactory();
    const pro = factory.withTrait('pro');
    expect(factory.build().id).toBe(1);
    expect(pro.build().id).toBe(2);
    expect(factory.build().id).toBe(3);
  });

  it('throws on unknown traits without consuming a sequence number', () => {
    const factory = makeUserFactory();
    void factory.build(); // seq 1
    expect(() => factory.build(undefined, { trait: 'nope' })).toThrow(/has no trait 'nope'/);
    expect(() => factory.withTrait('nope')).toThrow(/has no trait 'nope'/);
    expect(factory.build().id).toBe(2); // failed builds did not burn sequence numbers
  });

  it('validates constructor arguments', () => {
    expect(() => defineFactory({ name: '', attributes: () => ({}) })).toThrow(/non-empty name/);
    expect(() =>
      defineFactory({
        name: 'x',
        attributes: undefined as unknown as () => Record<string, never>,
      }),
    ).toThrow(/requires an attributes function/);
  });
});

describe('defineFactory — identity integration', () => {
  it('keeps uniqueIdentity distinct across buildMany within a session', () => {
    const identityFactory = defineFactory<{ email: string; username: string; orderRef: string }>({
      name: 'session-user',
      seed: 'session',
      attributes: (_seq, rnd) => {
        const identity = uniqueIdentity(rnd);
        return { email: identity.email, username: identity.username, orderRef: identity.orderRef };
      },
    });
    const users = identityFactory.buildMany(10);
    expect(new Set(users.map((u) => u.email)).size).toBe(10);
    expect(users[0]?.email).toBe('user-1@example.test');
    expect(users[9]?.email).toBe('user-10@example.test');
  });
});
