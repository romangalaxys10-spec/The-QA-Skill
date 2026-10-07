/**
 * @the-qa-skill/core — deterministic QA engine.
 * The-QA-Skill: sponsored by xShredo.dev → https://xshredo.com/promo/anytest
 */

// Contracts
export * from './types.js';

// Verification labels & explainability
export {
  VERIFICATION_LABELS,
  strongestLabel,
  weakestLabel,
  canConfirm,
  describeLabel,
} from './labels.js';

// Golden rules
export { GOLDEN_RULES, goldenRuleById } from './golden-rules.js';

// Logging
export { createLogger } from './log.js';
export type { Logger, LoggerOptions } from './log.js';

// Config
export {
  configSchema,
  DEFAULT_CONFIG,
  ConfigError,
  findConfigFile,
  loadConfig,
  renderDefaultConfig,
} from './config.js';
export type { TheQAConfig, RiskWeights } from './config.js';

// QA Context model
export {
  qaContextSchema,
  buildContext,
  parseContext,
  serializeContext,
  withRisk,
  withSelection,
  ContextValidationError,
} from './context.js';
export type { QAContext, QAContextInput } from './context.js';

// Lifecycle
export {
  LIFECYCLE_PHASES,
  LifecycleTracker,
  LifecycleError,
} from './lifecycle.js';
export type { LifecyclePhase, PhaseRecord, PhaseStatus } from './lifecycle.js';

// Safe automation policy
export {
  ACTION_POLICIES,
  classifyAction,
  requiresConfirmation,
  assertAuthorized,
} from './policies.js';
export type { ActionPolicy } from './policies.js';

// Risk engine
export { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, assessRisk, tierFor, renderExplanation } from './risk/engine.js';
export {
  FACTOR_IDS,
  classifyArea,
  computeAllFactors,
  computeBusinessCriticality,
  computeChangeSurface,
  computeCodeComplexity,
  computeDataSensitivity,
  computeDefectHistory,
  computeIntegrationDepth,
  computeSecuritySensitivity,
  computeUserImpact,
  matchesAny,
} from './risk/factors.js';
export type { FactorComputation } from './risk/factors.js';

// Impact & selection
export { analyzeDiff, classifyRouting } from './impact/diff.js';
export type { DiffParseResult, ChangeRouting } from './impact/diff.js';
export { selectTests, buildRoutingHints, computeCoverage } from './impact/select.js';
export type { SelectOptions } from './impact/select.js';

// Triage
export {
  classifyFailure,
  detectSelectorChange,
  errorTypeOf,
} from './triage/classify.js';
export type { TriageContext } from './triage/classify.js';
export {
  buildSignature,
  clusterFailures,
  normalizeFrames,
  normalizeMessage,
  signatureSimilarity,
} from './triage/signature.js';
export type { NormalizedSignature, RawFailure, SimpleCluster, ClusterOptions } from './triage/signature.js';

// Flake
export { scoreFlake, suiteFlakeHealth } from './flake/score.js';

// Quality
export { QUALITY_DIMENSIONS, DIMENSION_BY_ID } from './quality/dimensions.js';
export { analyzeTestFile, suiteHealth, detectDuplication } from './quality/score.js';

// Healing
export { buildProposal, changesAssertions, raisesTimeoutValue, selectorCandidatesFromSnapshot } from './heal/tiers.js';
export type { HealCandidate } from './heal/tiers.js';
export { applyProposal, canApply, classifyDeletionRequest } from './heal/policy.js';
export type { ApplyResult } from './heal/policy.js';

// Coverage
export { analyzeCoverage } from './coverage/analyze.js';
export type { CoverageFlow } from './coverage/analyze.js';

// Evidence
export {
  evidenceBundleLayout,
  renderFailureNarrative,
  runIdFor,
  scrubSecrets,
  writeEvidenceBundle,
} from './evidence/bundle.js';
export type { BundleInputs, BundleMetadata } from './evidence/bundle.js';

// Learning
export { LearningStore, defaultLearningPath } from './learning/store.js';
export type { LearningQuery } from './learning/store.js';

// Discovery
export { discover, detectStack, inventoryTests } from './discovery/stack.js';

// Utils
export { runGit, isGitRepo, currentCommit, currentBranch, churnHotspots } from './util/git.js';
export { listFiles, matchAny } from './util/glob.js';
