import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LearningStore, Logger, SelectionResult, TestEvent } from '@the-qa-skill/core';
import { runIdFor, writeEvidenceBundle } from '@the-qa-skill/core';
import type { Runner } from './runner.js';
import { buildEvent } from './runner.js';
import type { PlannedCommand } from './runner.js';
import type { RunnerContext } from './types.js';

/** Default hard timeout per runner process (10 minutes). */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;

/** Cap on captured process output to avoid unbounded memory growth. */
const MAX_CAPTURE_CHARS = 64 * 1024 * 1024;

/**
 * Environment variables forwarded to spawned runners. This is an ALLOWLIST —
 * the child never receives the full `process.env`, so CI tokens, cloud
 * credentials, and other secrets cannot leak into test processes or the
 * evidence they produce (golden rule: secret hygiene).
 */
const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'LANG', 'TZ', 'CI', 'NODE_ENV']);

/** Result of one spawned runner process. */
export interface SpawnResult {
  /** Exit code (-1 when the process could not be spawned). */
  code: number;
  stdout: string;
  stderr: string;
  /** True when the hard timeout killed the child. */
  timedOut: boolean;
}

/** Injectable spawn seam — tests never spawn real processes. */
export type SpawnImpl = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<SpawnResult>;

/** Production spawn implementation: node:child_process, NO shell. */
export function defaultSpawnImpl(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead — nothing to do
      }
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_CHARS) stdout += chunk.toString('utf8');
      else truncated = true;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_CHARS) stderr += chunk.toString('utf8');
      else truncated = true;
    });

    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (truncated) stderr += '\n[captured output truncated — exceeded capture limit]';
      resolve({ code, stdout, stderr, timedOut });
    };

    child.on('error', (err: Error) => {
      stderr += `\nspawn error: ${err.message}`;
      settle(-1);
    });
    child.on('close', (code) => settle(code ?? -1));
  });
}

/** One evidence bundle produced for a failed/timedout test. */
export interface EvidenceBundleRecord {
  testId: string;
  path: string;
  files: string[];
}

/** The executor's terminal output for one run. */
export interface ExecutionOutcome {
  runId: string;
  events: TestEvent[];
  /** One bundle per failed/timedout event. */
  bundles: EvidenceBundleRecord[];
  dryRun: boolean;
  /** Ids of runners actually executed (or planned, in a dry run). */
  runnerIdsUsed: string[];
}

/** Constructor options for {@link RunExecutor}. */
export interface RunExecutorOptions {
  runners: Runner[];
  /** Root directory for evidence bundles (and the artifacts/ scratch space). */
  evidenceRoot: string;
  /** Optional learning store — failures are recorded for defect history. */
  learning?: LearningStore;
  logger?: Logger;
  /** Process seam. Defaults to a real no-shell spawn; tests inject fakes. */
  spawnImpl?: SpawnImpl;
  /** Hard timeout override; default comes from QA_RUN_TIMEOUT_MS or 600000. */
  timeoutMs?: number;
}

/**
 * Execute runners against a project and turn their raw output into core
 * TestEvents plus evidence bundles.
 *
 * Guarantees:
 * - Runners are spawned without a shell (no injection).
 * - The child environment is an allowlist (PATH/HOME/LANG/TZ/CI/NODE_ENV +
 *   CI_* + QA_*) — never the whole process.env.
 * - A hard timeout (QA_RUN_TIMEOUT_MS, default 600000) kills the child;
 *   tests that were still running are honestly marked 'timedout'.
 * - Every failed/timedout event gets an evidence bundle with the scrubbed
 *   captured output.
 * - Dry runs record planned commands, never spawn, and emit 'not_run'
 *   synthetic events for the selected tests.
 */
export class RunExecutor {
  private readonly spawnImpl: SpawnImpl;
  private readonly timeoutOverride?: number;

  constructor(private readonly opts: RunExecutorOptions) {
    this.spawnImpl = opts.spawnImpl ?? defaultSpawnImpl;
    this.timeoutOverride = opts.timeoutMs;
  }

