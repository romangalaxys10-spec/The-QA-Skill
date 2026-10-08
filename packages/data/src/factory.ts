import { fnv1a32, SeededRandom } from './random.js';

/**
 * @the-qa-skill/data — factories: deterministic, sequence-based test data.
 *
 * A factory turns a seeded random + an incrementing sequence into domain
 * objects. Sequence starts at 1 so identity-bearing attributes (emails,
 * order refs, usernames) are unique within a factory, and the whole dataset
 * is reproducible from the seed.
 */

/** A trait mutates the base object produced by `attributes` before overrides. */
export type TraitApplier<T> = (base: T, rnd: SeededRandom) => T;

/** Options for `defineFactory`. */
export interface FactoryOptions<T> {
  /** Unique factory name, also the default seed source when `seed` is omitted. */
  name: string;
  /** Explicit seed; defaults to FNV-1a of `name` so factories are reproducible. */
  seed?: number | string;
  /** Base attribute builder. `seq` starts at 1 and increments per built object. */
  attributes: (seq: number, rnd: SeededRandom) => T;
  /** Named transformations composable at build time. */
  traits?: Record<string, TraitApplier<T>>;
}

/** Per-build options. */
export interface BuildOptions {
  /** Apply this trait for this build (overrides the factory default trait). */
  trait?: string;
}

/** A deterministic object factory. */
export interface Factory<T> {
  readonly name: string;
  /**
   * Build one object: attributes(seq, rnd) → optional trait → overrides.
   * Overrides always win, so a test can pin a single field without losing
   * the deterministic defaults.
   */
  build(overrides?: Partial<T>, opts?: BuildOptions): T;
  /** Build `count` objects, each consuming one sequence number. */
  buildMany(count: number, opts?: BuildOptions): T[];
  /**
   * Return a NEW factory whose builds apply the named trait by default.
   * The sequence counter and PRNG are shared with the parent, so identities
   * stay unique across both factories.
   */
  withTrait(trait: string): Factory<T>;
}

/**
 * Define a deterministic factory. Throws when the name is empty or
 * `attributes` is not a function; unknown trait names throw at build time
 * (before consuming a sequence number).
 */
export function defineFactory<T>(options: FactoryOptions<T>): Factory<T> {
  if (typeof options.name !== 'string' || options.name.length === 0) {
    throw new Error('defineFactory requires a non-empty name');
  }
  if (typeof options.attributes !== 'function') {
    throw new Error(`factory '${options.name}' requires an attributes function`);
  }
  const traits: Record<string, TraitApplier<T>> = options.traits ?? {};
  const state = { seq: 0 };
  const rnd = new SeededRandom(options.seed ?? fnv1a32(options.name));

  const resolveTrait = (traitName: string | undefined): TraitApplier<T> | undefined => {
    if (traitName === undefined) return undefined;
    const trait = traits[traitName];
    if (!trait) {
      const available = Object.keys(traits).join(', ') || 'none';
      throw new Error(`factory '${options.name}' has no trait '${traitName}' (available: ${available})`);
    }
    return trait;
  };

  const buildOne = (overrides: Partial<T> | undefined, traitName: string | undefined): T => {
    const trait = resolveTrait(traitName); // validate BEFORE consuming a sequence number
    state.seq += 1;
    let value = options.attributes(state.seq, rnd);
    if (trait) value = trait(value, rnd);
    return overrides ? { ...value, ...overrides } : value;
  };

  const makeFactory = (defaultTrait?: string): Factory<T> => ({
    name: options.name,
    build: (overrides, buildOpts) => buildOne(overrides, buildOpts?.trait ?? defaultTrait),
    buildMany: (count, buildOpts) => {
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`buildMany requires a non-negative integer count, got ${count}`);
      }
      const traitName = buildOpts?.trait ?? defaultTrait;
      const out: T[] = [];
      for (let i = 0; i < count; i++) out.push(buildOne(undefined, traitName));
      return out;
    },
    withTrait: (trait) => {
      resolveTrait(trait);
      return makeFactory(trait);
    },
  });

  return makeFactory();
}
