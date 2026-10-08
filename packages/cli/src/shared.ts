import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { computeCoverage, loadConfig } from '@the-qa-skill/core';
import type {
  DiscoveryResult, FlakeInput, FailedTestRecord, Logger, TestInventoryEntry, TestLayer, TestEvent, TheQAConfig, VerificationLabel,
} from '@the-qa-skill/core';
import type { ParsedArgs } from './args.js';
import { UsageError } from './args.js';

/**
 * Shared CLI plumbing: command context/result contracts, flag helpers, and
 * the evidence-loading + inventory-building routines shared by several
 * commands (impact/test/coverage build inventory; triage/heal/release/report
 * read failure records and flake history from .theqa artifacts).
 */

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_ERROR = 2;

// ---------------------------------------------------------------------------
// IO + context
// ---------------------------------------------------------------------------

/** Minimal write sink — process.stdout/stderr satisfy it structurally. */
export interface WritableSink {
  write(text: string): void;
}

export interface CommandIO {
  stdout: WritableSink;
  stderr: WritableSink;
}

export const defaultIO: CommandIO = { stdout: process.stdout, stderr: process.stderr };

export interface CommandContext {
  /** Process working directory (never mutated). */
  cwd: string;
  /** Positional tokens after the command name. */
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
  parsed: ParsedArgs;
  logger: Logger;
  io: CommandIO;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  dryRun: boolean;
}

export interface CommandResult<T = unknown> {
  ok: boolean;
  data: T;
  label: VerificationLabel;
  /** Override the default exit mapping (default: ok ? 0 : 1). */
  exitCode?: number;
}

export function ok<T>(data: T, label: VerificationLabel, exitCode?: number): CommandResult<T> {
  return { ok: true, data, label, exitCode };
}

export function findings<T>(data: T, label: VerificationLabel): CommandResult<T> {
  return { ok: false, data, label, exitCode: EXIT_FINDINGS };
}

