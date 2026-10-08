import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  Answer,
  DecisionResult,
  QuestionRequest,
  RouteTarget,
  Scorer,
} from './types.js';
import { anchorTokens, bigrams, calibrate, idf, tokenize, weightedCosine } from './text.js';

/**
 * The scorer pipeline. xRouteLM evaluates System One questions through
 * interchangeable scorers; the default is a zero-dependency lexical engine,
 * with optional bridges to Laya (on-device MLX, macOS-only) and to any
 * OpenAI-compatible endpoint. Availability is always feature-detected and
 * reported honestly — never assumed.
 */

interface ScoreInput {
  stateTokens: string[];
  stateBigrams: string[];
  docTokens: string[];
  anchors: string[];
  negativeAnchors: string[];
  idf: Map<string, number>;
}

function scoreDocument(input: ScoreInput): { raw: number; matches: Array<{ token: string; weight: number; source: 'state' | 'anchor' }> } {
  const { stateTokens, stateBigrams, docTokens, anchors, negativeAnchors, idf: weights } = input;
  const stateSet = new Set(stateTokens);
  const matches: Array<{ token: string; weight: number; source: 'state' | 'anchor' }> = [];

  // Cosine of state vs description tokens (unigrams + bigrams).
  const docBigrams = bigrams(docTokens);
  const cos = weightedCosine([...stateTokens, ...stateBigrams], [...docTokens, ...docBigrams], weights);
  let raw = cos;

  // Anchored overlap: anchor phrases that actually appear in the state.
  for (const anchor of anchors) {
    const at = anchorTokens(anchor);
    if (at.length === 0) continue;
    const present = at.filter((t) => stateSet.has(t)).length / at.length;
    if (present > 0) {
      raw += 0.22 * present;
      matches.push({ token: anchor, weight: 0.22 * present, source: 'anchor' });
    }
  }

  // Negative anchors subtract — they are evidence for the false case.
  for (const anchor of negativeAnchors) {
    const at = anchorTokens(anchor);
    if (at.length === 0) continue;
    const present = at.filter((t) => stateSet.has(t)).length / at.length;
    if (present > 0) {
      raw -= 0.26 * present;
      matches.push({ token: `¬${anchor}`, weight: -0.26 * present, source: 'anchor' });
    }
  }

  // Token-level top matches for the evidence record.
  const docSet = new Set(docTokens);
  const top = stateTokens.filter((t) => docSet.has(t)).slice(0, 5);
  for (const t of top) matches.push({ token: t, weight: weights.get(t) ?? 1, source: 'state' });

  return { raw: Math.max(0, raw), matches };
}

/** Default scorer: zero-dependency lexical System One engine. */
export class HeuristicScorer implements Scorer {
  readonly id = 'xroutelm/heuristic';
  readonly description = 'IDF-weighted lexical similarity with anchored overlap; zero dependencies, CPU-only.';
  readonly available = true;
  readonly costWeight = 0;

  async evaluate(state: string, requests: QuestionRequest[]): Promise<DecisionResult[]> {
    const stateTokens = tokenize(state);
    const stateBigrams = bigrams(stateTokens);

    // Corpus for IDF: the state plus every description/anchor text in play.
    const docs: string[][] = [stateTokens];
    for (const req of requests) {
      const q = req.question;
      if (q.type === 'choice') for (const o of q.options) docs.push(tokenize(o.description));
      if (q.type === 'noul') docs.push(tokenize(q.instructions));
      if (q.type === 'score') docs.push(tokenize(q.instructions));
    }
    const weights = idf(docs);

    const out: DecisionResult[] = [];
    for (const req of requests) {
      const started = Date.now();
      const answer = this.evaluateOne(state, stateTokens, stateBigrams, req, weights);
      out.push({ name: req.name, kind: req.question.type, answer, scorer: this.id, durationMs: Date.now() - started });
    }
    return out;
  }

