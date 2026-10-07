import {
  DEFAULT_CONFIG,
  analyzeDiff,
  assessRisk,
  churnHotspots,
  classifyRouting,
  loadConfig,
} from '@the-qa-skill/core';
import type {
  ChangedFile,
  ChangeRouting,
  RiskAssessment,
  TheQAConfig,
  VerificationLabel,
} from '@the-qa-skill/core';
import type { AssessResult } from '../types.js';

/**
 * RiskAgent — wraps the core risk engine into an agent-grade assessment.
 *
 * Pipeline per `assess(range)`:
 *   1. core `analyzeDiff(root, range)` → structured change set;
 *   2. core `churnHotspots(root)` → normalized defect-history proxy;
 *   3. core `classifyRouting(files)` → boundary signals (auth/payment/db/...);
 *   4. `modulesTouched` = distinct containing directories of changed source
 *      files (test-shaped files excluded; root-level files count as one
 *      '(root)' module);
 *   5. core `assessRisk` with the config's weights/thresholds and the
 *      project's configured criticalPaths.
 *
 * A partially-specified injected config is accepted: every missing section is
 * filled from `DEFAULT_CONFIG` (weights/thresholds/paths/selection/execution/
 * integrations), so `this.config` is always a complete TheQAConfig.
 *
 * The returned label is the assessment's own label (INFERRED): deterministic
 * given its inputs, but the inputs are repository heuristics, not production
 * measurements.
 */

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php)$/;
const TEST_SHAPED = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(tests?|spec|__tests__|e2e)\//i;

export class RiskAgent {
  /** The resolved configuration (explicit option normalized with defaults, or loaded from theqa.config.json). */
  public readonly config: TheQAConfig;

  constructor(
    private readonly root: string,
    opts: { config?: Partial<TheQAConfig> } = {},
  ) {
    this.config = opts.config === undefined ? loadConfig(root).config : withConfigDefaults(opts.config);
  }

  /** Assess the risk of the given diff range (e.g. 'HEAD~1', 'main...HEAD'). */
  async assess(range: string): Promise<AssessResult> {
    const [diff, hotspots] = await Promise.all([
      analyzeDiff(this.root, range),
      churnHotspots(this.root),
    ]);
    const routing: ChangeRouting = classifyRouting(diff.files);
    const assessment: RiskAssessment = assessRisk(
      {
        changedFiles: diff.files,
        defectHistory: hotspots,
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        modulesTouched: countModules(diff.files),
        criticalPaths: this.config.project.criticalPaths,
        boundarySignals: routing.boundarySignals,
      },
      { weights: this.config.risk.weights, thresholds: this.config.risk.thresholds },
    );
    const label: VerificationLabel = assessment.label;
    return { assessment, changedFiles: diff.files, routing, label };
  }
}

/**
 * Distinct containing directories of changed source files (test-shaped files
 * excluded). Root-level files count as one '(root)' module.
 */
function countModules(files: ChangedFile[]): number {
  const dirs = new Set<string>();
  for (const f of files) {
    if (!CODE_EXT.test(f.path) || TEST_SHAPED.test(f.path)) continue;
    const slash = f.path.lastIndexOf('/');
    const dir = slash > 0 ? f.path.slice(0, slash) : '(root)';
    dirs.add(dir);
  }
  return dirs.size;
}

/**
 * Fill every absent config section from DEFAULT_CONFIG so downstream reads
 * (`config.risk.weights`, `config.selection.alwaysInclude`, ...) never hit
 * undefined — callers may inject minimal partial configs (tests, presets).
 */
function withConfigDefaults(partial: Partial<TheQAConfig>): TheQAConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    project: { ...DEFAULT_CONFIG.project, ...partial.project },
    paths: { ...DEFAULT_CONFIG.paths, ...partial.paths },
    risk: {
      weights: { ...DEFAULT_CONFIG.risk.weights, ...partial.risk?.weights },
      thresholds: { ...DEFAULT_CONFIG.risk.thresholds, ...partial.risk?.thresholds },
    },
    selection: { ...DEFAULT_CONFIG.selection, ...partial.selection },
    execution: { ...DEFAULT_CONFIG.execution, ...partial.execution },
    integrations: { ...DEFAULT_CONFIG.integrations, ...partial.integrations },
  };
}
