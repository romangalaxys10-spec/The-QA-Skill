import type {
  ChangeArea,
  ChangedFile,
  ChangeRouting,
  LifecyclePhase,
  PhaseRecord,
  QAContext,
  ReleaseGateResult,
  RiskAssessment,
  RiskTier,
  SelectionResult,
  SimpleCluster,
  TestEvent,
  TestLayer,
  TestQualityReport,
  TriageContext,
  TriageResult,
  VerificationLabel,
} from '@the-qa-skill/core';

// ---------------------------------------------------------------------------
// Test design (GenerationAgent)
// ---------------------------------------------------------------------------

/**
 * The structured input to the deterministic test-design pipeline.
 * `acceptanceCriteria` drive case enumeration; `businessRules` pin positive
 * cases to the unit layer; `area` unlocks boundary-specific heuristics
 * (security for auth/api/payment, accessibility for ui).
 */
export interface FeatureSpec {
  name: string;
  description?: string;
  acceptanceCriteria: string[];
  businessRules?: string[];
  area?: ChangeArea;
}

/** The ten heuristic categories the test designer enumerates. */
export type TestCaseCategory =
  | 'positive'
  | 'negative'
  | 'boundary'
  | 'state'
  | 'concurrency'
  | 'security'
  | 'accessibility'
  | 'integration'
  | 'time'
  | 'resilience';

/**
 * One designed test case. Every case carries a Given/When/Then contract and a
 * rationale — a case without a "why" is a wasted execution slot.
 */
export interface TestCase {
  id: string;
  title: string;
  category: TestCaseCategory;
  layer: TestLayer;
  given: string[];
  when: string;
  then: string;
  priority: RiskTier;
  rationale: string;
}

/**
 * The full output of `GenerationAgent.plan()` — cases, counts, and the record
 * of which heuristics fired. The label is always INFERRED: designed cases are
 * reasoning products until they have been executed.
 */
export interface TestPlan {
  feature: string;
  cases: TestCase[];
  summary: { total: number; byCategory: Record<string, number>; byLayer: Record<string, number> };
  heuristicNotes: string[];
  label: VerificationLabel;
}

/** One scaffolded file outcome. `bytes` is the written size, would-be size for dry-run, 0 when skipped. */
export interface ScaffoldResult {
  path: string;
  action: 'created' | 'skipped' | 'dry-run';
  bytes: number;
}

// ---------------------------------------------------------------------------
// Execution (ExecutionAgent)
// ---------------------------------------------------------------------------

/**
 * The result of one execution pass: identity of the run, observed events,
 * what would run (dry-run), and evidence bundles written for failures.
 */
export interface ExecutionOutcome {
  runId: string;
  events: TestEvent[];
  dryRun: boolean;
  plannedCommands: Array<{ runner: string; command: string; args: string[] }>;
  bundles: Array<{ testId: string; path: string }>;
}

/** Options accepted by `Orchestrator.runIntent()`. */
export interface RunOptions {
  /** Orchestration policy; defaults per intent kind (pr_review → 'pr', nightly → 'nightly', release → 'release'). */
  policy?: import('@the-qa-skill/core').OrchestrationPolicyName;
  /** Diff range to assess, e.g. 'HEAD~1' or 'main...HEAD'. Default 'HEAD~1'. */
  range?: string;
  /** Plan commands without spawning anything. */
  dryRun?: boolean;
  /** Explicit confirmation flag for HIGH_RISK intents (e.g. production smoke). */
  confirmRisk?: boolean;
  /** JSON mode: logger stays silent on stdout. */
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Intent routing & orchestration
// ---------------------------------------------------------------------------

/** The eight intent kinds the router recognizes. */
export type IntentKind = 'pr_review' | 'nightly' | 'release' | 'generate' | 'triage' | 'heal' | 'discover' | 'explain';

/** One step of an intent plan or executed pipeline. */
export interface IntentStep {
  phase: LifecyclePhase;
  action: string;
  status: 'planned' | 'done' | 'skipped' | 'blocked';
  note?: string;
}

/** The plan produced by `routeIntent()` before anything executes. */
export interface IntentPlan {
  kind: IntentKind;
  steps: IntentStep[];
  rationale: string;
}

/**
 * Everything one orchestration run learned. `plan` records executed steps
 * (status 'skipped' always carries the reason). `lifecycle` records the same
 * twelve phases from the orchestrator's honest walk: a phase whose work was a
 * verified no-op is recorded as 'skipped' with its reason — even when the
 * underlying LifecycleTracker completed the phase, because the tracker demands
 * 'complete' before dependent phases may begin (VERIFY requires HEAL).
 */
export interface PipelineResult {
  intent: string;
  plan: IntentStep[];
  lifecycle: PhaseRecord[];
  risk?: RiskAssessment;
  selection?: SelectionResult;
  plan2?: TestPlan;
  quality?: TestQualityReport[];
  triage?: TriageResult[];
  clusters?: SimpleCluster[];
  gate?: ReleaseGateResult;
  events?: TestEvent[];
  label: VerificationLabel;
}

// ---------------------------------------------------------------------------
// Agent-specific result shapes
// ---------------------------------------------------------------------------

/**
 * A requirement extracted from markdown specs. Shape-compatible with the
 * requirements element of the core QAContext model.
 */
export type Requirement = QAContext['requirements'][number];

/** The wrapped output of `RiskAgent.assess()`. */
export interface AssessResult {
  assessment: RiskAssessment;
  changedFiles: ChangedFile[];
  routing: ChangeRouting;
  label: VerificationLabel;
}

/**
 * Triage context accepted by `TriageAgent.triage()` — the core
 * `TriageContext` fields are all optional (the agent derives what is missing),
 * plus an optional `diffText` extension used for selector-change detection.
 */
export type TriageAgentContext = Partial<TriageContext> & { diffText?: string };
