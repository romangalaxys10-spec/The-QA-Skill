/**
 * The-QA-Skill — shared type contracts for every package, agent, skill, and MCP tool.
 * This module is the single source of truth for the vocabulary of the platform.
 * Every engine in packages/core consumes and produces these shapes.
 */

// ---------------------------------------------------------------------------
// Verification & safety vocabulary
// ---------------------------------------------------------------------------

/**
 * Every claim produced anywhere in the platform carries one of these labels.
 * CONFIRMED requires OBSERVED evidence; INFERRED claims must expose their reasoning.
 */
export type VerificationLabel = 'NOT_VERIFIED' | 'NOT_RUN' | 'INFERRED' | 'OBSERVED' | 'CONFIRMED';

/** Safe automation policy classes (see policies.ts). */
export type SafetyClass = 'READ_ONLY' | 'LOW_RISK_WRITE' | 'HIGH_RISK';

/** Self-healing confidence tiers. */
export type HealingTier = 'HIGH' | 'MEDIUM' | 'LOW';

/** Release gate verdicts. A subset passing is never PASS. */
export type ReleaseVerdict = 'PASS' | 'PASS_WITH_WARNINGS' | 'BLOCKED' | 'FAIL' | 'UNKNOWN';

/** Triage categories — exactly the 12 documented classes. */
export type FailureCategory =
  | 'REAL_REGRESSION'
  | 'TEST_DEFECT'
  | 'TEST_DATA_DEFECT'
  | 'ENVIRONMENT_FAILURE'
  | 'NETWORK_FAILURE'
  | 'DEPENDENCY_FAILURE'
  | 'FLAKE'
  | 'TIMING_FAILURE'
  | 'SELECTOR_FAILURE'
  | 'ASSERTION_FAILURE'
  | 'CONFIGURATION_FAILURE'
  | 'UNKNOWN';

/** Business areas used for change routing and risk weighting. */
export type ChangeArea =
  | 'ui'
  | 'api'
  | 'db'
  | 'auth'
  | 'payment'
  | 'config'
  | 'test'
  | 'docs'
  | 'infra'
  | 'unknown';

/** Test pyramid layers. */
export type TestLayer = 'unit' | 'integration' | 'api' | 'e2e' | 'visual' | 'a11y' | 'performance' | 'security' | 'contract' | 'manual';

/** Execution status of a single test attempt. */
export type ExecutionStatus = 'passed' | 'failed' | 'skipped' | 'timedout' | 'not_run';

/** Orchestration policies that decide how aggressively to test. */
export type OrchestrationPolicyName = 'pr' | 'pre_merge' | 'nightly' | 'release' | 'post_deploy';

// ---------------------------------------------------------------------------
// Evidence & explainability
// ---------------------------------------------------------------------------

export interface Evidence {
  /** Stable identifier, e.g. `ev-<sha8>`. */
  id: string;
  /** Machine-readable kind used by report renderers. */
  kind:
    | 'git_diff'
    | 'test_output'
    | 'log_line'
    | 'network_capture'
    | 'screenshot'
    | 'trace'
    | 'dom_snapshot'
    | 'metric'
    | 'historical_run'
    | 'static_analysis'
    | 'config'
    | 'reasoning';
  /** Where the evidence lives, if materialized (path, URL, or inline marker). */
  location?: string;
  /** One-sentence human explanation of what this evidence shows. */
  summary: string;
  /** ISO-8601 timestamp of collection. */
  collectedAt: string;
  /** Verification strength attached to this evidence item. */
  label: VerificationLabel;
}

/**
 * The explainability wrapper required on every AI or heuristic conclusion.
 * Nothing in the platform may emit an unexplained verdict.
 */
export interface ExplainableConclusion<T> {
  result: T;
  /** 0..1 confidence. */
  confidence: number;
  /** Reasoning objective: what question was being answered. */
  reasoningObjective: string;
  /** Compact description of the input actually used. */
  inputSummary: string;
  /** Reference to the output schema identifier, e.g. `core.TriageResult.v1`. */
  outputSchema: string;
  evidence: Evidence[];
  /** Assumptions the conclusion depends on (e.g. "environment healthy"). */
  assumptions: string[];
  /** True when a deterministic fallback produced the result instead of a model. */
  fallbackUsed: boolean;
}

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

/** The atomic test event. Every runner maps its native output onto this. */
export interface TestEvent {
  runId: string;
  testId: string;
  name: string;
  timestamp: string;
  status: ExecutionStatus;
  durationMs: number;
  framework: string;
  environment: string;
  browser?: string;
  device?: string;
  commit?: string;
  branch?: string;
  /** 0-based attempt index (0 = first attempt). */
  retryIndex: number;
  failureCategory?: FailureCategory;
  filePath?: string;
  errorType?: string;
  errorMessage?: string;
  errorStack?: string;
}

