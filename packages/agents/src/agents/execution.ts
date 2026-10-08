import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, runIdFor, writeEvidenceBundle } from '@the-qa-skill/core';
import type { ExecutionStatus, SelectionResult, TestEvent, TheQAConfig } from '@the-qa-skill/core';
import type { ExecutionOutcome } from '../types.js';

/**
 * ExecutionAgent — runs tests through an injected runner adapter
 * (dependency inversion) and maps results onto core TestEvents.
 *
 * This package ships a SELF-CONTAINED minimal adapter (`DefaultRunnerAdapter`)
 * with built-in framework detection (vitest/jest via package.json deps,
 * playwright via @playwright/test, plus cypress/mocha), `npx`-based command
 * building, and best-effort JSON parsing of runner stdout. It deliberately
 * does NOT match the fuller `@the-qa-skill/runners` adapters — that package
 * provides production-grade parsers; callers wanting them inject their
 * `RunnerAdapter` via the constructor's `adapter` option (or a raw `spawner`).
 *
 * Behavior contract:
 *   - `selection === null` → treat as `{ selected: [], unaffected: [] }`:
 *     planned commands for every detected runner with no file filtering.
 *   - `dryRun` → planned commands only, zero events, nothing spawned.
 *   - otherwise → spawn with a 600000ms timeout per command; parse events;
 *     re-stamp runId/environment/framework; failures get an errorMessage from
 *     the stderr tail (2000 chars) when the parser produced none; failed runs
 *     without parsed per-test output synthesize one suite-level failure event
 *     (failures are never silent); evidence bundles are written for failures.
 *   - Policy note: 'pr' passes through untouched; 'nightly'/'release' (and
 *     other policies) currently share the same command shape — the policy is
 *     threaded into `buildArgs` as the documented hook point for future
 *     per-policy flags (coverage, retries); no fake flags are appended today.
 */

/** The process-spawning seam — inject for tests or exotic runners. */
export type SpawnFn = (
  command: string,
  args: string[],
  ctx: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Narrow adapter interface: detection, execution, parsing. */
export interface RunnerAdapter {
  /** Test frameworks available at the given root (deterministic order). */
  frameworksAt(root: string): string[];
  /** Run one command; must respect the timeout and resolve (not throw) with an exit code. */
  run(runner: string, command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }>;
  /** Best-effort parse of raw runner output into core TestEvents. */
  parse(runner: string, raw: string): TestEvent[];
}

const TIMEOUT_EXIT_CODE = 124;
const EXECUTION_TIMEOUT_MS = 600_000;
const STDERR_TAIL_CHARS = 2000;

export class DefaultRunnerAdapter implements RunnerAdapter {
  constructor(private readonly spawner?: SpawnFn) {}

  /** Detect test frameworks from package.json dependencies (deterministic order). */
  frameworksAt(root: string): string[] {
    const pkgPath = join(root, 'package.json');
    if (!existsSync(pkgPath)) return [];
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(deps, name);
      const out: string[] = [];
      if (has('vitest')) out.push('vitest');
      if (has('jest')) out.push('jest');
      if (has('@playwright/test')) out.push('playwright');
      if (has('cypress')) out.push('cypress');
      if (has('mocha')) out.push('mocha');
      return out;
    } catch {
      return [];
    }
  }

  /** Run via the injected spawner, or a built-in child_process spawn. */
  run(runner: string, command: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
    if (this.spawner) return this.spawner(command, args, { cwd, timeoutMs });
    void runner;
    return builtinSpawn(command, args, { cwd, timeoutMs });
  }

  /**
   * Best-effort JSON extraction from stdout: the substring from the first '{'
   * to the last '}' is parsed, then common runner-report shapes are flattened
   * (vitest/jest JSON reporters, plain event arrays). Unparseable output
   * yields zero events — the caller decides whether that means failure.
   */
  parse(runner: string, raw: string): TestEvent[] {
    const json = extractJson(raw);
    if (json === undefined) return [];
    const now = new Date().toISOString();
    const events: TestEvent[] = [];
    for (const row of flattenRows(json)) {
      const name = pickString(row, ['fullName', 'title', 'name']);
      if (!name) continue;
      const rawStatus = (pickString(row, ['status', 'state']) ?? 'unknown').toLowerCase();
      events.push({
        runId: 'unassigned', // execute() re-stamps with the real run id
        testId: pickString(row, ['testId', 'id']) ?? name,
        name,
        timestamp: now,
        status: mapStatus(rawStatus),
        durationMs: pickNumber(row, ['durationMs', 'duration']) ?? 0,
        framework: runner,
        environment: 'local',
        retryIndex: 0,
        filePath: pickString(row, ['filePath', 'file', 'path']),
      });
    }
    return events;
  }
}

export class ExecutionAgent {
  /** The resolved configuration (explicit option or loaded from theqa.config.json). */
  public readonly config: TheQAConfig;
  private readonly adapter: RunnerAdapter;

  constructor(
    private readonly root: string,
    opts: { config?: TheQAConfig; spawner?: SpawnFn; adapter?: RunnerAdapter } = {},
  ) {
    this.config = opts.config ?? loadConfig(root).config;
    this.adapter = opts.adapter ?? new DefaultRunnerAdapter(opts.spawner);
  }

