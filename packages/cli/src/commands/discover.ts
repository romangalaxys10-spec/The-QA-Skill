import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serializeContext } from '@the-qa-skill/core';
import { DiscoveryAgent } from '@the-qa-skill/agents';
import type { CommandSpec } from '../args.js';
import { flagBool, ok, rootFrom, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa discover [dir] — read-only stack + test inventory discovery.
 * Writes nothing by default. `--save-context` builds the validated QAContext
 * (via DiscoveryAgent.buildContext) and serializes it to .theqa/context.json
 * (config.paths.context).
 */

interface DiscoverData {
  root: string;
  stack: {
    language: string;
    framework?: string;
    packageManager?: string;
    testFrameworks: string[];
    ciSystems: string[];
    monorepo: boolean;
    signals: string[];
  };
  counts: { testFiles: number; sourceFiles: number; configFiles: number };
  testFiles: Array<{ filePath: string; framework: string; layer: string; estimatedCases: number }>;
  configFiles: string[];
  contextSaved?: string;
}

async function run(ctx: CommandContext): Promise<CommandResult<DiscoverData>> {
  const root = rootFrom(ctx, 0);
  const agent = new DiscoveryAgent(root);
  const discovery = await agent.discover();

  ctx.logger.banner('discover');
  ctx.logger.info(`root: ${discovery.root}`);
  ctx.logger.info('');
  ctx.logger.info('Stack signals:');
  for (const signal of discovery.stack.signals) ctx.logger.info(`  · ${signal}`);
  ctx.logger.info('');
  ctx.logger.info(`language: ${discovery.stack.language}${discovery.stack.framework ? ` · framework: ${discovery.stack.framework}` : ''}${discovery.stack.packageManager ? ` · packages: ${discovery.stack.packageManager}` : ''}`);
  ctx.logger.info(`test frameworks: ${discovery.stack.testFrameworks.length > 0 ? discovery.stack.testFrameworks.join(', ') : '(none detected)'}`);
  ctx.logger.info(`ci systems: ${discovery.stack.ciSystems.length > 0 ? discovery.stack.ciSystems.join(', ') : '(none detected)'}`);
  ctx.logger.info(`monorepo: ${String(discovery.stack.monorepo)}`);
  ctx.logger.info('');
  ctx.logger.info(`test files:   ${discovery.testFiles.length}`);
  ctx.logger.info(`source files: ${discovery.sourceFiles.length}`);
  ctx.logger.info(`config files: ${discovery.configFiles.length > 0 ? discovery.configFiles.join(', ') : '(none)'}`);
  const estimatedCases = discovery.testFiles.reduce((a, f) => a + f.estimatedCases, 0);
  if (discovery.testFiles.length > 0) {
    ctx.logger.info('');
    ctx.logger.info('Inventory:');
    for (const f of discovery.testFiles) {
      ctx.logger.info(`  ${f.filePath.padEnd(48)} ${f.framework.padEnd(10)} ${f.layer.padEnd(12)} ~${f.estimatedCases} case(s)`);
    }
    ctx.logger.info(`  total estimated cases: ~${estimatedCases}`);
  }

  let contextSaved: string | undefined;
  if (flagBool(ctx, 'save-context')) {
    const contextPath = join(root, '.theqa', 'context.json');
    const qaContext = agent.buildContext(discovery);
    if (!ctx.dryRun) {
      mkdirSync(dirname(contextPath), { recursive: true });
      writeFileSync(contextPath, serializeContext(qaContext), 'utf8');
    }
    contextSaved = contextPath;
    ctx.logger.info('');
    ctx.logger.info(`context ${ctx.dryRun ? 'would be written' : 'written'}: ${contextPath}`);
  }

  return ok<DiscoverData>(
    {
      root: discovery.root,
      stack: discovery.stack,
      counts: {
        testFiles: discovery.testFiles.length,
        sourceFiles: discovery.sourceFiles.length,
        configFiles: discovery.configFiles.length,
      },
      testFiles: discovery.testFiles.map((f) => ({ filePath: f.filePath, framework: f.framework, layer: f.layer, estimatedCases: f.estimatedCases })),
      configFiles: discovery.configFiles,
      contextSaved,
    },
    discovery.label,
    EXIT_OK,
  );
}

export const discoverCommand: CommandSpec = {
  name: 'discover',
  summary: 'detect stack signals, test frameworks, and inventory (read-only)',
  usage: 'qa discover [dir] [--save-context] [--dry-run]',
  positionals: ['[dir]'],
  flags: [
    { name: 'save-context', value: false, description: 'write the validated QAContext to .theqa/context.json' },
  ],
  run,
};