/** One recorded attempt of a test, used by triage and flake engines. */
export interface AttemptRecord {
  status: ExecutionStatus;
  durationMs: number;
  timestamp: string;
  environment: string;
  browser?: string;
  errorType?: string;
  errorMessage?: string;
  errorStack?: string;
}

/** A failed test with its full attempt history — the triage engine's input. */
export interface FailedTestRecord {
  testId: string;
  name: string;
  filePath: string;
  layer: TestLayer;
  attempts: AttemptRecord[];
  /** Files changed in the range under test (normalized relative paths). */
  changedFiles: string[];
  /** True when the network was verified reachable during the run. */
  networkVerified?: boolean;
  /** True when the DOM/page state was verified deterministic across attempts. */
  domVerified?: boolean;
  /** History of statuses across recent runs, oldest first: 'passed' | 'failed' | 'skipped'. */
  recentRuns: Array<'passed' | 'failed' | 'skipped'>;
  /** Free-form tags collected from the runner. */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Risk engine
// ---------------------------------------------------------------------------

export interface RiskFactorValue {
  factor: RiskFactorId;
  /** Normalized 0..1 intensity. */
  value: number;
  weight: number;
  /** Weighted contribution in points (0..100 scale). */
  contribution: number;
  /** Human-readable reasons why this factor has this value. */
  reasons: string[];
}

export type RiskFactorId =
  | 'businessCriticality'
  | 'changeSurface'
  | 'defectHistory'
  | 'codeComplexity'
  | 'integrationDepth'
  | 'userImpact'
  | 'securitySensitivity'
  | 'dataSensitivity';

export type RiskTier = 'critical' | 'high' | 'medium' | 'low';

export interface RiskInput {
  /** Changed files with area classification (from impact/diff). */
  changedFiles: ChangedFile[];
  /** Normalized churn per file path (0..1), from git history if available. */
  defectHistory?: Record<string, number>;
  /** Lines added+removed across the change set. */
  addedLines?: number;
  removedLines?: number;
  /** Number of distinct modules touched (import closure). */
  modulesTouched?: number;
  /** Optional explicit business criticality override per path pattern. */
  criticalPaths?: string[];
  /** Names of protected boundaries crossed (auth, payment, migrations...). */
  boundarySignals?: string[];
}

export interface RiskAssessment {
  /** Normalized 0..100. */
  score: number;
  tier: RiskTier;
  factors: RiskFactorValue[];
  /** Factors sorted by contribution, descending — the "why" list. */
  topContributors: RiskFactorValue[];
  /** Plain-language explanation of the score and recommended action. */
  explanation: string;
  label: VerificationLabel;
}

// ---------------------------------------------------------------------------
// Change impact & selection
// ---------------------------------------------------------------------------

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  area: ChangeArea;
  language: string;
  /** Exported symbol names detected in the diff (best effort). */
  symbols: string[];
}

export interface TestInventoryEntry {
  testId: string;
  name: string;
  filePath: string;
  layer: TestLayer;
  framework: string;
  /** Source files this test transitively imports (import closure). */
  covers: string[];
  /** Average duration in ms if historical data exists. */
  avgDurationMs?: number;
  /** Historical flake score 0..100 if known. */
  flakeScore?: number;
}

export interface SelectedTest {
  test: TestInventoryEntry;
  /** Priority derived from the risk of what it covers. */
  priority: RiskTier;
  /** Why this test was selected — file-level reasons. */
  reasons: string[];
}

export interface SelectionResult {
  selected: SelectedTest[];
  /** Inventory tests explicitly unaffected by the change set. */
  unaffected: TestInventoryEntry[];
  /** Change-set routing hints derived from areas (e.g. css-only → skip API suites). */
  routing: RoutingHint[];
  summary: string;
  label: VerificationLabel;
}