  /**
   * Execute the selection (or the whole suite when null) under the given
   * policy. See the module doc for the full dry-run/failure/bundle contract.
   */
  async execute(
    selection: SelectionResult | null,
    opts: { policy: 'pr' | 'pre_merge' | 'nightly' | 'release' | 'post_deploy'; dryRun: boolean; environment?: string },
  ): Promise<ExecutionOutcome> {
    const runId = runIdFor('run');
    const frameworks = this.adapter.frameworksAt(this.root);
    const files = selection ? selection.selected.map((s) => s.test.filePath) : [];
    const plannedCommands = frameworks.map((runner) => ({
      runner,
      command: 'npx',
      args: this.buildArgs(runner, files, opts.policy),
    }));

    if (opts.dryRun) {
      return { runId, events: [], dryRun: true, plannedCommands, bundles: [] };
    }

    const environment = opts.environment ?? 'local';
    const events: TestEvent[] = [];
    const bundles: Array<{ testId: string; path: string }> = [];
    const stderrByRunner = new Map<string, string>();

    for (const cmd of plannedCommands) {
      const result = await this.adapter.run(cmd.runner, cmd.command, cmd.args, this.root, EXECUTION_TIMEOUT_MS);
      stderrByRunner.set(cmd.runner, result.stderr);
      const parsed = this.adapter.parse(cmd.runner, result.stdout);
      for (const ev of parsed) {
        const stamped: TestEvent = { ...ev, runId, framework: cmd.runner, environment };
        if ((stamped.status === 'failed' || stamped.status === 'timedout') && !stamped.errorMessage) {
          stamped.errorMessage = tail(result.stderr, STDERR_TAIL_CHARS) || tail(result.stdout, STDERR_TAIL_CHARS);
        }
        events.push(stamped);
      }
      // A runner that exited non-zero without parseable per-test output is a
      // failure we refuse to swallow: synthesize one suite-level event.
      if (result.code !== 0 && parsed.length === 0) {
        events.push({
          runId,
          testId: `${cmd.runner}:suite`,
          name: `${cmd.runner} suite (no per-test output parsed)`,
          timestamp: new Date().toISOString(),
          status: 'failed',
          durationMs: 0,
          framework: cmd.runner,
          environment,
          retryIndex: 0,
          errorMessage: tail(result.stderr, STDERR_TAIL_CHARS) || `runner exited with code ${result.code}`,
        });
      }
    }

    for (const ev of events) {
      if (ev.status !== 'failed' && ev.status !== 'timedout') continue;
      try {
        const bundle = writeEvidenceBundle(this.root, {
          event: ev,
          consoleLog: stderrByRunner.get(ev.framework) ?? '',
        });
        bundles.push({ testId: ev.testId, path: bundle.path });
      } catch {
        // Evidence writing is best-effort; a failed bundle write must never
        // fail the run itself — the event already carries the error message.
      }
    }

    return { runId, events, dryRun: false, plannedCommands, bundles };
  }

  /**
   * Build runner arguments. The `policy` parameter is the documented hook
   * point for per-policy flags (coverage/full-suite behavior for
   * nightly/release); today every policy shares the same shape — 'pr' passes
   * through untouched, nothing fake is appended.
   */
  private buildArgs(runner: string, files: string[], policy: string): string[] {
    void policy;
    const base: Record<string, string[]> = {
      vitest: ['vitest', 'run'],
      jest: ['jest'],
      playwright: ['playwright', 'test'],
      cypress: ['cypress', 'run'],
      mocha: ['mocha'],
    };
    const args = [...(base[runner] ?? [runner])];
    const filters = runner === 'playwright' ? files.filter((f) => /\.spec\.[cm]?[jt]sx?$|e2e|playwright/i.test(f)) : files;
    return [...args, ...filters];
  }
}

/** Built-in spawn: collects stdout/stderr, kills on timeout, never rejects. */
function builtinSpawn(command: string, args: string[], ctx: { cwd: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ctx.cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, ctx.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${err.message}`.trim(), code: 127 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: timedOut ? TIMEOUT_EXIT_CODE : (code ?? TIMEOUT_EXIT_CODE) });
    });
  });
}

/** Extract the JSON-looking substring: first '{' … last '}'. */
function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Flatten common runner-report shapes into per-test row objects. */
function flattenRows(data: unknown): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const pushRows = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry !== null && typeof entry === 'object') {
          const obj = entry as Record<string, unknown>;
          if (Array.isArray(obj.assertionResults)) pushRows(obj.assertionResults);
          else rows.push(obj);
        }
      }
    }
  };
  if (Array.isArray(data)) {
    pushRows(data);
  } else if (data !== null && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of ['events', 'tests', 'testResults', 'assertionResults']) {
      if (Array.isArray(obj[key])) pushRows(obj[key]);
    }
  }
  return rows;
}

function pickString(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Tolerant status mapping — unknown statuses map to 'not_run', never invented passes. */
function mapStatus(raw: string): ExecutionStatus {
  if (/^(pass|passed|green|ok)$/.test(raw)) return 'passed';
  if (/^(fail|failed|failing|red|error)$/.test(raw)) return 'failed';
  if (/^(skip|skipped|pending|todo)$/.test(raw)) return 'skipped';
  if (/^(timeout|timedout|timed_out|timed out)$/.test(raw)) return 'timedout';
  return 'not_run';
}

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(text.length - chars);
}
