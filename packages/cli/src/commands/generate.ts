import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { classifyAction } from '@the-qa-skill/core';
import type { ChangeArea } from '@the-qa-skill/core';
import { GenerationAgent } from '@the-qa-skill/agents';
import type { FeatureSpec, ScaffoldResult, TestPlan } from '@the-qa-skill/agents';
import type { CommandSpec } from '../args.js';
import { UsageError } from '../args.js';
import { flagString, loadProject, ok, rootFrom, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa generate --spec <file> [--out dir] [--force] [--dry-run] — deterministic
 * test design from a feature spec (LOW_RISK write under tests/generated/ by
 * default; classifyAction('generate')).
 *
 * FeatureSpec shape (JSON):
 *   { name: string, description?: string, acceptanceCriteria: string[],
 *     businessRules?: string[], area?: ChangeArea }
 *
 * `GenerationAgent.plan()` enumerates positive/negative/boundary cases plus
 * spec-level heuristics; `scaffold()` writes intentionally-skipped scaffold
 * files. Dry-run lists the would-write files with their byte sizes; existing
 * files are never overwritten without --force.
 */

const AREAS: ReadonlySet<string> = new Set(['ui', 'api', 'db', 'auth', 'payment', 'config', 'test', 'docs', 'infra', 'unknown']);

export function parseSpec(raw: unknown, source: string): FeatureSpec {
  if (raw === null || typeof raw !== 'object') {
    throw new UsageError(`spec ${source} is not a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.trim().length === 0) {
    throw new UsageError(`spec ${source} is missing required string field "name"`);
  }
  if (!Array.isArray(o.acceptanceCriteria) || o.acceptanceCriteria.some((c) => typeof c !== 'string')) {
    throw new UsageError(`spec ${source} field "acceptanceCriteria" must be an array of strings`);
  }
  if (o.businessRules !== undefined && (!Array.isArray(o.businessRules) || o.businessRules.some((c) => typeof c !== 'string'))) {
    throw new UsageError(`spec ${source} field "businessRules" must be an array of strings`);
  }
  if (o.area !== undefined && (typeof o.area !== 'string' || !AREAS.has(o.area))) {
    throw new UsageError(`spec ${source} field "area" must be one of: ${[...AREAS].join(', ')}`);
  }
  return {
    name: o.name,
    description: typeof o.description === 'string' ? o.description : undefined,
    acceptanceCriteria: o.acceptanceCriteria as string[],
    businessRules: o.businessRules as string[] | undefined,
    area: o.area as ChangeArea | undefined,
  };
}

export function readSpecFile(path: string, root: string): FeatureSpec {
  const abs = isAbsolute(path) ? path : join(root, path);
  if (!existsSync(abs)) {
    throw new UsageError(`spec file does not exist: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new UsageError(`spec file ${path} is not valid JSON: ${(e as Error).message}`);
  }
  return parseSpec(raw, path);
}

export interface GenerateData {
  actionPolicy: string;
  safety: string;
  spec: string;
  feature: string;
  plan: { total: number; byCategory: Record<string, number>; byLayer: Record<string, number> };
  heuristicNotes: string[];
  outDir: string;
  dryRun: boolean;
  files: ScaffoldResult[];
}

async function run(ctx: CommandContext): Promise<CommandResult<GenerateData>> {
  const root = rootFrom(ctx);
  const specPath = flagString(ctx, 'spec');
  if (specPath === undefined) {
    throw new UsageError('generate requires --spec <file>', 'the file is a FeatureSpec JSON: { name, acceptanceCriteria: string[], area? }');
  }
  const spec = readSpecFile(specPath, root);
  const outDir = resolve(root, flagString(ctx, 'out') ?? join('tests', 'generated'));
  const force = ctx.flags['force'] === true;
  const policy = classifyAction('generate');

  const agent = new GenerationAgent(root, { config: loadProject(root) });
  const plan: TestPlan = agent.plan(spec);
  const files = agent.scaffold(plan, outDir, { dryRun: ctx.dryRun, force });

  ctx.logger.banner(ctx.dryRun ? 'generate — dry run (nothing written)' : 'generate');
  ctx.logger.info(`spec:    ${specPath} · feature: ${spec.name}`);
  ctx.logger.info(`safety:  ${policy.safety} — ${policy.rationale}`);
  ctx.logger.info('');
  ctx.logger.info(`Plan: ${plan.summary.total} case(s) · label ${plan.label}`);
  const cats = Object.entries(plan.summary.byCategory).map(([k, v]) => `${k}×${v}`).join(', ');
  const layers = Object.entries(plan.summary.byLayer).map(([k, v]) => `${k}×${v}`).join(', ');
  ctx.logger.info(`  by category: ${cats}`);
  ctx.logger.info(`  by layer:    ${layers}`);
  ctx.logger.info('');
  ctx.logger.info('Heuristics fired:');
  for (const note of plan.heuristicNotes) ctx.logger.info(`  · ${note}`);
  ctx.logger.info('');
  ctx.logger.info(ctx.dryRun ? 'Would write:' : 'Files:');
  for (const f of files) {
    const abs = isAbsolute(f.path) ? f.path : join(outDir, f.path);
    ctx.logger.info(`  [${f.action}] ${abs}${f.bytes > 0 ? ` (${f.bytes} bytes)` : ''}`);
    if (f.action === 'skipped') ctx.logger.info(`      exists — re-run with --force to overwrite`);
  }

  return ok<GenerateData>(
    {
      actionPolicy: policy.action,
      safety: policy.safety,
      spec: specPath,
      feature: plan.feature,
      plan: plan.summary,
      heuristicNotes: plan.heuristicNotes,
      outDir,
      dryRun: ctx.dryRun,
      files,
    },
    ctx.dryRun ? 'NOT_RUN' : 'INFERRED',
    EXIT_OK,
  );
}

export const generateCommand: CommandSpec = {
  name: 'generate',
  summary: 'design + scaffold tests from a feature spec (writes under tests/generated/)',
  usage: 'qa generate --spec <file> [--out dir] [--force] [--dry-run]',
  positionals: [],
  flags: [
    { name: 'spec', value: true, description: 'feature spec JSON file (required)' },
    { name: 'out', value: true, description: 'output directory (default tests/generated)' },
    { name: 'force', value: false, description: 'overwrite existing scaffold files' },
  ],
  run,
};
