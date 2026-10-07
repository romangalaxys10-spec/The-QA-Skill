import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyFailure, clusterFailures, detectSelectorChange } from '@the-qa-skill/core';
import type {
  AttemptRecord, FailedTestRecord, LearningStore, RawFailure, SimpleCluster, TriageResult,
} from '@the-qa-skill/core';
import type { TriageAgentContext } from '../types.js';

/**
 * TriageAgent — evidence-driven failure classification.
 *
 * Per failure the agent derives the core TriageContext:
 *   - `relevantChangedFiles` = the failure's changedFiles intersected with the
 *     orchestrator-provided changed files (empty set when none provided, so
 *     `coversChangedCode` is false by default — never assumed);
 *   - `coversChangedCode` = explicit ctx value when given, otherwise true
 *     exactly when the intersection is non-empty;
 *   - `selectorChangedInDiff` = explicit ctx value when given, otherwise
 *     derived by reading the test file and running core `detectSelectorChange`
 *     against the optional `diffText` extension.
 *
 * Classification itself is the core 12-category decision table. When a
 * learning store is present, every triage outcome is appended as a 'failure'
 * record with an explicit effect — feeding `failureDensityByPath()` without
 * ever mutating behavior silently.
 *
 * `clusters()` groups failures by normalized signature (core clustering).
 * `detectPrimaryCascade()` implements the documented primary-vs-cascade
 * heuristic: a cluster whose representative error matches
 * dependency/connection patterns is PRIMARY when at least two OTHER clusters
 * share the same environment and started within a 5-minute window; remaining
 * clusters that started after a primary in the same environment inside that
 * window are CASCADE. This is a ranking hint for humans, not proof of
 * causation — the heuristic and its limits are stated here on purpose.
 */

const DEPENDENCY_ENV_RE =
  /ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ETIMEDOUT|getaddrinfo|connection refused|dial tcp|Cannot find module|Module not found|ERR_MODULE_NOT_FOUND|50[23] (service unavailable|bad gateway)/i;

const CASCADE_WINDOW_MS = 5 * 60 * 1000;

export class TriageAgent {
  constructor(
    private readonly root: string,
    opts: { learning?: LearningStore } = {},
  ) {
    this.learning = opts.learning;
  }

  /** Optional learning store — failure records are appended when present. */
  public readonly learning?: LearningStore;

  /**
   * Triage failed tests through the core decision table. The optional ctx
   * carries orchestrator-provided changed files / selector knowledge plus the
   * `diffText` extension for selector-change detection.
   */
  triage(failures: FailedTestRecord[], ctx: TriageAgentContext = {}): TriageResult[] {
    const changed = ctx.relevantChangedFiles ?? [];
    const results: TriageResult[] = [];
    for (const failure of failures) {
      const relevant = failure.changedFiles.filter((f) => changed.includes(f));
      const coreCtx = {
        coversChangedCode: ctx.coversChangedCode ?? relevant.length > 0,
        relevantChangedFiles: relevant,
        selectorChangedInDiff: ctx.selectorChangedInDiff ?? this.selectorChanged(failure, ctx.diffText),
      };
      const result = classifyFailure(failure, coreCtx);
      this.learning?.append({
        type: 'failure',
        tags: ['triage', result.category.toLowerCase()],
        payload: { testId: failure.testId, category: result.category, confidence: result.confidence, paths: relevant },
        effect: `recorded ${result.category} (confidence ${result.confidence.toFixed(2)}) for ${failure.testId} — feeds failure-density learning`,
      });
      results.push(result);
    }
    return results;
  }

  /** Cluster failures by normalized error signature (core clustering). */
  clusters(failures: FailedTestRecord[]): SimpleCluster[] {
    return clusterFailures(failures.map(toRawFailure));
  }

  /** Selector-change detection for one failure against the optional diff text. */
  private selectorChanged(failure: FailedTestRecord, diffText: string | undefined): boolean {
    if (diffText === undefined) return false;
    const abs = join(this.root, failure.filePath);
    if (!existsSync(abs)) return false;
    try {
      return detectSelectorChange(readFileSync(abs, 'utf8'), diffText);
    } catch {
      return false;
    }
  }
}

/** Map a FailedTestRecord onto the clustering engine's RawFailure shape. */
function toRawFailure(record: FailedTestRecord): RawFailure {
  const failed = record.attempts.filter((a) => a.status === 'failed' || a.status === 'timedout');
  const first = failed[0] ?? record.attempts[0];
  const attempt: AttemptRecord | undefined = first;
  return {
    testId: record.testId,
    name: record.name,
    filePath: record.filePath,
    errorType: attempt?.errorType,
    errorMessage: attempt?.errorMessage,
    errorStack: attempt?.errorStack,
    environment: attempt?.environment,
    browser: attempt?.browser,
  };
}

/**
 * Primary-vs-cascade detection. Honest heuristic (documented limits):
 *   - PRIMARY: representative error matches dependency/connection patterns AND
 *     ≥ 2 other clusters share the representative's environment with start
 *     times within ±5 minutes of the primary's earliest failure;
 *   - CASCADE: any non-primary cluster in the same environment that started
 *     after a primary within the 5-minute window.
 * Failures without a parseable timestamp or attempts are ignored by the
 * window math. Same-environment + tight timing is correlation, not proven
 * causation — the output exists to focus human investigation.
 */
export function detectPrimaryCascade(
  clusters: SimpleCluster[],
  failures: FailedTestRecord[],
): { primaryIds: string[]; cascadeIds: string[] } {
  const meta = new Map<string, { env: string; t0: number }>();
  for (const f of failures) {
    const failed = f.attempts.filter((a) => a.status === 'failed' || a.status === 'timedout');
    const first = failed[0] ?? f.attempts[0];
    if (!first) continue;
    const t = Date.parse(first.timestamp);
    if (Number.isNaN(t)) continue;
    const existing = meta.get(f.testId);
    if (existing) {
      existing.t0 = Math.min(existing.t0, t);
    } else {
      meta.set(f.testId, { env: first.environment.length > 0 ? first.environment : 'unknown', t0: t });
    }
  }

  const info = clusters.map((cluster) => {
    const envs = cluster.testIds
      .map((id) => meta.get(id)?.env)
      .filter((e): e is string => typeof e === 'string');
    const times = cluster.testIds
      .map((id) => meta.get(id)?.t0)
      .filter((t): t is number => typeof t === 'number');
    return {
      id: cluster.id,
      cluster,
      env: envs[0] ?? 'unknown',
      t0: times.length > 0 ? Math.min(...times) : Number.NaN,
      dependencyLike:
        DEPENDENCY_ENV_RE.test(cluster.signature) ||
        (cluster.representative ? DEPENDENCY_ENV_RE.test(cluster.representative.errorType) : false),
    };
  });

  const primaryIds = info
    .filter(
      (c) =>
        c.dependencyLike &&
        Number.isFinite(c.t0) &&
        info.filter((o) => o.id !== c.id && o.env === c.env && Number.isFinite(o.t0) && Math.abs(o.t0 - c.t0) <= CASCADE_WINDOW_MS)
          .length >= 2,
    )
    .map((c) => c.id);

  const cascadeIds = info
    .filter(
      (c) =>
        !primaryIds.includes(c.id) &&
        Number.isFinite(c.t0) &&
        info.some(
          (p) =>
            primaryIds.includes(p.id) && p.env === c.env && Number.isFinite(p.t0) && c.t0 >= p.t0 && c.t0 - p.t0 <= CASCADE_WINDOW_MS,
        ),
    )
    .map((c) => c.id);

  return { primaryIds, cascadeIds };
}
