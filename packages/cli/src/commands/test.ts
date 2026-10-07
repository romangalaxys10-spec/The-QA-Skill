import { isGitRepo } from '@the-qa-skill/core';
import { ExecutionAgent, DefaultRunnerAdapter } from '@the-qa-skill/agents';
import type { RunnerAdapter } from '@the-qa-skill/agents';
import type { SelectionResult } from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import { UsageError } from '../args.js';
import { artifactsDirFor, flagString, loadProject, ok, rootFrom, EXIT_FINDINGS, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';
import { computeImpact } from './impact.js';
import { DEFAULT_RANGE } from './risk.js';

/**
 * qa test [--policy pr|pre_merge|nightly|release] [--suite glob] [--dry-run]
 *
 * Executes the impact-selected set (or the whole suite outside a git repo)
 * through ExecutionAgent with an injected RunnerAdapter. Evidence bundles are
 * written by the agents layer under config.paths.artifacts (the execution
 * root is the artifacts directory; framework detection and the runner cwd are
 * re-anchored to the project root by the wrapper adapter below). Dry-run
 * plans commands and spawns nothing.
 *
 * Exit codes: 0 = no failures; 1 = failed/timedout events present.
 */

const POLICIES: ReadonlySet<string> = new Set(['pr', 'pre_merge', 'nightly', 'release']);

/**
 * Adapter wrapper: framework detection and command execution stay anchored to
 * the project root, while the ExecutionAgent's artifact root (constructor
 * root) is the configured artifacts directory — so evidence bundles land
 * under <root>/<paths.artifacts>/run-<date>/<testId>/ per the bundle layout.
 */
class RootAnchoredAdapter implements RunnerAdapter {
  constructor(
    private readonly inner: RunnerAdapter,
    private readonly projectRoot: string,
  ) {}

  frameworksAt(_root: string): string[] {
    return this.inner.frameworksAt(this.projectRoot);
  }

  run(runner: string, command: string, args: string[], _cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.inner.run(runner, command, args, this.projectRoot, timeoutMs);
  }

  parse(runner: string, raw: string) {
    return this.inner.parse(runner, raw);
  }
}

export interface FailureSummary {
  testId: string;
  name: string;
  errorType?: string;
  errorMessage?: string;
}

export interface TestData {
  runId: string;
  dryRun: boolean;
  policy: string;
  selectionUsed: boolean;
  selectedCount: number;
  plannedCommands: Array<{ runner: string; command: string; args: string[] }>;
  events: Array<Record<string, unknown>>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    timedout: number;
    notRun: number;
    failures: FailureSummary[];
  };
  bundles: Array<{ testId: string; path: string }>;
  artifactsDir: string;
}

export function summarizeEvents(events: Array<Record<string, unknown>>): TestData['summary'] {
  const count = (status: string): number => events.filter((e) => e['status'] === status).length;
  const failures: FailureSummary[] = events
    .filter((e) => e['status'] === 'failed' || e['status'] === 'timedout')
    .map((e) => ({
      testId: String(e['testId'] ?? ''),
      name: String(e['name'] ?? ''),
      errorType: typeof e['errorType'] === 'string' ? e['errorType'] : undefined,
      errorMessage: typeof e['errorMessage'] === 'string' ? e['errorMessage'].split('\n')[0]?.slice(0, 200) : undefined,
    }));
  return {
    total: events.length,
    passed: count('passed'),
    failed: count('failed'),
    skipped: count('skipped'),
    timedout: count('timedout'),
    notRun: count('not_run'),
    failures,
  };
}

