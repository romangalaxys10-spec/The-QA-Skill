import { isGitRepo } from '@the-qa-skill/core';
import { RiskAgent } from '@the-qa-skill/agents';
import type { AssessResult } from '@the-qa-skill/agents';
import type { CommandSpec } from '../args.js';
import { UsageError } from '../args.js';
import { flagString, loadProject, ok, rootFrom, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa risk [--range a..b] — change-set risk assessment (read-only).
 * Prints the assessment explanation verbatim plus the factor table. JSON is
 * the full RiskAssessment + changedFiles + routing. Not a git repository →
 * exit 2 with a hint (there is no change set to assess).
 */

export const DEFAULT_RANGE = 'HEAD~1..HEAD';
/** Empty-tree object id — lets first-commit repos (no HEAD~1) still produce a diff. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface RiskData extends AssessResult {
  range: string;
  root: string;
}

/** Assess `range`, falling back to the empty tree for first-commit repos. */
export async function assessWithFallback(root: string, range: string): Promise<AssessResult> {
  const agent = new RiskAgent(root, { config: loadProject(root) });
  if (range === DEFAULT_RANGE) {
    try {
      return await agent.assess(range);
    } catch {
      return agent.assess(`${EMPTY_TREE}..HEAD`);
    }
  }
  return agent.assess(range);
}

/** Guard shared by risk/impact: a diff-based command needs a git repository. */
export async function requireGitRepo(root: string, command: string): Promise<void> {
  if (!(await isGitRepo(root))) {
    throw new UsageError(
      `${command} needs a git repository — "${root}" is not one`,
      'cd into the project root (or set THEQA_ROOT) and ensure `git rev-parse --is-inside-work-tree` succeeds',
    );
  }
}

async function run(ctx: CommandContext): Promise<CommandResult<RiskData>> {
  const root = rootFrom(ctx);
  await requireGitRepo(root, 'risk');
  const range = flagString(ctx, 'range') ?? DEFAULT_RANGE;
  const result = await assessWithFallback(root, range);

  ctx.logger.banner(`risk — ${range}`);
  ctx.logger.info(result.assessment.explanation);
  ctx.logger.info('');
  ctx.logger.info('Factors:');
  for (const f of result.assessment.factors) {
    ctx.logger.info(`  ${f.factor.padEnd(22)} value ${f.value.toFixed(2)} × weight ${f.weight.toFixed(2)} → +${f.contribution.toFixed(1)}`);
    for (const reason of f.reasons.slice(0, 2)) ctx.logger.info(`    · ${reason}`);
  }
  ctx.logger.info('');
  const triggered = result.routing.boundarySignals;
  ctx.logger.info(`changed files: ${result.changedFiles.length}${triggered.length > 0 ? ` · boundary signals: ${triggered.join(', ')}` : ''}`);

  return ok<RiskData>({ ...result, range, root }, result.assessment.label, EXIT_OK);
}

export const riskCommand: CommandSpec = {
  name: 'risk',
  summary: 'score change-set risk with the documented 8-factor engine (read-only)',
  usage: 'qa risk [--range a..b] [--json] [--verbose]',
  positionals: [],
  flags: [
    { name: 'range', value: true, description: `diff range to assess (default ${DEFAULT_RANGE})` },
  ],
  run,
};
