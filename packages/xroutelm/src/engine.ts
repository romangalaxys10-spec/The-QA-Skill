import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DecisionSet, JournalEntry, RouteDecision, RouteTarget } from './types.js';
import { ScorerRegistry, routeQuestion } from './scorers.js';

/**
 * Decision engine + journal + learning router.
 *
 * - `decide()` evaluates System One questions about a state.
 * - `route()` is the flagship decision: which engine/skill/model should own
 *   this task — Jev's model-routing use case, native to the Fable ecosystem.
 * - Every decision is journaled (JSONL) with its evidence; route outcomes
 *   feed success-rate learning that nudges future selections (opt-in).
 */

export class DecisionEngine {
  constructor(
    private readonly registry: ScorerRegistry,
    private readonly journalPath?: string,
  ) {}

  stateHash(state: string): string {
    return createHash('sha256').update(state.trim().toLowerCase()).digest('hex').slice(0, 16);
  }

  async decide(state: string, requests: Parameters<ScorerRegistry['resolve']>[0] extends never ? never : import('./types.js').QuestionRequest[], preferred?: string): Promise<DecisionSet> {
    const { scorer, fallbacksUsed } = this.registry.resolve(preferred);
    const decisions = await scorer.evaluate(state, requests);
    const set: DecisionSet = {
      stateHash: this.stateHash(state),
      decisions,
      scorer: fallbacksUsed.length > 0 ? `${scorer.id} (fallbacks: ${fallbacksUsed.join('; ')})` : scorer.id,
      totalDurationMs: decisions.reduce((acc, d) => acc + d.durationMs, 0),
      label: 'INFERRED',
    };
    this.journal({ kind: 'decision', entry: set, state });
    return set;
  }

  async route(state: string, targets: RouteTarget[], preferred?: string): Promise<RouteDecision> {
    const { scorer, fallbacksUsed } = this.registry.resolve(preferred);
    const [result] = await scorer.evaluate(state, [routeQuestion(targets)]);
    if (result === undefined || result.answer.type !== 'choice') {
      throw new Error('router produced no choice answer');
    }
    const answer = result.answer;
    const ranked = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
    const decision: RouteDecision = {
      target: answer.selected,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      fallback: ranked.slice(1).map(([id]) => id),
      scorer: fallbacksUsed.length > 0 ? `${scorer.id} (fallbacks: ${fallbacksUsed.join('; ')})` : scorer.id,
      evidence: answer.evidence,
      label: 'INFERRED',
    };
    this.journal({ kind: 'route', entry: { stateHash: this.stateHash(state), decision }, state });
    return decision;
  }

  private journal(opts: { kind: 'decision' | 'route'; entry: unknown; state: string }): void {
    if (this.journalPath === undefined) return;
    const line: JournalEntry = {
      ts: new Date().toISOString(),
      kind: opts.kind,
      stateHash: this.stateHash(opts.state),
      statePreview: opts.state.replace(/\s+/g, ' ').trim().slice(0, 80),
      payload: opts.entry,
      scorer: 'engine',
    };
    const dir = dirname(this.journalPath);
    if (dir) mkdirSync(dir, { recursive: true });
    appendFileSync(this.journalPath, JSON.stringify(line) + '\n', 'utf8');
  }
}

/** Default route targets: the QA operating system's engines/skills. */
export function defaultTargets(): RouteTarget[] {
  return [
    { id: 'qa-enterprise', description: 'Full QA lifecycle gateway for repositories, pull requests, and releases', keywords: ['repo', 'pr', 'release', 'lifecycle', 'orchestrate'] },
    { id: 'qa-impact-analysis', description: 'Select the smallest relevant test set for a code change or commit range', keywords: ['diff', 'commit', 'affected tests', 'selection'] },
    { id: 'qa-risk-analysis', description: 'Score the risk of a change across eight weighted factors', keywords: ['risk', 'score', 'dangerous', 'blast radius', 'payment', 'checkout', 'charge', 'refund', 'coupon', 'discount', 'deadlock', 'race', 'concurrency', 'queue', 'rate limiter'] },
    { id: 'qa-failure-triage', description: 'Classify and cluster test failures into categories with root causes', keywords: ['failure', 'error', 'broken', 'cluster', 'root cause', 'wrong', 'incorrect', 'fails'] },
    { id: 'qa-test-healing', description: 'Propose confidence-tiered repairs for broken or drifted tests', keywords: ['heal', 'repair', 'locator', 'flaky fix'] },
    { id: 'qa-test-generation', description: 'Generate test cases from requirements using eight heuristics', keywords: ['generate tests', 'new feature', 'spec', 'cases'] },
    { id: 'qa-flake-detection', description: 'Score and quarantine flaky tests from run history', keywords: ['flaky', 'quarantine', 'unstable', 'retry', 'intermittent', 'sometimes', 'slowly', 'passes on second attempt'] },
    { id: 'qa-release-gate', description: 'Evaluate release readiness and emit a blocking verdict', keywords: ['release', 'gate', 'ship', 'verdict'] },
  ];
}

/**
 * Route-outcome learning: appends outcomes and nudges future routing by
 * demoting consistently unsuccessful targets. Reads/writes a JSONL stats
 * file; never mutates behavior silently (records include the effect note).
 */
export class RouteStats {
  constructor(private readonly filePath: string) {}

  record(target: string, success: boolean, note: string): void {
    const dir = dirname(this.filePath);
    if (dir) mkdirSync(dir, { recursive: true });
    appendFileSync(
      this.filePath,
      JSON.stringify({ ts: new Date().toISOString(), target, success, note }) + '\n',
      'utf8',
    );
  }

  /** Success rate per target over the trailing window; empty map when no data. */
  rates(windowSize = 50): Map<string, { rate: number; samples: number }> {
    if (!existsSync(this.filePath)) return new Map();
    const lines = readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean).slice(-windowSize);
    const agg = new Map<string, { ok: number; n: number }>();
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as { target: string; success: boolean };
        const cur = agg.get(rec.target) ?? { ok: 0, n: 0 };
        cur.n += 1;
        if (rec.success) cur.ok += 1;
        agg.set(rec.target, cur);
      } catch {
        // Skip malformed lines; the journal is advisory data.
      }
    }
    const out = new Map<string, { rate: number; samples: number }>();
    for (const [target, { ok, n }] of agg) out.set(target, { rate: ok / n, samples: n });
    return out;
  }

  /**
   * Apply learning: targets with ≥5 samples and <0.3 success drop one rank;
   * ≥0.7 success rise one rank. Returns a new target list (never mutates
   * the input) — the effect is documented in every journal entry.
   */
  apply(targets: RouteTarget[]): RouteTarget[] {
    const rates = this.rates();
    if (rates.size === 0) return targets;
    const adjusted = targets.map((t) => {
      const r = rates.get(t.id);
      const boost = r !== undefined && r.samples >= 5 ? (r.rate < 0.3 ? -1 : r.rate >= 0.7 ? 1 : 0) : 0;
      return { ...t, description: t.description, keywords: t.keywords, _boost: boost } as RouteTarget & { _boost: number };
    });
    return adjusted
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (b.t._boost - a.t._boost) || (a.i - b.i))
      .map(({ t }) => {
        const { _boost, ...rest } = t as RouteTarget & { _boost: number };
        return rest;
      });
  }
}