async function run(ctx: CommandContext): Promise<CommandResult<TestData>> {
  const root = rootFrom(ctx);
  const config = loadProject(root);
  const policy = flagString(ctx, 'policy') ?? 'pr';
  if (!POLICIES.has(policy)) {
    throw new UsageError(`unknown policy "${policy}"`, 'policies: pr, pre_merge, nightly, release');
  }
  const suite = flagString(ctx, 'suite');

  // Selection from the impact pipeline; outside a git repo (or when the diff
  // cannot be computed) the whole suite runs (selection null).
  let selection: SelectionResult | null = null;
  let selectedCount = 0;
  if (await isGitRepo(root)) {
    try {
      const impact = await computeImpact(root, DEFAULT_RANGE, { suite });
      selection = impact.selection;
      selectedCount = impact.selection.selected.length;
    } catch (e) {
      ctx.logger.warn(`impact selection failed (${(e as Error).message}) — running the whole suite`);
    }
  } else if (suite !== undefined) {
    ctx.logger.warn('--suite outside a git repository has no selection to filter — running the whole suite');
  }

  const executionRoot = artifactsDirFor(root);
  const adapter = new RootAnchoredAdapter(new DefaultRunnerAdapter(), root);
  const agent = new ExecutionAgent(executionRoot, { config, adapter: adapter as RunnerAdapter });
  const outcome = await agent.execute(selection, {
    policy: policy as 'pr' | 'pre_merge' | 'nightly' | 'release',
    dryRun: ctx.dryRun,
  });

  const events = outcome.events.map((e) => ({ ...e })) as Array<Record<string, unknown>>;
  const summary = summarizeEvents(events);

  ctx.logger.banner(ctx.dryRun ? 'test — dry run (nothing spawned)' : `test — policy ${policy}`);
  ctx.logger.info(`run: ${outcome.runId} · selection: ${selection ? `${selectedCount} selected` : 'none (whole suite)'}`);
  ctx.logger.info('');
  ctx.logger.info('Planned commands:');
  for (const cmd of outcome.plannedCommands) {
    ctx.logger.info(`  [${cmd.runner}] ${cmd.command} ${cmd.args.join(' ')}`);
  }
  if (ctx.dryRun) {
    return ok<TestData>(
      {
        runId: outcome.runId,
        dryRun: true,
        policy,
        selectionUsed: selection !== null,
        selectedCount,
        plannedCommands: outcome.plannedCommands,
        events: [],
        summary: summarizeEvents([]),
        bundles: [],
        artifactsDir: executionRoot,
      },
      'NOT_RUN',
      EXIT_OK,
    );
  }

  ctx.logger.info('');
  ctx.logger.info(`Events: ${summary.total} total — ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.timedout} timedout`);
  if (summary.failures.length > 0) {
    ctx.logger.info('');
    ctx.logger.info('Failures:');
    for (const f of summary.failures) {
      ctx.logger.info(`  ✘ ${f.name} (${f.testId})${f.errorType ? ` · ${f.errorType}` : ''}`);
      if (f.errorMessage) ctx.logger.info(`      ${f.errorMessage}`);
    }
  }
  if (outcome.bundles.length > 0) {
    ctx.logger.info('');
    ctx.logger.info(`Evidence bundles: ${outcome.bundles.length} (under ${executionRoot})`);
    for (const b of outcome.bundles) ctx.logger.info(`  ${b.testId} → ${b.path}`);
  }

  const exit = summary.failed + summary.timedout > 0 ? EXIT_FINDINGS : EXIT_OK;
  return {
    ok: exit === EXIT_OK,
    data: {
      runId: outcome.runId,
      dryRun: false,
      policy,
      selectionUsed: selection !== null,
      selectedCount,
      plannedCommands: outcome.plannedCommands,
      events,
      summary,
      bundles: outcome.bundles,
      artifactsDir: executionRoot,
    },
    label: 'OBSERVED',
    exitCode: exit,
  };
}

export const testCommand: CommandSpec = {
  name: 'test',
  summary: 'execute the impact-selected suites and collect evidence bundles',
  usage: 'qa test [--policy pr|pre_merge|nightly|release] [--suite glob] [--dry-run]',
  positionals: [],
  flags: [
    { name: 'policy', value: true, description: 'execution policy: pr (default) | pre_merge | nightly | release' },
    { name: 'suite', value: true, description: 'glob filter over selected test files' },
  ],
  run,
};
