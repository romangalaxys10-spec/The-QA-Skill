/**
 * @the-qa-skill/agents — the 8 specialized QA agents + lifecycle orchestrator.
 *
 * Agents consume ONLY @the-qa-skill/core; execution seams (runner spawning)
 * are injected via constructor options so this package stays independent of
 * the runners/reporting packages.
 *
 * The-QA-Skill: sponsored by xShredo.dev → https://xshredo.com/promo/anytest
 */

// Shared agent contracts
export type {
  FeatureSpec,
  TestCaseCategory,
  TestCase,
  TestPlan,
  ScaffoldResult,
  ExecutionOutcome,
  RunOptions,
  IntentKind,
  IntentStep,
  IntentPlan,
  PipelineResult,
  Requirement,
  AssessResult,
  TriageAgentContext,
} from './types.js';

// Intent routing + release gate (local implementation, core-only)
export { routeIntent } from './route-intent.js';
export { computeGate } from './gate.js';

// The 8 specialized agents
export { DiscoveryAgent } from './agents/discovery.js';
export { RequirementsAgent, parseMarkdownSpec, slugify } from './agents/requirements.js';
export { RiskAgent } from './agents/risk.js';
export { GenerationAgent } from './agents/generation.js';
export { ReviewAgent, isTestShaped } from './agents/review.js';
export { ExecutionAgent, DefaultRunnerAdapter } from './agents/execution.js';
export type { SpawnFn, RunnerAdapter } from './agents/execution.js';
export { TriageAgent, detectPrimaryCascade } from './agents/triage.js';
export { HealingAgent } from './agents/healing.js';

// Orchestrator
export { Orchestrator } from './orchestrator.js';
