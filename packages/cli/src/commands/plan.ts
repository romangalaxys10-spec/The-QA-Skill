import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { classifyArea, discover, loadConfig, parseContext } from '@the-qa-skill/core';
import type { ChangeArea, DiscoveryResult, OrchestrationPolicyName, QAContext, TheQAConfig, VerificationLabel } from '@the-qa-skill/core';
import { DiscoveryAgent, RequirementsAgent } from '@the-qa-skill/agents';
import type { CommandSpec } from '../args.js';
import { ok, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa plan — deterministic QA plan from the current context.
 *
 * Context source: `.theqa/context.json` when present (parseContext-validated),
 * otherwise an in-memory DiscoveryAgent-built context. The plan is fully
 * deterministic — identical repository state produces identical output.
 *
 * JSON shape: { contextSource, requirements, objectives, proposedLayers,
 * policy, openQuestions, inventory }.
 */

/** Risk-area objectives — area → the question its tests must answer. */
const AREA_OBJECTIVES: ReadonlyArray<{ area: ChangeArea; objective: string }> = [
  { area: 'payment', objective: 'Prove charge/refund correctness end-to-end, including duplicate-submit idempotency and declined-payment paths.' },
  { area: 'auth', objective: 'Prove the authentication boundary: session lifecycle, token expiry, and permission denials.' },
  { area: 'db', objective: 'Prove data integrity across schema changes, including migration rollback and constraint behavior.' },
  { area: 'api', objective: 'Prove API contracts: request/response shapes, status codes, and error envelopes.' },
  { area: 'ui', objective: 'Prove user-facing flows with role/label-based queries plus accessibility checks.' },
  { area: 'infra', objective: 'Prove infrastructure changes do not alter runtime behavior observable by users.' },
  { area: 'config', objective: 'Prove configuration changes are caught by doctor checks and do not silently shift test behavior.' },
  { area: 'unknown', objective: 'Establish baseline regression coverage for modules with no classified area.' },
];

const AREA_ORDER: ReadonlyArray<ChangeArea> = ['payment', 'auth', 'db', 'api', 'ui', 'infra', 'config', 'unknown'];

function objectivesFor(sourceFiles: string[]): Array<{ area: ChangeArea; objective: string; basis: string }> {
  const present = new Set<ChangeArea>();
  for (const file of sourceFiles) {
    const area = classifyArea(file);
    if (area !== 'docs' && area !== 'test') present.add(area);
  }
  return AREA_ORDER.filter((a) => present.has(a)).map((area) => ({
    area,
    objective: AREA_OBJECTIVES.find((o) => o.area === area)?.objective ?? 'Establish baseline regression coverage.',
    basis: `${sourceFiles.filter((f) => classifyArea(f) === area).length} source file(s) classified ${area}`,
  }));
}

function proposedLayers(discovery: DiscoveryResult): Array<{ layer: string; rationale: string }> {
  const layers: Array<{ layer: string; rationale: string }> = [];
  const existing = new Set(discovery.testFiles.map((t) => t.layer));
  const areas = new Set(discovery.sourceFiles.map((f) => classifyArea(f)));
  layers.push({ layer: 'unit', rationale: existing.has('unit') ? 'unit tests exist — keep them as the fastest regression signal' : 'no unit tests detected — every area objective starts cheapest here' });
  if (areas.has('api') || areas.has('payment') || areas.has('auth')) {
    layers.push({ layer: 'api', rationale: 'API/auth/payment surfaces detected — contract tests pin the boundary independent of UI churn' });
  }
  if (areas.has('db')) {
    layers.push({ layer: 'integration', rationale: 'data-layer files detected — integration tests prove schema/migration behavior against a real store' });
  }
  if (areas.has('ui') || areas.has('payment')) {
    layers.push({ layer: 'e2e', rationale: 'user-facing or money-path flows detected — a thin e2e smoke proves the flow end-to-end (pyramid cap applies)' });
  }
  return layers;
}

/** Deterministic policy recommendation — first matching rule wins. */
export function recommendPolicy(discovery: DiscoveryResult, config: TheQAConfig): { recommended: OrchestrationPolicyName; rationale: string } {
  if (discovery.testFiles.length === 0) {
    return { recommended: 'pre_merge', rationale: 'no test inventory yet — validate the first suites under the stricter pre-merge policy before trusting fast PR runs' };
  }
  const criticalAreas: ChangeArea[] = ['payment', 'auth', 'db'];
  const criticalSources = discovery.sourceFiles.filter((f) => criticalAreas.includes(classifyArea(f)));
  if (criticalSources.length > 0 && config.project.criticalFlows.length === 0) {
    return { recommended: 'pre_merge', rationale: `critical-area source files exist (${criticalSources.length}) but no criticalFlows are configured — pre-merge validation until flows are pinned` };
  }
  if (discovery.stack.monorepo && discovery.testFiles.length > 40) {
    return { recommended: 'nightly', rationale: `monorepo with ${discovery.testFiles.length} test files — full regression belongs on a nightly budget; PR runs stay selective` };
  }
  return { recommended: 'pr', rationale: 'standard repository shape — the PR policy with impact selection gives the smallest high-confidence set' };
}

export interface PlanData {
  contextSource: 'disk' | 'discovered';
  /** Verification label of the plan itself — a reasoning product, never an execution measurement. */
  label: VerificationLabel;
  requirements: Array<{ id: string; title: string; priority: string; criteria: number; source?: string }>;
  objectives: Array<{ area: ChangeArea; objective: string; basis: string }>;
  proposedLayers: Array<{ layer: string; rationale: string }>;
  policy: { recommended: OrchestrationPolicyName; rationale: string };
  openQuestions: string[];
  inventory: { testFiles: number; sourceFiles: number; testFrameworks: string[] };
}

async function run(ctx: CommandContext): Promise<CommandResult<PlanData>> {
  const root = resolve(process.env.THEQA_ROOT ?? ctx.cwd);
  const { config, path: configPath } = loadConfig(root);
  const discovery = discover(root);
  const discoveryAgent = new DiscoveryAgent(root, { config });

  const contextPath = join(root, '.theqa', 'context.json');
  let qaContext: QAContext;
  let contextSource: 'disk' | 'discovered';
  if (existsSync(contextPath)) {
    qaContext = parseContext(readFileSync(contextPath, 'utf8'));
    contextSource = 'disk';
  } else {
    qaContext = discoveryAgent.buildContext(discovery);
    contextSource = 'discovered';
  }
  void qaContext; // requirements + inventory drive the plan; the context proves the model loads

  // Only criteria-backed requirements drive the plan: a bare heading (level-1
  // or level-2) without list items is a document title, not a testable
  // requirement — reporting it would pad the plan with empty promises.
  const requirements = new RequirementsAgent(root).extract().filter((r) => r.criteria.length > 0);
  const objectives = objectivesFor(discovery.sourceFiles);
  const layers = proposedLayers(discovery);
  const policy = recommendPolicy(discovery, config);

  const openQuestions: string[] = [];
  if (configPath === undefined) {
    openQuestions.push('No theqa.config.json found — run `qa init` to pin critical paths and flows.');
  }
  if (discovery.stack.testFrameworks.length === 0) {
    openQuestions.push('No test framework detected — which runner should this plan target (vitest, jest, playwright, pytest)?');
  }
  if (requirements.length === 0) {
    openQuestions.push('No requirements extracted from README/docs — where is the specification of record?');
  }
  if (config.project.criticalFlows.length === 0) {
    openQuestions.push('No criticalFlows configured — which business flows must never regress?');
  }
  if (contextSource === 'discovered') {
    openQuestions.push('No .theqa/context.json on disk — run `qa discover --save-context` so every command shares one context.');
  }

  ctx.logger.banner('plan');
  ctx.logger.info(`context: ${contextSource === 'disk' ? '.theqa/context.json' : 'discovered in-memory'} · requirements: ${requirements.length}`);
  ctx.logger.info('');
  ctx.logger.info('Objectives (per risk area):');
  for (const o of objectives) ctx.logger.info(`  [${o.area}] ${o.objective}`);
  ctx.logger.info('');
  ctx.logger.info('Proposed test layers:');
  for (const l of layers) ctx.logger.info(`  ${l.layer.padEnd(12)} ${l.rationale}`);
  ctx.logger.info('');
  ctx.logger.info(`Execution policy: ${policy.recommended} — ${policy.rationale}`);
  ctx.logger.info('');
  ctx.logger.info(openQuestions.length > 0 ? 'Open questions:' : 'Open questions: none');
  for (const q of openQuestions) ctx.logger.info(`  ? ${q}`);

  return ok<PlanData>(
    {
      contextSource,
      label: 'INFERRED',
      requirements: requirements.map((r) => ({ id: r.id, title: r.title, priority: r.priority, criteria: r.criteria.length, source: r.source })),
      objectives,
      proposedLayers: layers,
      policy,
      openQuestions,
      inventory: {
        testFiles: discovery.testFiles.length,
        sourceFiles: discovery.sourceFiles.length,
        testFrameworks: discovery.stack.testFrameworks,
      },
    },
    'INFERRED',
    EXIT_OK,
  );
}

export const planCommand: CommandSpec = {
  name: 'plan',
  summary: 'produce a deterministic QA plan (objectives, layers, policy, open questions)',
  usage: 'qa plan [--json] [--dry-run]',
  positionals: [],
  flags: [],
  run,
};