/** Read a value flag (guaranteed string by the parser for registered value flags). */
export function flagString(ctx: CommandContext, name: string): string | undefined {
  const v = ctx.flags[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function flagBool(ctx: CommandContext, name: string): boolean {
  return ctx.flags[name] === true;
}

/**
 * Project root resolution. Precedence: explicit `[dir]` positional (init /
 * discover) → `THEQA_ROOT` env override (scripting + test seam) → cwd.
 */
export function rootFrom(ctx: CommandContext, positionalIndex?: number): string {
  if (positionalIndex !== undefined) {
    const dir = ctx.positionals[positionalIndex];
    if (dir !== undefined && dir.length > 0) return resolve(ctx.cwd, dir);
  }
  const envRoot = process.env.THEQA_ROOT;
  if (envRoot !== undefined && envRoot.length > 0) return resolve(envRoot);
  return resolve(ctx.cwd);
}

// ---------------------------------------------------------------------------
// Inventory building (impact / test / coverage)
// ---------------------------------------------------------------------------

const IMPORT_RE = /(?:import\s+[^'"]*?from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;
const EXT_CANDIDATES = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'];

function normalizeJoin(dir: string, rel: string): string {
  const parts = `${dir}/${rel}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/** Resolve one RELATIVE import specifier (alias imports need a tsconfig map and are skipped). */
function resolveImport(specifier: string, fromFile: string, allFiles: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const baseDir = fromFile.split('/').slice(0, -1).join('/');
  const candidate = normalizeJoin(baseDir, specifier);
  const candidates = [candidate, ...EXT_CANDIDATES.map((ext) => `${candidate}${ext}`)];
  for (const c of candidates) {
    if (allFiles.has(c)) return c;
  }
  return undefined;
}

/**
 * Root-aware import closure (same algorithm as core `computeCoverage`, but
 * resolving files against the project root instead of `process.cwd()`, which
 * the core reader is bound to). Used directly when cwd ≠ root and as the
 * fallback when the core walk comes back empty.
 */
export function importClosure(root: string, testFile: string, allFiles: Set<string>, maxDepth = 12): string[] {
  const seen = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: testFile, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || item.depth >= maxDepth) continue;
    let source: string;
    try {
      source = readFileSync(join(root, item.file), 'utf8');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(source)) !== null) {
      const spec = m[1] ?? '';
      const resolved = resolveImport(spec, item.file, allFiles);
      if (resolved && resolved !== testFile && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push({ file: resolved, depth: item.depth + 1 });
      }
    }
  }
  return [...seen];
}

/**
 * Coverage of one test file. Delegates to core `computeCoverage` when the
 * process cwd IS the project root (the only case the core reader handles);
 * otherwise uses the root-aware closure. Both directions are deterministic.
 */
export function coversFor(root: string, testFile: string, allFiles: Set<string>): string[] {
  if (resolve(root) === resolve(process.cwd())) {
    const viaCore = computeCoverage(testFile, allFiles);
    if (viaCore.length > 0) return viaCore;
  }
  return importClosure(root, testFile, allFiles);
}

/** Map discovered test files onto core TestInventoryEntry shapes. */
export function buildInventory(root: string, discovery: DiscoveryResult): TestInventoryEntry[] {
  const allFiles = new Set<string>([...discovery.sourceFiles, ...discovery.testFiles.map((t) => t.filePath)]);
  return discovery.testFiles.map((f) => ({
    testId: f.filePath,
    name: f.filePath.split('/').pop() ?? f.filePath,
    filePath: f.filePath,
    layer: f.layer,
    framework: f.framework,
    covers: coversFor(root, f.filePath, allFiles),
  }));
}

// ---------------------------------------------------------------------------
// Failure-evidence loading (triage / heal / release / report)
// ---------------------------------------------------------------------------

export interface FailureEvidence {
  records: FailedTestRecord[];
  /** Where each record came from (relative file paths), for honest reporting. */
  sources: string[];
  /** DOM snapshots keyed by testId — the selector-healing evidence contract. */
  domSnapshots: Map<string, string>;
  /** Non-parseable JSON containers skipped (reported, never silent). */
  skipped: number;
}

const EXECUTION_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'skipped', 'timedout', 'not_run']);
const LAYERS: ReadonlySet<string> = new Set([
  'unit', 'integration', 'api', 'e2e', 'visual', 'a11y', 'performance', 'security', 'contract', 'manual',
]);

function coerceRecord(raw: unknown): FailedTestRecord | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.testId !== 'string' || r.testId.length === 0) return undefined;
  if (!Array.isArray(r.attempts)) return undefined;
  const attempts = (r.attempts as unknown[]).flatMap((a) => {
    if (a === null || typeof a !== 'object') return [];
    const o = a as Record<string, unknown>;
    const status = typeof o.status === 'string' && EXECUTION_STATUSES.has(o.status) ? o.status : 'not_run';
    return [{
      status: status as FailedTestRecord['attempts'][number]['status'],
      durationMs: typeof o.durationMs === 'number' ? o.durationMs : 0,
      timestamp: typeof o.timestamp === 'string' && o.timestamp.length > 0 ? o.timestamp : '1970-01-01T00:00:00.000Z',
      environment: typeof o.environment === 'string' && o.environment.length > 0 ? o.environment : 'local',
      browser: typeof o.browser === 'string' ? o.browser : undefined,
      errorType: typeof o.errorType === 'string' ? o.errorType : undefined,
      errorMessage: typeof o.errorMessage === 'string' ? o.errorMessage : undefined,
      errorStack: typeof o.errorStack === 'string' ? o.errorStack : undefined,
    }];
  });
  const layer = typeof r.layer === 'string' && LAYERS.has(r.layer) ? (r.layer as TestLayer) : 'unit';
  const snapshot = typeof r.domSnapshot === 'string' && r.domSnapshot.length > 0 ? r.domSnapshot : undefined;
  const record: FailedTestRecord = {
    testId: r.testId,
    name: typeof r.name === 'string' ? r.name : r.testId,
    filePath: typeof r.filePath === 'string' ? r.filePath : '',
    layer,
    attempts,
    changedFiles: Array.isArray(r.changedFiles) ? (r.changedFiles as unknown[]).filter((p): p is string => typeof p === 'string') : [],
    networkVerified: typeof r.networkVerified === 'boolean' ? r.networkVerified : undefined,
    domVerified: typeof r.domVerified === 'boolean' ? r.domVerified : undefined,
    recentRuns: Array.isArray(r.recentRuns)
      ? (r.recentRuns as unknown[]).filter((s): s is 'passed' | 'failed' | 'skipped' => typeof s === 'string' && ['passed', 'failed', 'skipped'].includes(s))
      : [],
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === 'string') : undefined,
  };
  // Snapshot rides outside the core contract — surfaced via the evidence bag.
  (record as FailedTestRecord & { domSnapshot?: string }).domSnapshot = snapshot;
  return record;
}

function parseFailuresJson(text: string): { records: FailedTestRecord[]; snapshots: Map<string, string>; skipped: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new UsageError(`failure evidence is not valid JSON: ${(e as Error).message}`);
  }
  const snapshots = new Map<string, string>();
  const arr: unknown[] = [];
  if (Array.isArray(raw)) {
    arr.push(...raw);
  } else if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.failures)) {
      arr.push(...(o.failures as unknown[]));
    } else {
      arr.push(raw);
    }
    if (o.domSnapshots !== null && typeof o.domSnapshots === 'object') {
      for (const [k, v] of Object.entries(o.domSnapshots as Record<string, unknown>)) {
        if (typeof v === 'string') snapshots.set(k, v);
      }
    }
  }
  const records: FailedTestRecord[] = [];
  let skipped = 0;
  for (const item of arr) {
    const rec = coerceRecord(item);
    if (!rec) {
      skipped += 1;
      continue;
    }
    records.push(rec);
  }
  return { records, snapshots, skipped };
}

function listFilesUnder(dir: string, name: string, depth = 4): string[] {
  const out: string[] = [];
  if (depth < 0) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...listFilesUnder(full, name, depth - 1));
    } else if (entry === name) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Load FailedTestRecords from `--evidence <file|dir>` or, when omitted, from
 * every `failures.json` under the artifacts directory. Documented JSON
 * shapes: a bare array of records, `{ failures: [...] , domSnapshots? }`, or
 * a single record object. Per-record `domSnapshot` fields and the top-level
 * `domSnapshots` map feed selector healing.
 */
export function loadFailureEvidence(root: string, evidencePath: string | undefined, artifactsDir: string): FailureEvidence {
  const records: FailedTestRecord[] = [];
  const sources: string[] = [];
  const domSnapshots = new Map<string, string>();
  let skipped = 0;

  if (evidencePath !== undefined) {
    const abs = resolve(root, evidencePath);
    if (!existsSync(abs)) {
      throw new UsageError(`evidence path does not exist: ${evidencePath}`, 'pass a JSON file of failure records or a directory containing failures.json');
    }
    const st = statSync(abs);
    const files = st.isDirectory() ? listFilesUnder(abs, 'failures.json') : [abs];
    if (files.length === 0) {
      throw new UsageError(`no failure records found at ${evidencePath}${st.isDirectory() ? ' (no failures.json under it)' : ''}`);
    }
    for (const file of files) {
      const parsed = parseFailuresJson(readFileSync(file, 'utf8'));
      records.push(...parsed.records);
      skipped += parsed.skipped;
      for (const [k, v] of parsed.snapshots) domSnapshots.set(k, v);
      sources.push(file.startsWith(root + '/') ? file.slice(root.length + 1) : file);
    }
  } else if (existsSync(artifactsDir)) {
    const files = listFilesUnder(artifactsDir, 'failures.json');
    for (const file of files) {
      const parsed = parseFailuresJson(readFileSync(file, 'utf8'));
      records.push(...parsed.records);
      skipped += parsed.skipped;
      for (const [k, v] of parsed.snapshots) domSnapshots.set(k, v);
      sources.push(file.startsWith(root + '/') ? file.slice(root.length + 1) : file);
    }
  }

  for (const rec of records) {
    const snapshot = (rec as FailedTestRecord & { domSnapshot?: string }).domSnapshot;
    if (typeof snapshot === 'string' && !domSnapshots.has(rec.testId)) domSnapshots.set(rec.testId, snapshot);
    delete (rec as FailedTestRecord & { domSnapshot?: string }).domSnapshot;
  }

  return { records, sources, domSnapshots, skipped };
}

/** True when the artifacts tree contains at least one execution-evidence file. */
export function hasExecutionEvidence(artifactsDir: string): { complete: boolean; sources: string[] } {
  if (!existsSync(artifactsDir)) return { complete: false, sources: [] };
  const markers = [...listFilesUnder(artifactsDir, 'metadata.json', 4), ...listFilesUnder(artifactsDir, 'events.json', 4), ...listFilesUnder(artifactsDir, 'failures.json', 4)];
  return { complete: markers.length > 0, sources: markers.slice(0, 10).map((m) => m.split('/').slice(-3).join('/')) };
}

// ---------------------------------------------------------------------------
// Flake-history loading (flake / release / report)
// ---------------------------------------------------------------------------

const EVENT_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'skipped', 'timedout', 'not_run']);

/** Group TestEvents by testId into FlakeInputs (documented mapping). */
export function eventsToFlakeInputs(events: unknown[]): FlakeInput[] {
  const byTest = new Map<string, TestEvent[]>();
  for (const raw of events) {
    if (raw === null || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.testId !== 'string') continue;
    const status = typeof e.status === 'string' && EVENT_STATUSES.has(e.status) ? e.status : 'not_run';
    const event: TestEvent = {
      runId: typeof e.runId === 'string' ? e.runId : 'unknown',
      testId: e.testId,
      name: typeof e.name === 'string' ? e.name : e.testId,
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : '1970-01-01T00:00:00.000Z',
      status: status as TestEvent['status'],
      durationMs: typeof e.durationMs === 'number' ? e.durationMs : 0,
      framework: typeof e.framework === 'string' ? e.framework : 'unknown',
      environment: typeof e.environment === 'string' ? e.environment : 'local',
      browser: typeof e.browser === 'string' ? e.browser : undefined,
      retryIndex: typeof e.retryIndex === 'number' ? e.retryIndex : 0,
    };
    const list = byTest.get(event.testId) ?? [];
    list.push(event);
    byTest.set(event.testId, list);
  }
  const inputs: FlakeInput[] = [];
  for (const [testId, list] of byTest) {
    const outcomes = list
      .filter((e) => e.status === 'passed' || e.status === 'failed')
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((e) => ({ status: e.status as 'passed' | 'failed', timestamp: e.timestamp, environment: e.environment, browser: e.browser }));
    const failedEvents = list.filter((e) => e.status === 'failed' || e.status === 'timedout');
    inputs.push({
      testId,
      outcomes,
      retryCount: list.filter((e) => e.retryIndex > 0).length,
      environments: [...new Set(failedEvents.map((e) => e.environment))],
      browsers: [...new Set(failedEvents.map((e) => e.browser).filter((b): b is string => typeof b === 'string'))],
    });
  }
  return inputs.sort((a, b) => a.testId.localeCompare(b.testId));
}

function looksLikeTestEvent(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return typeof o.testId === 'string' && typeof o.status === 'string' && (typeof o.runId === 'string' || Array.isArray(o));
}

function looksLikeFlakeInput(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return typeof o.testId === 'string' && Array.isArray(o.outcomes);
}

/**
 * Load FlakeInputs from `--history <file>` (or artifacts events.json when
 * omitted). Accepts FlakeInput[] arrays or TestEvent[] histories (mapped via
 * `eventsToFlakeInputs`).
 */
export function loadFlakeInputs(root: string, historyPath: string | undefined, artifactsDir: string): { inputs: FlakeInput[]; source?: string; shape: 'flake-inputs' | 'events' | 'none' } {
  const candidates: string[] = [];
  if (historyPath !== undefined) {
    const abs = resolve(root, historyPath);
    if (!existsSync(abs)) throw new UsageError(`history file does not exist: ${historyPath}`);
    candidates.push(abs);
  } else {
    for (const name of ['events.json', 'flake-history.json']) {
      candidates.push(...listFilesUnder(artifactsDir, name, 4));
    }
  }
  if (candidates.length === 0) return { inputs: [], shape: 'none' };

  let shape: 'flake-inputs' | 'events' | 'none' = 'none';
  const inputs: FlakeInput[] = [];
  for (const file of candidates) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const arr = Array.isArray(raw)
      ? raw
      : raw !== null && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).events)
        ? ((raw as Record<string, unknown>).events as unknown[])
        : [];
    if (arr.length === 0) continue;
    if (arr.every(looksLikeFlakeInput)) {
      for (const item of arr) {
        const o = item as Record<string, unknown>;
        inputs.push({
          testId: String(o.testId),
          outcomes: (o.outcomes as unknown[]).flatMap((x) => {
            const e = x as Record<string, unknown>;
            if (typeof e?.status !== 'string' || (e.status !== 'passed' && e.status !== 'failed')) return [];
            return [{
              status: e.status as 'passed' | 'failed',
              timestamp: typeof e.timestamp === 'string' ? e.timestamp : '1970-01-01T00:00:00.000Z',
              environment: typeof e.environment === 'string' ? e.environment : undefined,
              browser: typeof e.browser === 'string' ? e.browser : undefined,
            }];
          }),
          retryCount: typeof o.retryCount === 'number' ? o.retryCount : 0,
          environments: Array.isArray(o.environments) ? (o.environments as unknown[]).filter((e): e is string => typeof e === 'string') : [],
          browsers: Array.isArray(o.browsers) ? (o.browsers as unknown[]).filter((b): b is string => typeof b === 'string') : [],
        });
      }
      shape = 'flake-inputs';
    } else if (arr.every(looksLikeTestEvent)) {
      inputs.push(...eventsToFlakeInputs(arr));
      shape = 'events';
    }
  }
  return { inputs, source: candidates[0], shape };
}

/** Ensure the parent directory of a target path exists (for writes). */
export function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  if (dir.length > 0) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Config + artifacts helpers
// ---------------------------------------------------------------------------

const configCache = new Map<string, TheQAConfig>();

/** Load (and memoize) the effective TheQAConfig for a root. */
export function loadProject(root: string): TheQAConfig {
  const key = resolve(root);
  const hit = configCache.get(key);
  if (hit) return hit;
  const { config } = loadConfig(key);
  configCache.set(key, config);
  return config;
}

/** Absolute artifacts directory for a root. */
export function artifactsDirFor(root: string): string {
  return join(root, loadProject(root).paths.artifacts);
}
