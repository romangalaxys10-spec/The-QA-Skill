import { describe, expect, it } from 'vitest';

import { validateManifest } from '../src/index.js';

const valid = {
  seed: 'checkout-regression-42',
  factories: {
    users: { name: 'user', count: 10, traits: ['pro'] },
    orders: { name: 'order', count: 5 },
  },
  cleanup: { strategy: 'per-test', owner: 'packages/cli/test/checkout.test.ts' },
};

describe('validateManifest', () => {
  it('accepts a fully valid manifest', () => {
    const result = validateManifest(valid);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('accepts numeric seeds and zero-count factories', () => {
    const result = validateManifest({
      seed: 1337,
      factories: { logs: { name: 'log-line', count: 0 } },
      cleanup: { strategy: 'manual', owner: 'qa-agent' },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects non-object payloads', () => {
    expect(validateManifest(null)).toEqual({ ok: false, issues: ['manifest: expected an object'] });
    expect(validateManifest([1, 2])).toEqual({ ok: false, issues: ['manifest: expected an object'] });
    expect(validateManifest('nope').ok).toBe(false);
  });

  it('lists every issue for a broken manifest (no fail-fast)', () => {
    const result = validateManifest({
      seed: '',
      factories: {
        bad: { name: '', count: -2, traits: ['ok', ''] },
        worse: { count: 1.5 },
      },
      cleanup: { strategy: 'whenever', owner: '' },
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      'seed: must be a finite number or a non-empty string',
      'factories.bad.name: must be a non-empty string',
      'factories.bad.count: must be a non-negative integer',
      'factories.bad.traits: every trait must be a non-empty string',
      'factories.worse.name: must be a non-empty string',
      'factories.worse.count: must be a non-negative integer',
      'cleanup.strategy: must be one of per-test | per-suite | manual',
      'cleanup.owner: must be a non-empty string',
    ]);
  });

  it('flags structural problems: missing factories, non-object specs, unknown strategy', () => {
    expect(validateManifest({ seed: 1, factories: {}, cleanup: valid.cleanup }).issues).toContain(
      'factories: must declare at least one factory spec',
    );
    const missing = validateManifest({ seed: 1, cleanup: valid.cleanup });
    expect(missing.issues).toContain('factories: must be an object of factory specs');
    expect(validateManifest({ seed: 1, factories: { a: 'nope' }, cleanup: valid.cleanup }).issues).toContain(
      'factories.a: must be an object',
    );
    expect(validateManifest({ seed: 1, factories: valid.factories, cleanup: 'later' }).issues).toContain(
      'cleanup: must be an object with strategy and owner',
    );
  });

  it('flags non-array and non-string traits', () => {
    const result = validateManifest({
      seed: 1,
      factories: { a: { name: 'a', count: 1, traits: 'pro' } },
      cleanup: valid.cleanup,
    });
    expect(result.issues).toContain('factories.a.traits: must be an array of trait names');
  });
});
