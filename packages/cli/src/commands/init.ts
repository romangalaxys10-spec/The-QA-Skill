import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { classifyAction, renderDefaultConfig } from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import { UsageError } from '../args.js';
import { flagBool, ok, rootFrom, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa init [dir] — LOW_RISK write (core classifyAction('init')).
 * Writes theqa.config.json via core renderDefaultConfig(projectName from dir
 * basename) and creates .theqa/ scaffolding. Refuses to overwrite an existing
 * config unless --force; --dry-run prints the plan without writing.
 */

interface InitData {
  actionPolicy: string;
  safety: string;
  root: string;
  configPath: string;
  projectName: string;
  directories: string[];
  wouldWrite: boolean;
  nextSteps: string[];
}

async function run(ctx: CommandContext): Promise<CommandResult<InitData>> {
  const root = rootFrom(ctx, 0);
  const force = flagBool(ctx, 'force');
  const policy = classifyAction('init');
  const configPath = join(root, 'theqa.config.json');
  const projectName = basename(root) || 'project';
  const dirs = [join(root, '.theqa'), join(root, '.theqa', 'artifacts')];

  if (existsSync(configPath) && !force) {
    throw new UsageError(
      `refusing to overwrite existing ${configPath}`,
      're-run with --force to overwrite, or edit theqa.config.json by hand',
    );
  }

  const content = renderDefaultConfig(projectName);
  if (!ctx.dryRun) {
    mkdirSync(root, { recursive: true });
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, content, 'utf8');
  }

  ctx.logger.banner(ctx.dryRun ? 'init — dry run (nothing written)' : 'init');
  ctx.logger.info(`project: ${projectName}`);
  ctx.logger.info(`config:  ${configPath}${ctx.dryRun ? ' (would write)' : ' (written)'}`);
  for (const dir of dirs) ctx.logger.info(`dir:     ${dir}${ctx.dryRun ? ' (would create)' : ' (created)'}`);
  ctx.logger.info(`safety:  ${policy.safety} — ${policy.rationale}`);
  ctx.logger.info('');
  ctx.logger.info('Next steps:');
  ctx.logger.info('  1. qa discover      — inventory the stack, test frameworks, and config files');
  ctx.logger.info('  2. qa doctor        — verify the environment (12 health checks)');

  return ok<InitData>(
    {
      actionPolicy: policy.action,
      safety: policy.safety,
      root,
      configPath,
      projectName,
      directories: dirs,
      wouldWrite: ctx.dryRun,
      nextSteps: ['qa discover', 'qa doctor'],
    },
    ctx.dryRun ? 'NOT_RUN' : 'OBSERVED',
    EXIT_OK,
  );
}

export const initCommand: CommandSpec = {
  name: 'init',
  summary: 'write theqa.config.json + .theqa/ scaffolding into a project',
  usage: 'qa init [dir] [--force] [--dry-run]',
  positionals: ['[dir]'],
  flags: [
    { name: 'force', value: false, description: 'overwrite an existing theqa.config.json' },
  ],
  run,
};
