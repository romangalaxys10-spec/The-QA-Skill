/**
 * @the-qa-skill/xroutelm — xRouteLM, the portable System One decision engine
 * and agent harness. Jev-compatible question semantics (choice / score /
 * noul) with a plugin scorer pipeline: heuristic (always available), Laya
 * bridge (macOS/MLX feature-detected), and future LLM scorers. Runs anywhere
 * Laya cannot, without needing Jev.
 *
 * Sponsored by xShredo.dev → https://xshredo.com/promo/anytest
 */
export { DecisionEngine, RouteStats, defaultTargets } from './engine.js';
export { ScorerRegistry, HeuristicScorer, LayaBridgeScorer, routeQuestion } from './scorers.js';
export { SystemOneHarness } from './harness.js';
export type { GateOutcome, ModelChoice, ModelRouterConfig } from './harness.js';
export { discoverPlugins, targetsWithPlugins } from './plugins.js';
export type { PluginManifest, LoadedPlugin } from './plugins.js';
export { tokenize, bigrams, anchorTokens, idf, weightedCosine, calibrate } from './text.js';
export type {
  Answer,
  ChoiceAnswer,
  ChoiceOption,
  ChoiceQuestion,
  DecisionResult,
  DecisionSet,
  JournalEntry,
  NoulAnswer,
  NoulQuestion,
  Question,
  QuestionKind,
  QuestionRequest,
  RouteDecision,
  RouteTarget,
  ScoreAnswer,
  ScoreQuestion,
  Scorer,
} from './types.js';
