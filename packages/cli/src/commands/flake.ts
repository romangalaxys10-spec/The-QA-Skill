import type { FlakeAssessment } from '@the-qa-skill/core';
import { scoreFlake, suiteFlakeHealth } from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import {
  artifactsDirFor, flagString, loadFlakeInputs, loadProject, ok, rootFrom, EXIT_FINDINGS, EXIT_OK,
} from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa flake [--history <file>] — flake intelligence (read-only).
 *
 * Reads FlakeInput[] JSON or a TestEvent[] history file (events are grouped
 * by testId: chronological outcomes, retryCount from retryIndex>0 events,
 * distinct failing environments/browsers). Defaults to scanning
 * events.json / flake-history.json under the artifacts directory.
 *
 * Formula (documented in core): score = 40×failRate + 25×retrySignal +
 * 20×intermittency + 15×envSpread. Bands: <20 stable · <45 suspect · <70
 * flaky · ≥70 critical_flaky. Exit 1 when any critical_flaky is present.
 */

export interface FlakeData {
  assessments: FlakeAssessment[];
  suiteHealth: { score: number; critical: number; flaky: number };
  source?: string;
  shape: 'flake-inputs' | 'events' | 'none';
}

async function run(ctx: CommandContext): Promise<CommandResult<FlakeData>> {
  const root = rootFrom(ctx);
  const config = loadProject(root);
  const loaded = loadFlakeInputs(root, flagString(ctx, 'history'), artifactsDirFor(root));
  const assessments = loaded.inputs.map(scoreFlake);
  const health = suiteFlakeHealth(assessments);

  ctx.logger.banner('flake');
  if (assessments.length === 0) {
    ctx.logger.info('No flake history found.');
    ctx.logger.info(`Pass --history <file> or write events.json / flake-history.json under ${config.paths.artifacts}.`);
    return ok<FlakeData>({ assessments: [], suiteHealth: health, shape: loaded.shape, ...(loaded.source !== undefined ? { source: loaded.source } : {}) }, 'NOT_RUN', EXIT_OK);
  }

  ctx.logger.info(`score = 40×failRate + 25×retrySignal + 20×intermittency + 15×envSpread (${loaded.shape === 'events' ? 'mapped from TestEvents' : 'FlakeInput records'})`);
  ctx.logger.info('');
  ctx.logger.info(`  ${'testId'.padEnd(40)} ${'score'.padStart(5)}  verdict           failRate`);
  for (const a of assessments) {
    ctx.logger.info(`  ${a.testId.padEnd(40)} ${String(a.score).padStart(5)}  ${a.verdict.padEnd(16)}  ${(a.failRate * 100).toFixed(0)}%`);
    for (const reason of a.reasons.slice(0, 2)) ctx.logger.info(`      · ${reason}`);
  }
  ctx.logger.info('');
  ctx.logger.info(`Suite flake health: ${health.score}/100 · critical: ${health.critical} · flaky: ${health.flaky}`);

  const exit = health.critical > 0 ? EXIT_FINDINGS : EXIT_OK;
  return {
    ok: exit === EXIT_OK,
    data: {
      assessments,
      suiteHealth: health,
      shape: loaded.shape,
      ...(loaded.source !== undefined ? { source: loaded.source } : {}),
    },
    label: assessments.length > 0 ? assessments[0]!.label : 'NOT_RUN',
    exitCode: exit,
  };
}

export const flakeCommand: CommandSpec = {
  name: 'flake',
  summary: 'score flakiness from run history with the documented formula (read-only)',
  usage: 'qa flake [--history <file>] [--json] [--verbose]',
  positionals: [],
  flags: [
    { name: 'history', value: true, description: 'FlakeInput[] or TestEvent[] JSON file' },
  ],
  run,
};