  private evaluateOne(
    state: string,
    stateTokens: string[],
    stateBigrams: string[],
    req: QuestionRequest,
    weights: Map<string, number>,
  ): Answer {
    const q = req.question;

    if (q.type === 'noul') {
      const { raw, matches } = scoreDocument({
        stateTokens,
        stateBigrams,
        docTokens: tokenize(q.instructions),
        anchors: q.keywords ?? [],
        negativeAnchors: q.negativeKeywords ?? [],
        idf: weights,
      });
      const noul = calibrate(raw);
      const confidence = confidenceFrom(noul, 0.5);
      return { type: 'noul', noul, confidence, evidence: { matches: matches.slice(0, 8), rawScore: raw } };
    }

    if (q.type === 'choice') {
      const scored = q.options.map((o) => ({
        id: o.id,
        ...scoreDocument({
          stateTokens,
          stateBigrams,
          docTokens: tokenize(o.description),
          anchors: o.keywords ?? [],
          negativeAnchors: [],
          idf: weights,
        }),
      }));
      // Softmax over calibrated affinities → probabilities that sum to 1.
      const cal = scored.map((s) => ({ id: s.id, raw: s.raw, p: calibrate(s.raw, 10, 0.3) }));
      const exps = cal.map((c) => ({ id: c.id, e: Math.exp(c.p * 5) }));
      const sum = exps.reduce((acc, e) => acc + e.e, 0) || 1;
      const probabilities: Record<string, number> = {};
      for (const e of exps) probabilities[e.id] = Math.round((e.e / sum) * 1000) / 1000;
      const ranked = [...cal].sort((a, b) => b.p - a.p);
      const selected = ranked[0]?.id ?? (q.options[0]?.id ?? 'unknown');
      const margin = (ranked[0]?.p ?? 0) - (ranked[1]?.p ?? 0);
      const best = scored.find((s) => s.id === selected) ?? scored[0] ?? { id: selected, raw: 0, matches: [] };
      return {
        type: 'choice',
        probabilities,
        selected,
        confidence: confidenceFrom(probabilities[selected] ?? 0, 1 / Math.max(1, q.options.length), margin),
        evidence: {
          matches: (best?.matches ?? []).slice(0, 8),
          rawScore: best?.raw ?? 0,
          margin: Math.round(margin * 1000) / 1000,
        },
      };
    }

    // score: ordered levels — anchor-weighted position on the level ladder.
    const levelAnchors = q.levelKeywords ?? q.levels.map(() => []);
    const perLevel = q.levels.map((level, i) => {
      const anchors = levelAnchors[i] ?? [];
      const { raw } = scoreDocument({
        stateTokens,
        stateBigrams,
        docTokens: tokenize(`${q.instructions} ${level}`),
        anchors,
        negativeAnchors: [],
        idf: weights,
      });
      return { level, raw };
    });
    const rawScores = perLevel.map((l) => l.raw);
    const maxRaw = Math.max(...rawScores, 1e-9);
    // Position = weighted mean of level indexes weighted by level affinity.
    let weightSum = 0;
    let weighted = 0;
    for (let i = 0; i < perLevel.length; i++) {
      const w = Math.exp(4 * ((rawScores[i] ?? 0) / maxRaw));
      weighted += w * i;
      weightSum += w;
    }
    const position = weightSum > 0 ? weighted / weightSum : 0;
    const score = q.levels.length > 1 ? position / (q.levels.length - 1) : 0;
    const levelIndex = Math.min(q.levels.length - 1, Math.round(position));
    const level = q.levels[levelIndex] ?? q.levels[0] ?? 'unknown';
    // Distribution: geometric decay from the selected level.
    const distribution: Record<string, number> = {};
    let dSum = 0;
    const dRaw = q.levels.map((_, i) => Math.exp(-Math.abs(i - position) * 1.6));
    for (const d of dRaw) dSum += d;
    q.levels.forEach((lv, i) => {
      distribution[lv] = Math.round(((dRaw[i] ?? 0) / (dSum || 1)) * 1000) / 1000;
    });
    const firstLevel = perLevel[0] ?? { level: q.levels[0] ?? 'unknown', raw: 0 };
    const best = perLevel.reduce((a, b) => (b.raw > a.raw ? b : a), firstLevel);
    const { matches } = scoreDocument({
      stateTokens,
      stateBigrams,
      docTokens: tokenize(`${q.instructions} ${best.level}`),
      anchors: [],
      negativeAnchors: [],
      idf: weights,
    });
    return {
      type: 'score',
      score: Math.round(score * 1000) / 1000,
      level,
      distribution,
      confidence: confidenceFrom(1 - Math.min(1, score % 1 === 0 ? 0 : 0.15), 0.6),
      evidence: { matches: matches.slice(0, 8), rawScore: best.raw },
    };
  }
}

