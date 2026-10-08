import { join } from 'node:path';
import {
  DecisionEngine,
  RouteStats,
  ScorerRegistry,
  defaultTargets,
  discoverPlugins,
  targetsWithPlugins,
} from '@the-qa-skill/xroutelm';
import type { CommandSpec } from '../args.js';
import { EXIT_OK, flagString, ok, rootFrom } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa route — xRouteLM task routing (read-only).
 *
 *   qa route "flaky login test passes on second attempt" [--json] [--stats]
 *
 * Routes a task description to the QA engine that should own it using the
 * xRouteLM System One scorer: probabilities per target, a fallback chain,
 * recorded lexical evidence, plugin-contributed targets, and (when stats
 * exist) success-rate learning. This is Jev-style model routing, native to
 * the QA OS — no LLM call, no macOS requirement, no external service.
 */

async function run(ctx: CommandContext): Promise<CommandResult> {
  const task = flagString(ctx, 'task') ?? ctx.positionals.join(' ');
  if (task.trim().length === 0) {
    throw new Error('provide a task description: qa route "fix flaky checkout test"');
  }
  const root = rootFrom(ctx);
  const registry = ScorerRegistry.withDefaults();
  const engine = new DecisionEngine(registry, undefined); // routing from the CLI is stateless; the harness journals its own runs
  const plugins = discoverPlugins(root);
  const merged = targetsWithPlugins(defaultTargets(), plugins, root);

  const statsPath = flagString(ctx, 'stats') ?? join(root, '.xroutelm', 'route-stats.jsonl');
  const stats = new RouteStats(statsPath);
  const targets = stats.apply(merged.targets);
  const decision = await engine.route(task, targets);

  const data = {
    task,
    decision,
    pluginTargets: (merged.targets.length - defaultTargets().length),
    pluginErrors: merged.errors,
    learning: stats.rates().size > 0 ? Object.fromEntries(stats.rates()) : null,
  };

  if (ctx.json) {
    return ok(data, decision.label, EXIT_OK);
  }

  ctx.logger.banner('route (xRouteLM)');
  ctx.logger.info(`task: ${task.replace(/\s+/g, ' ').trim()}`);
  ctx.logger.info(`→ ${decision.target} (confidence ${decision.confidence}, scorer ${decision.scorer})`);
  ctx.logger.info(`fallback: ${decision.fallback.join(' → ') || 'none'}`);
  for (const m of decision.evidence.matches.slice(0, 4)) {
    ctx.logger.info(`  + ${m.token} (${m.source})`);
  }
  if (merged.errors.length > 0) {
    for (const e of merged.errors) ctx.logger.info(`plugin error: ${e}`);
  }
  return ok(data, decision.label, EXIT_OK);
}

export const routeCommand: CommandSpec = {
  name: 'route',
  summary: 'route a task to the right QA engine with the xRouteLM System One scorer (read-only)',
  usage: 'qa route "<task description>" [--stats <file>] [--json]',
  positionals: ['task'],
  flags: [
    { name: 'task', value: true, description: 'Task description (positionals also work)' },
    { name: 'stats', value: true, description: 'Route-stats JSONL for success-rate learning (default .xroutelm/route-stats.jsonl)' },
  ],
  run,
};
