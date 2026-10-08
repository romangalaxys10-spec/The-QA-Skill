/**
 * @the-qa-skill/data — fixture manifests.
 *
 * A FixtureManifest declares, for a suite or run: the seed everything was
 * derived from, which factories to instantiate with which traits, and the
 * cleanup contract (strategy + owner). The platform contract requires every
 * test to answer: source (seed), owner, isolation and cleanup — validation
 * below enforces that shape without pulling in a schema library.
 */

/** Supported cleanup strategies for fixture data. */
export type CleanupStrategy = 'per-test' | 'per-suite' | 'manual';

/** One factory instantiation: which factory, how many objects, which traits. */
export interface FixtureFactorySpec {
  /** Must match a factory name registered by the consumer. */
  name: string;
  /** Non-negative integer number of objects to build. */
  count: number;
  /** Trait names applied in order to every built object. */
  traits?: string[];
}

/** Cleanup contract: how and by whom fixtures are removed. */
export interface FixtureCleanup {
  strategy: CleanupStrategy;
  /** Ownable identity accountable for cleanup (suite path, agent id, ...). */
  owner: string;
}

/** Declarative fixture plan for a suite or run. */
export interface FixtureManifest {
  /** Seed for every SeededRandom / factory in the run (number or string). */
  seed: number | string;
  /** Factories to instantiate, keyed by logical slot name. */
  factories: Record<string, FixtureFactorySpec>;
  cleanup: FixtureCleanup;
}

/** Result of manifest validation: `ok` is true iff `issues` is empty. */
export interface ManifestValidation {
  ok: boolean;
  issues: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strategies accepted for cleanup.strategy. */
export const CLEANUP_STRATEGIES: readonly CleanupStrategy[] = ['per-test', 'per-suite', 'manual'];

/**
 * Validate an unknown payload as a FixtureManifest. Zod-free on purpose: this
 * module must stay dependency-free. Collects ALL issues (does not fail fast)
 * so a caller can surface one actionable error block:
 *  - seed: finite number or non-empty string
 *  - factories: at least one spec; each with non-empty string name, non-negative
 *    integer count, optional array of non-empty string traits
 *  - cleanup: strategy in CLEANUP_STRATEGIES, non-empty string owner
 */
export function validateManifest(raw: unknown): ManifestValidation {
  const issues: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, issues: ['manifest: expected an object'] };
  }

  const seed = raw['seed'];
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) issues.push('seed: must be a finite number or a non-empty string');
  } else if (typeof seed !== 'string' || seed.length === 0) {
    issues.push('seed: must be a finite number or a non-empty string');
  }

  const factories = raw['factories'];
  if (!isPlainObject(factories)) {
    issues.push('factories: must be an object of factory specs');
  } else {
    const keys = Object.keys(factories);
    if (keys.length === 0) {
      issues.push('factories: must declare at least one factory spec');
    }
    for (const key of keys) {
      const spec = factories[key];
      const at = `factories.${key}`;
      if (!isPlainObject(spec)) {
        issues.push(`${at}: must be an object`);
        continue;
      }
      const name = spec['name'];
      if (typeof name !== 'string' || name.length === 0) {
        issues.push(`${at}.name: must be a non-empty string`);
      }
      const count = spec['count'];
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
        issues.push(`${at}.count: must be a non-negative integer`);
      }
      const traits = spec['traits'];
      if (traits !== undefined) {
        if (!Array.isArray(traits)) {
          issues.push(`${at}.traits: must be an array of trait names`);
        } else if (traits.some((t) => typeof t !== 'string' || t.length === 0)) {
          issues.push(`${at}.traits: every trait must be a non-empty string`);
        }
      }
    }
  }

  const cleanup = raw['cleanup'];
  if (!isPlainObject(cleanup)) {
    issues.push('cleanup: must be an object with strategy and owner');
  } else {
    const strategy = cleanup['strategy'];
    if (typeof strategy !== 'string' || !(CLEANUP_STRATEGIES as readonly string[]).includes(strategy)) {
      issues.push(`cleanup.strategy: must be one of ${CLEANUP_STRATEGIES.join(' | ')}`);
    }
    const owner = cleanup['owner'];
    if (typeof owner !== 'string' || owner.length === 0) {
      issues.push('cleanup.owner: must be a non-empty string');
    }
  }

  return { ok: issues.length === 0, issues };
}