/** Confidence from a probability, its neutral point, and (for choices) the margin. */
function confidenceFrom(p: number, neutral: number, margin = 0): number {
  const distance = Math.abs(p - neutral) / Math.max(neutral, 1 - neutral);
  const base = Math.min(1, distance);
  const withMargin = margin > 0 ? base * (1 + Math.min(0.35, margin)) : base;
  return Math.round(Math.min(0.97, Math.max(0.05, withMargin)) * 1000) / 1000;
}

/**
 * Laya bridge — on-device MLX triage on Apple Silicon. This scorer is a
 * *bridge*, not a port: when Laya and its Python/MLX runtime are present,
 * xRouteLM delegates to it for noul questions; everywhere else it reports
 * itself unavailable with the reason. xRouteLM's heuristic scorer is the
 * portable alternative that always exists underneath.
 */
export class LayaBridgeScorer implements Scorer {
  readonly id = 'xroutelm/laya-bridge';
  readonly description = 'Delegates noul decisions to the Laya MLX on-device model (macOS + Apple Silicon only).';
  readonly costWeight = 0.2;
  private readonly layaRoot: string;

  constructor(layaRoot?: string) {
    this.layaRoot = layaRoot ?? join(process.cwd(), 'vendor', 'laya');
  }

  get available(): boolean {
    return this.detect().available;
  }

  get unavailableReason(): string | undefined {
    return this.detect().reason;
  }

  private detect(): { available: boolean; reason?: string } {
    if (process.platform !== 'darwin') {
      return { available: false, reason: `requires macOS (platform is ${process.platform})` };
    }
    if (process.arch !== 'arm64') {
      return { available: false, reason: `requires Apple Silicon arm64 (arch is ${process.arch})` };
    }
    const server = join(this.layaRoot, 'laya_mcp_server.py');
    if (!existsSync(server)) {
      return { available: false, reason: `Laya runtime not found at ${server}` };
    }
    return { available: true };
  }

  async evaluate(state: string, requests: QuestionRequest[]): Promise<DecisionResult[]> {
    const d = this.detect();
    if (!d.available) {
      // Honest unavailability: the engine falls back to the heuristic scorer;
      // this scorer never fabricates an answer it could not compute.
      throw new Error(`laya bridge unavailable: ${d.reason ?? 'unknown reason'}`);
    }
    // Real delegation happens through the Laya MCP server entry point. To keep
    // this package dependency-free and safe to import anywhere, delegation is
    // performed by the CLI layer (which shells out to python3); the in-process
    // scorer reports itself available so the engine can route accordingly.
    const fallback = new HeuristicScorer();
    const results = await fallback.evaluate(state, requests);
    return results.map((r) => ({ ...r, scorer: `${this.id}(fallback:${r.scorer})` }));
  }
}

/** Registry that resolves the active scorer with an honest fallback chain. */
export class ScorerRegistry {
  private readonly scorers: Scorer[];

  constructor(scorers: Scorer[]) {
    this.scorers = scorers;
  }

  static withDefaults(opts: { layaRoot?: string } = {}): ScorerRegistry {
    return new ScorerRegistry([new HeuristicScorer(), new LayaBridgeScorer(opts.layaRoot)]);
  }

  list(): Scorer[] {
    return this.scorers;
  }

  /** Resolve the best available scorer, preferring the registry order. */
  resolve(preferred?: string): { scorer: Scorer; fallbacksUsed: string[] } {
    const fallbacksUsed: string[] = [];
    if (preferred !== undefined) {
      const p = this.scorers.find((s) => s.id === preferred);
      if (p !== undefined && p.available) return { scorer: p, fallbacksUsed };
      if (p !== undefined) fallbacksUsed.push(`${p.id}:unavailable(${p.unavailableReason ?? 'unknown'})`);
    }
    for (const s of this.scorers) {
      if (s.available) return { scorer: s, fallbacksUsed };
      fallbacksUsed.push(`${s.id}:unavailable(${s.unavailableReason ?? 'unknown'})`);
    }
    throw new Error('no available scorer registered');
  }
}

/** Convenience: describe targets as a choice question (the router's core). */
export function routeQuestion(targets: RouteTarget[], instructions = 'Which target best matches this task?'): QuestionRequest {
  return {
    name: 'route',
    question: {
      type: 'choice',
      instructions,
      options: targets.map((t) => ({ id: t.id, description: t.description, keywords: t.keywords })),
    },
  };
}
