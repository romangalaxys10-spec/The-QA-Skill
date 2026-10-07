import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIdFor } from '@the-qa-skill/core';
import type { ExecutionStatus, TestEvent, TestLayer } from '@the-qa-skill/core';
import type { BuildCommandOptions, PlannedCommand, RunnerContext } from './types.js';

export type { PlannedCommand, BuildCommandOptions };

/**
 * The contract every test-framework adapter implements. The orchestrator
 * (RunExecutor) drives runners exclusively through this interface, so adding a
 * framework never touches the execution pipeline.
 */
export interface Runner {
  /** Stable adapter id used in reports and learning records (e.g. 'playwright'). */
  readonly id: string;
  /** Framework name stamped onto every TestEvent this runner emits. */
  readonly framework: string;
  /** True when the project at `root` looks like it uses this framework. */
  detect(root: string): boolean;
  /** Plan the command this runner would execute. Never spawns anything. */
  buildCommand(ctx: RunnerContext, opts?: BuildCommandOptions): PlannedCommand;
  /**
   * Map raw runner output onto core TestEvents. `raw` is the runner's stdout
   * for stdout reporters, or the produced artifact file content for file
   * reporters (see {@link Runner.readResult}).
   */
  parseOutput(raw: string, ctx: RunnerContext): TestEvent[];
  /**
   * When the runner reports through a file artifact instead of stdout, return
   * the raw file content to parse. Return null when the file does not exist.
   * The default (undefined) means "parse stdout".
   */
  readResult?(ctx: RunnerContext, artifactsDir: string): string | null;
  /**
   * True when this adapter never executes anything (plan-only adapters such as
   * ZAP). RunExecutor refuses to spawn plan-only runners.
   */
  readonly planOnly?: boolean;
}

/** Retry annotations seen in test names, e.g. `login flow (retry #2)`. */
const RETRY_RE = /\bretry\s*#(\d+)/i;

/**
 * Extract the attempt index for an event. Explicit `retry #N` annotations in
 * the test name win (they are the honest record); otherwise the attempt index
 * within the runner's own results array is used (0 for one-shot frameworks).
 */
export function retryIndexFor(name: string, attemptIndex: number): number {
  const m = RETRY_RE.exec(name);
  if (m && m[1] !== undefined) {
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return attemptIndex;
}

/** Normalize a path to a stable POSIX-style relative slug component. */
function stablePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/**
 * Stable test id: `<filePath>::<name>`. Deterministic across runs so evidence
 * bundles, learning records, and triage results always line up.
 */
export function stableTestId(filePath: string, name: string): string {
  return `${stablePath(filePath)}::${name.trim()}`;
}

/** Map a native runner status onto the core ExecutionStatus vocabulary. */
export function mapStatus(native: string): ExecutionStatus {
  switch (native) {
    case 'passed':
    case 'expected':
      return 'passed';
    case 'failed':
    case 'unexpected':
      return 'failed';
    case 'timedOut':
    case 'timed_out':
    case 'timeout':
      return 'timedout';
    case 'skipped':
    case 'pending':
    case 'todo':
    case 'disabled':
    case 'interrupted':
    case 'not_run':
      return 'skipped';
    default:
      // Unknown native statuses are never silently upgraded to failures —
      // they stay 'skipped' (not executed to a verifiable terminal state).
      return 'skipped';
  }
}

/** Parameters for {@link buildEvent}. */
export interface BuildEventParams {
  runId: string;
  ctx: RunnerContext;
  framework: string;
  filePath: string;
  name: string;
  status: ExecutionStatus;
  durationMs: number;
  attemptIndex?: number;
  layer?: TestLayer;
  device?: string;
  errorType?: string;
  errorMessage?: string;
  errorStack?: string;
}

/**
 * Map one native case onto a core TestEvent:
 * - `runId` comes from core `runIdFor()` (fresh per parse) — the executor
 *   overrides it with its own run id so a whole run shares one id.
 * - `testId` is the stable slug `${filePath}::${name}`.
 * - `retryIndex` follows {@link retryIndexFor}.
 */
export function buildEvent(p: BuildEventParams): TestEvent {
  return {
    runId: p.runId,
    testId: stableTestId(p.filePath, p.name),
    name: p.name.trim(),
    timestamp: new Date().toISOString(),
    status: p.status,
    durationMs: Math.max(0, Math.round(p.durationMs)),
    framework: p.framework,
    environment: p.ctx.environment,
    browser: p.ctx.browser,
    device: p.device,
    commit: p.ctx.commit,
    branch: p.ctx.branch,
    retryIndex: retryIndexFor(p.name, p.attemptIndex ?? 0),
    filePath: stablePath(p.filePath),
    errorType: p.errorType,
    errorMessage: p.errorMessage,
    errorStack: p.errorStack,
  };
}

/** Fresh run id for one-shot parsers used outside the executor. */
export function freshRunId(): string {
  return runIdFor('run');
}

/** Read a text file if it exists; null otherwise. Never throws. */
export function readTextIfExists(path: string): string | null {
  // Sync IO is fine here: detection and result-reading are one-shot operations.
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Detect helper: true when the project's package.json declares any of
 * `names` in dependencies or devDependencies. Never throws (unreadable
 * package.json is treated as absent).
 */
export function hasPackageDep(root: string, names: string[]): boolean {
  try {
    const raw = readFileSync(join(root, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return names.some((n) => Object.prototype.hasOwnProperty.call(deps, n));
  } catch {
    return false;
  }
}

/**
 * Extract the first balanced JSON object from raw runner stdout. Reporters
 * usually print pure JSON, but test-process console output can precede or
 * follow it — this scanner is string/escape-aware and finds the object either
 * way. Returns null when nothing JSON-shaped is present. Never throws.
 */
export function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = raw.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