  /** Execute (or plan) a run. Never throws on runner failure — failures land in events/bundles. */
  async execute(ctx: RunnerContext, selection?: SelectionResult): Promise<ExecutionOutcome> {
    const runId = runIdFor('run');
    const logger = this.opts.logger;
    const artifactsDir = join(this.opts.evidenceRoot, 'artifacts');

    // 1. Detect and filter runners. With a selection, only runners whose
    //    framework appears in the selection execute; otherwise all detected.
    const wantedFrameworks = selection ? new Set(selection.selected.map((s) => s.test.framework)) : undefined;
    const active: Runner[] = [];
    for (const runner of this.opts.runners) {
      let detected = false;
      try {
        detected = runner.detect(ctx.root);
      } catch (err) {
        logger?.warn(`runner '${runner.id}' detection failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!detected) continue;
      if (wantedFrameworks && !wantedFrameworks.has(runner.framework)) continue;
      active.push(runner);
    }

    const runnable = active.filter((r) => !r.planOnly);
    for (const runner of active.filter((r) => r.planOnly)) {
      logger?.warn(`runner '${runner.id}' is plan-only — it is never executed by RunExecutor`);
    }

    // 2. Dry run: plan commands, spawn nothing, mark selected tests not_run.
    if (ctx.dryRun) {
      const planned = runnable.map((runner) => {
        const cmd = runner.buildCommand(ctx, { artifactsDir });
        return { runnerId: runner.id, command: cmd.command, args: cmd.args, reporterHint: cmd.reporterHint };
      });
      this.recordPlan(runId, planned);
      const events: TestEvent[] = (selection?.selected ?? []).map((sel) =>
        buildEvent({
          runId,
          ctx,
          framework: sel.test.framework,
          filePath: sel.test.filePath,
          name: sel.test.name,
          status: 'not_run',
          durationMs: 0,
        }),
      );
      logger?.info(
        `dry run: ${planned.length} command(s) planned, ${events.length} test(s) marked not_run, nothing executed`,
      );
      return { runId, events, bundles: [], dryRun: true, runnerIdsUsed: planned.map((p) => p.runnerId) };
    }

    // 3. Real execution.
    const events: TestEvent[] = [];
    const bundles: EvidenceBundleRecord[] = [];
    const runnerIdsUsed: string[] = [];
    const timeoutMs = this.resolveTimeout();
    const env = buildChildEnv();
    /** testId → number of bundles already written for it (retry collision guard). */
    const bundleCountByTestId = new Map<string, number>();

    for (const runner of runnable) {
      runnerIdsUsed.push(runner.id);
      let cmd: PlannedCommand;
      try {
        cmd = runner.buildCommand(ctx, { artifactsDir });
      } catch (err) {
        logger?.warn(`runner '${runner.id}' could not build a command: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      logger?.info(`[${runner.id}] ${cmd.command} ${cmd.args.join(' ')}`);
      mkdirSync(artifactsDir, { recursive: true });

      let result: SpawnResult;
      try {
        result = await this.spawnImpl(cmd.command, cmd.args, { cwd: ctx.root, env, timeoutMs });
      } catch (err) {
        logger?.error(`runner '${runner.id}' spawn failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (result.timedOut) {
        logger?.warn(`runner '${runner.id}' exceeded the ${timeoutMs}ms hard timeout — child killed`);
      }

      // File-reporting runners (pytest, k6) read their artifact; the rest parse stdout.
      let raw: string | null = result.stdout;
      if (runner.readResult) {
        try {
          raw = runner.readResult(ctx, artifactsDir);
        } catch (err) {
          logger?.warn(`runner '${runner.id}' result file read failed: ${err instanceof Error ? err.message : String(err)}`);
          raw = null;
        }
      }

      let parsed: TestEvent[] = [];
      if (raw !== null && raw !== undefined && raw.length > 0) {
        try {
          parsed = runner.parseOutput(raw, ctx);
        } catch (err) {
          logger?.warn(`runner '${runner.id}' output parse failed: ${err instanceof Error ? err.message : String(err)}`);
          parsed = [];
        }
      } else if (!result.timedOut) {
        logger?.warn(`runner '${runner.id}' produced no parsable output (exit code ${result.code})`);
      }

      // One run, one runId: normalize every event onto this execution.
      const runnerEvents: TestEvent[] = [];
      for (const e of parsed) {
        e.runId = runId;
        e.environment = ctx.environment;
        if (ctx.commit) e.commit = ctx.commit;
        if (ctx.branch) e.branch = ctx.branch;
        events.push(e);
        runnerEvents.push(e);
      }

      // Timeout honesty: tests that never reached a terminal state are
      // marked 'timedout', never left out of the report.
      if (result.timedOut) {
        const finished = new Set(parsed.map((e) => e.testId));
        if (selection) {
          for (const sel of selection.selected) {
            if (sel.test.framework !== runner.framework || finished.has(sel.test.testId)) continue;
            const timedOutEvent = buildEvent({
              runId,
              ctx,
              framework: runner.framework,
              filePath: sel.test.filePath,
              name: sel.test.name,
              status: 'timedout',
              durationMs: timeoutMs,
              errorMessage: `test did not finish before the ${timeoutMs}ms hard timeout`,
            });
            events.push(timedOutEvent);
            runnerEvents.push(timedOutEvent);
          }
        } else {
          const timedOutEvent = buildEvent({
            runId,
            ctx,
            framework: runner.framework,
            filePath: '__run__',
            name: `${runner.framework}: run timed out after ${timeoutMs}ms`,
            status: 'timedout',
            durationMs: timeoutMs,
            errorMessage: `runner process was killed after exceeding ${timeoutMs}ms`,
          });
          events.push(timedOutEvent);
          runnerEvents.push(timedOutEvent);
        }
      }

      // Evidence for every failed/timedout event of THIS runner (scrubbed in core).
      const captured = result.stdout.length > 0 ? result.stdout + result.stderr : result.stderr;
      for (const e of runnerEvents) {
        if (e.status !== 'failed' && e.status !== 'timedout') continue;
        const written = writeEvidenceBundle(this.opts.evidenceRoot, {
          event: e,
          consoleLog: captured,
          network: [],
        });
        let finalPath = written.path;
        const seen = bundleCountByTestId.get(e.testId) ?? 0;
        if (seen > 0) {
          // Same test id already wrote a bundle here (retry attempts collide
          // by layout) — move this attempt aside so no evidence is clobbered.
          const attemptDir = `${written.path}-attempt${seen}`;
          try {
            renameSync(written.path, attemptDir);
            finalPath = attemptDir;
          } catch {
            finalPath = written.path;
          }
        }
        bundleCountByTestId.set(e.testId, seen + 1);
        bundles.push({ testId: e.testId, path: finalPath, files: written.files });
      }
    }

    const failures = events.filter((e) => e.status === 'failed' || e.status === 'timedout');
    this.opts.learning?.append({
      type: 'failure',
      tags: ['execution', ...runnerIdsUsed],
      payload: {
        runId,
        testIds: failures.map((f) => f.testId),
        paths: [...new Set(failures.map((f) => f.filePath ?? '').filter((p) => p.length > 0))],
      },
      effect: 'recorded failing tests for defect-history aggregation (feeds risk.defectHistory)',
    });

    return { runId, events, bundles, dryRun: false, runnerIdsUsed };
  }

  private resolveTimeout(): number {
    if (this.timeoutOverride !== undefined) return Math.max(1, this.timeoutOverride);
    const raw = process.env['QA_RUN_TIMEOUT_MS'];
    const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RUN_TIMEOUT_MS;
  }

  /** Persist the dry-run plan next to the evidence tree — the run's paper trail. */
  private recordPlan(runId: string, planned: Array<{ runnerId: string; command: string; args: string[]; reporterHint: string }>): void {
    try {
      const dir = join(this.opts.evidenceRoot, runId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'plan.json'), JSON.stringify({ runId, dryRun: true, planned }, null, 2) + '\n');
    } catch (err) {
      this.opts.logger?.warn(`could not persist dry-run plan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Build the allowlisted child environment. */
function buildChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST.has(key) || key.startsWith('CI_') || key.startsWith('QA_')) {
      out[key] = value;
    }
  }
  return out;
}