export interface RoutingHint {
  rule: string;
  triggered: boolean;
  action: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

export interface TriageSignal {
  description: string;
  /** Supporting or contradicting. */
  polarity: 'supports' | 'contradicts';
}

export interface TriageResult {
  testId: string;
  category: FailureCategory;
  /** 0..1. */
  confidence: number;
  /** Primary human-readable root-cause hypothesis. */
  rootCauseHypothesis: string;
  signals: TriageSignal[];
  contradictingSignals: TriageSignal[];
  recommendedAction: string;
  evidence: Evidence[];
  label: VerificationLabel;
}

export interface FailureCluster {
  /** Short stable hash of the normalized signature. */
  id: string;
  signature: string;
  /** Test ids grouped under this signature. */
  testIds: string[];
  /** Dominant category across members. */
  category: FailureCategory;
  /** True when this cluster causes other clusters (primary vs cascade). */
  isPrimary: boolean;
  /** Cluster ids this one likely causes. */
  cascadesTo: string[];
  representativeError: string;
}

// ---------------------------------------------------------------------------
// Flake intelligence
// ---------------------------------------------------------------------------

export interface FlakeInput {
  testId: string;
  /** Chronological attempt outcomes, oldest first. */
  outcomes: Array<{ status: 'passed' | 'failed'; timestamp: string; environment?: string; browser?: string }>;
  /** Number of retries needed across history. */
  retryCount: number;
  /** Distinct environments this test has failed on. */
  environments: string[];
  /** Distinct browsers this test has failed on. */
  browsers: string[];
}

export interface FlakeAssessment {
  testId: string;
  /** 0..100 flake score. */
  score: number;
  /** 'stable' | 'suspect' | 'flaky' | 'critical_flaky'. */
  verdict: 'stable' | 'suspect' | 'flaky' | 'critical_flaky';
  reasons: string[];
  failRate: number;
  label: VerificationLabel;
}

// ---------------------------------------------------------------------------
// Test quality (17 dimensions)
// ---------------------------------------------------------------------------

export type QualityDimensionId =
  | 'correctness'
  | 'determinism'
  | 'isolation'
  | 'assertionStrength'
  | 'behaviorCoverage'
  | 'negativeCoverage'
  | 'boundaryCoverage'
  | 'maintainability'
  | 'readability'
  | 'runtime'
  | 'duplication'
  | 'mockQuality'
  | 'dataQuality'
  | 'security'
  | 'accessibility'
  | 'observability'
  | 'evidenceQuality';

export interface QualityDeduction {
  dimension: QualityDimensionId;
  points: number;
  reason: string;
  line?: number;
}

export interface TestQualityReport {
  filePath: string;
  /** 0..100 after deductions. */
  score: number;
  testCount: number;
  deductions: QualityDeduction[];
  strengths: string[];
  label: VerificationLabel;
}

export interface SuiteHealthReport {
  /** 0..100 weighted composite. */
  score: number;
  components: Array<{ component: string; score: number; weight: number; notes: string }>;
  label: VerificationLabel;
}

// ---------------------------------------------------------------------------
// Healing
// ---------------------------------------------------------------------------

export type HealingKind = 'selector' | 'assertion' | 'data' | 'timing' | 'locator_strategy';

export interface HealingProposal {
  id: string;
  testId: string;
  filePath: string;
  kind: HealingKind;
  description: string;
  currentCode: string;
  proposedCode: string;
  tier: HealingTier;
  /** 0..1. */
  confidence: number;
  evidence: Evidence[];
  rationale: string;
  /** Golden-rule checks that passed. */
  policyChecks: string[];
  /** Golden-rule violations — any violation forbids application. */
  violations: string[];
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export interface CoverageGap {
  path: string;
  area: ChangeArea;
  riskWeight: number;
  coveredBy: string[];
  reason: string;
}

export interface CoverageReport {
  /** Risk-weighted coverage 0..100. */
  weightedCoverage: number;
  /** Raw ratio of source files covered by at least one test. */
  fileCoverage: number;
  gaps: CoverageGap[];
  criticalFlowCoverage: Array<{ flow: string; covered: boolean; note: string }>;
  label: VerificationLabel;
}

// ---------------------------------------------------------------------------
// Release gate
// ---------------------------------------------------------------------------

export interface ReleaseGateInput {
  riskAssessments: RiskAssessment[];
  triageResults: TriageResult[];
  flakeAssessments: FlakeAssessment[];
  coverage?: CoverageReport;
  failedRealRegressions: number;
  openUnknownCategories: number;
  criticalFlakeCount: number;
  evidenceComplete: boolean;
  environment: string;
}

export interface ReleaseGateResult {
  verdict: ReleaseVerdict;
  reasons: string[];
  blockingFindings: string[];
  warnings: string[];
  label: VerificationLabel;
}

// ---------------------------------------------------------------------------
// Learning loop
// ---------------------------------------------------------------------------

export type LearningRecordType =
  | 'failure'
  | 'healing_applied'
  | 'healing_rejected'
  | 'generation_rejected'
  | 'review_feedback'
  | 'flake_observed'
  | 'mutation_survivor'
  | 'data_collision';

export interface LearningRecord {
  id: string;
  type: LearningRecordType;
  timestamp: string;
  tags: string[];
  payload: Record<string, unknown>;
  /** What changed in behavior as a result — never silent. */
  effect: string;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface StackInfo {
  language: string;
  framework?: string;
  packageManager?: string;
  testFrameworks: string[];
  ciSystems: string[];
  monorepo: boolean;
  signals: string[];
}

export interface DiscoveredTestFile {
  filePath: string;
  framework: string;
  layer: TestLayer;
  /** Estimated number of test cases (best effort static count). */
  estimatedCases: number;
}

export interface DiscoveryResult {
  root: string;
  stack: StackInfo;
  testFiles: DiscoveredTestFile[];
  sourceFiles: string[];
  configFiles: string[];
  label: VerificationLabel;
}

// ---------------------------------------------------------------------------
// Golden rules (orchestrator-embedded)
// ---------------------------------------------------------------------------

export interface GoldenRule {
  id: number;
  rule: string;
  /** Where in the platform this rule is mechanically enforced. */
  enforcedBy: string;
}
