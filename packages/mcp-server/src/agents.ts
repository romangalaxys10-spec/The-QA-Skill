/**
 * Lazy loader for @the-qa-skill/agents.
 *
 * The MCP server depends on the agents package for the agentic tools
 * (risk, generation, execution, triage, healing, review). The import is
 * deliberately lazy (dynamic import inside the tool call) so that:
 *   - the deterministic core tools keep working even when agents is absent,
 *   - a broken agents build degrades into a clean `agents package unavailable`
 *     tool error instead of crashing the server at startup.
 *
 * Only the symbols guaranteed by the agents API contract are consumed:
 * RiskAgent, GenerationAgent, ExecutionAgent, TriageAgent, HealingAgent,
 * ReviewAgent (constructors taking the project root) and the FeatureSpec type.
 */
import type {
  ChangeRouting, ChangedFile, FailureCluster, FailedTestRecord,
  HealCandidate, HealingProposal, OrchestrationPolicyName, RiskAssessment, SimpleCluster, TriageResult,
} from '@the-qa-skill/core';
import type { FeatureSpec } from '@the-qa-skill/agents';
import { ToolError, errorMessage } from './errors.js';

/** Message used whenever the agents package cannot be loaded. */
export const AGENTS_UNAVAILABLE_MESSAGE = 'agents package unavailable';

/** What RiskAgent.assess(range) is expected to return (label passthrough from agents AssessResult). */
export interface RiskAgentAssessment {
  assessment: RiskAssessment;
  changedFiles: ChangedFile[];
  routing?: ChangeRouting;
  label?: string;
}

/** Per-batch triage context handed to TriageAgent.triage (all fields optional — the agent computes per-failure defaults). */
export interface TriageAgentContext {
  coversChangedCode?: boolean;
  relevantChangedFiles?: string[];
  selectorChangedInDiff?: boolean;
}

/** What TriageAgent.triage is expected to return. */
export interface TriageAgentOutput {
  results: TriageResult[];
  clusters: FailureCluster[];
}

/** Structural type of RiskAgent — the real class comes from @the-qa-skill/agents. */
export interface RiskAgentLike {
  assess(range: string): RiskAgentAssessment | Promise<RiskAgentAssessment>;
}

/** Structural type of GenerationAgent — planning only, never writes files. */
export interface GenerationAgentLike {
  plan(feature: FeatureSpec): unknown | Promise<unknown>;
}

/** Structural type of ExecutionAgent — `selection` is null (agent selects). */
export interface ExecutionAgentLike {
  execute(selection: null, opts: { policy: OrchestrationPolicyName; dryRun: boolean }): unknown | Promise<unknown>;
}

/** Structural type of TriageAgent — clusters() is the signature clustering step. */
export interface TriageAgentLike {
  triage(failures: FailedTestRecord[], ctx: TriageAgentContext): TriageAgentOutput | Promise<TriageAgentOutput>;
  clusters?(failures: FailedTestRecord[]): SimpleCluster[];
}

/** Structural type of HealingAgent — proposals only, never applies. */
export interface HealingAgentLike {
  propose(candidate: HealCandidate): HealingProposal | Promise<HealingProposal>;
}

/** Structural type of ReviewAgent. */
export interface ReviewAgentLike {
  review(): unknown | Promise<unknown>;
}

type AgentConstructor<T> = new (root: string) => T;

/** Shape of @the-qa-skill/agents the server consumes (all members optional). */
export interface AgentsModuleShape {
  RiskAgent?: AgentConstructor<RiskAgentLike>;
  GenerationAgent?: AgentConstructor<GenerationAgentLike>;
  ExecutionAgent?: AgentConstructor<ExecutionAgentLike>;
  TriageAgent?: AgentConstructor<TriageAgentLike>;
  HealingAgent?: AgentConstructor<HealingAgentLike>;
  ReviewAgent?: AgentConstructor<ReviewAgentLike>;
}

/** Instance type produced per agent name. */
export interface AgentInstanceMap {
  RiskAgent: RiskAgentLike;
  GenerationAgent: GenerationAgentLike;
  ExecutionAgent: ExecutionAgentLike;
  TriageAgent: TriageAgentLike;
  HealingAgent: HealingAgentLike;
  ReviewAgent: ReviewAgentLike;
}

let cachedModule: AgentsModuleShape | null | undefined;

/**
 * Load (and cache) the agents module. Returns null when the package is
 * missing, fails to import, or exports nothing usable — never throws.
 */
export async function loadAgentsModule(): Promise<AgentsModuleShape | null> {
  if (cachedModule !== undefined) return cachedModule;
  try {
    const mod: unknown = await import('@the-qa-skill/agents');
    cachedModule = mod !== null && typeof mod === 'object' ? (mod as AgentsModuleShape) : null;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

/** Test/refresh hook: forget the cached agents module. */
export function resetAgentsModuleCache(): void {
  cachedModule = undefined;
}

/**
 * Construct the named agent against `root`, or return null when the agents
 * package does not provide it. Use {@link requireAgent} for agent-only tools.
 */
export async function constructAgent<K extends keyof AgentInstanceMap>(
  name: K,
  root: string,
): Promise<AgentInstanceMap[K] | null> {
  const mod = await loadAgentsModule();
  const ctor = mod?.[name];
  if (typeof ctor !== 'function') return null;
  try {
    const Ctor = ctor as unknown as new (root: string) => AgentInstanceMap[K];
    return new Ctor(root);
  } catch (err) {
    throw new ToolError(`${String(name)} could not be constructed: ${errorMessage(err)}`);
  }
}

/**
 * Like {@link constructAgent} but throws the canonical graceful error when
 * the agent class is unavailable — for tools that have no core fallback.
 */
export async function requireAgent<K extends keyof AgentInstanceMap>(
  name: K,
  root: string,
): Promise<AgentInstanceMap[K]> {
  const agent = await constructAgent(name, root);
  if (agent === null) {
    throw new ToolError(`${AGENTS_UNAVAILABLE_MESSAGE} — ${String(name)} is required for this tool`);
  }
  return agent;
}
