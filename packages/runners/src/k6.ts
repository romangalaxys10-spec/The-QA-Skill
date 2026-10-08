import { join } from 'node:path';
import type { TestEvent } from '@the-qa-skill/core';
import { listFiles, matchAny } from '@the-qa-skill/core';
import { buildEvent, extractJsonObject, freshRunId, readTextIfExists } from './runner.js';
import type { BuildCommandOptions, PlannedCommand, Runner } from './runner.js';
import type { RunnerContext } from './types.js';

/** File globs treated as k6 load-test scripts or configuration. */
const K6_PATTERNS = [
  '**/*.k6.js',
  '**/*.k6.ts',
  'k6/**/*.js',
  'k6/**/*.ts',
  'perf/**/*.js',
  'perf/**/*.ts',
  'load-tests/**/*.js',
  'load-tests/**/*.ts',
  'k6.config.json',
  'k6.json',
];

/**
 * k6 adapter.
 *
 * PHILOSOPHY (documented honestly): k6 treats performance budgets as tests.
 * A threshold is an assertion over a metric ("p95 < 300ms"), a check is an
 * assertion per sampled request ("status is 200"). Both are mapped onto
 * TestEvents so load regressions hit the same triage/gate pipeline as
 * functional failures.
 *
 * - Metric WITH thresholds → event whose status comes from the threshold's
 *   `ok` boolean (either the metric-level `thresholds[]` entries or the
 *   summary's top-level `thresholds: { name: { ok } }` map).
 * - Metric WITHOUT thresholds → status 'passed'. This is an OBSERVATION, not
 *   a budget that was verified — the event name carries the `metric:` marker
 *   so reports never confuse it with an enforced budget.
 * - root_group checks (recursive) → one event each; `fails === 0` → passed.
 *
 * durationMs is 0 for these events: k6 summary exports contain no per-check
 * or per-metric wall-clock test duration, and inventing one would be a lie.
 */
export class K6Runner implements Runner {
  readonly id = 'k6';
  readonly framework = 'k6';

  detect(root: string): boolean {
    try {
      const files = listFiles(root, { maxFiles: 5000 });
      return files.some((f) => matchAny(f, K6_PATTERNS));
    } catch {
      return false;
    }
  }

  buildCommand(ctx: RunnerContext, opts?: BuildCommandOptions): PlannedCommand {
    const artifactsDir = opts?.artifactsDir ?? join(ctx.root, '.theqa', 'artifacts');
    const script = opts?.script ?? this.firstDetectedScript(ctx.root);
    return {
      command: 'k6',
      args: ['run', `--summary-export=${join(artifactsDir, 'k6-summary.json')}`, script],
      reporterHint: 'summary-json-file',
    };
  }

  /** The executor calls this instead of parsing stdout: k6 reports via file. */
  readResult(ctx: RunnerContext, artifactsDir: string): string | null {
    void ctx;
    return readTextIfExists(join(artifactsDir, 'k6-summary.json'));
  }

  parseOutput(raw: string, ctx: RunnerContext): TestEvent[] {
    const summary = extractJsonObject(raw) as K6Summary | null;
    if (!summary || typeof summary !== 'object') return [];
    const runId = freshRunId();
    const events: TestEvent[] = [];
    const filePath = 'k6/summary.json';

    const topLevelThresholds = summary.thresholds ?? {};

    for (const [metricName, metric] of Object.entries(summary.metrics ?? {})) {
      const ok = resolveThresholdOk(metricName, metric?.thresholds, topLevelThresholds);
      const name = `[k6] ${ok === undefined ? 'metric:' : 'threshold:'} ${metricName}`;
      events.push(
        buildEvent({
          runId,
          ctx,
          framework: this.framework,
          filePath,
          name,
          status: ok === undefined || ok ? 'passed' : 'failed',
          durationMs: 0,
          errorType: ok === false ? 'threshold' : undefined,
          errorMessage: ok === false ? `k6 threshold failed for metric '${metricName}'` : undefined,
        }),
      );
    }

    for (const check of collectChecks(summary.root_group)) {
      const passed = (check.fails ?? 0) === 0;
      events.push(
        buildEvent({
          runId,
          ctx,
          framework: this.framework,
          filePath,
          name: `[k6] check: ${check.path || check.name || '(unnamed check)'}`,
          status: passed ? 'passed' : 'failed',
          durationMs: 0,
          errorType: passed ? undefined : 'check',
          errorMessage: passed
            ? undefined
            : `k6 check '${check.name ?? '(unnamed)'}' failed ${check.fails ?? 0} time(s), passed ${check.passes ?? 0}`,
        }),
      );
    }

    return events;
  }
  /** Deterministic first k6 script from the project tree (sorted, then first). */
  private firstDetectedScript(root: string): string {
    const files = listFiles(root, { maxFiles: 5000 }).sort();
    const match = files.find((f) => matchAny(f, K6_PATTERNS));
    if (!match) {
      throw new Error('k6 script not found — pass opts.script explicitly to buildCommand');
    }
    return match;
  }
}

/**
 * Resolve whether a metric's thresholds passed:
 * 1. metric-level `thresholds[]` entries → all `ok` must be true;
 * 2. top-level `thresholds` map (`{ "<metric>": { ok: boolean } }`);
 * 3. undefined → the metric carries no threshold at all.
 */
function resolveThresholdOk(
  metricName: string,
  metricThresholds: Array<{ ok?: boolean }> | undefined,
  topLevel: Record<string, { ok?: boolean } | undefined>,
): boolean | undefined {
  if (metricThresholds && metricThresholds.length > 0) {
    return metricThresholds.every((t) => t.ok === true);
  }
  const entry = topLevel[metricName];
  if (entry && typeof entry.ok === 'boolean') return entry.ok;
  return undefined;
}

interface K6Check {
  name?: string;
  path?: string;
  passes?: number;
  fails?: number;
  groups?: K6Group[];
}

interface K6Group {
  name?: string;
  path?: string;
  groups?: K6Group[];
  checks?: K6Check[];
}

interface K6Metric {
  thresholds?: Array<{ ok?: boolean }>;
  values?: Record<string, number>;
}

interface K6Summary {
  metrics?: Record<string, K6Metric | undefined>;
  thresholds?: Record<string, { ok?: boolean } | undefined>;
  root_group?: K6Group;
}

/** Recursively collect every check in the group tree. */
function collectChecks(group: K6Group | undefined): K6Check[] {
  if (!group) return [];
  const out: K6Check[] = [...(group.checks ?? [])];
  for (const child of group.groups ?? []) out.push(...collectChecks(child));
  return out;
}
