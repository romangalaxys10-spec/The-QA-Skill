/**
 * Lexical signal extraction for the heuristic scorer.
 * Zero dependencies: tokenizer + IDF + bigrams + weighted cosine.
 * These functions produce the raw scores that calibration turns into
 * probabilities — no constants anywhere.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'as', 'at', 'by', 'from', 'into', 'about', 'can', 'do', 'does', 'did', 'has', 'have', 'had',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'my', 'your', 'our', 'their',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(`${tokens[i]}_${tokens[i + 1]}`);
  }
  return out;
}

/** Multi-word anchors ("rate limit") become both a phrase token and unigrams. */
export function anchorTokens(anchor: string): string[] {
  const lower = anchor.toLowerCase().trim();
  const unigrams = tokenize(lower);
  const phrase = lower.replace(/[^a-z0-9]+/g, '_');
  return unigrams.length > 1 ? [...unigrams, phrase] : unigrams;
}

/** Inverse document frequency over a small corpus of documents (token arrays). */
export function idf(corpus: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of corpus) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = Math.max(1, corpus.length);
  const out = new Map<string, number>();
  for (const [t, count] of df) out.set(t, Math.log((n + 1) / (count + 0.5)) + 1);
  return out;
}

/**
 * Weighted cosine similarity between two token sets with IDF weights.
 * Returns 0..1 (cosine of term-frequency vectors, IDF-weighted).
 */
export function weightedCosine(a: string[], b: string[], weights: Map<string, number>): number {
  const tf = (tokens: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const va = tf(a);
  const vb = tf(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  const weightOf = (t: string): number => weights.get(t) ?? 1;
  for (const [t, f] of va) {
    const w = weightOf(t);
    na += (f * w) ** 2;
    const fb = vb.get(t);
    if (fb !== undefined) dot += f * fb * w * w;
  }
  for (const [t, f] of vb) {
    const w = weightOf(t);
    nb += (f * w) ** 2;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Logistic calibration: map a raw similarity to a probability.
 * k controls steepness, s0 the midpoint — chosen so that a moderate
 * lexical overlap (~0.35 cosine with anchors) lands near 0.5 and strong
 * anchored overlaps saturate near 1. The constants shape the curve; the
 * *value* always comes from the measured similarity.
 */
export function calibrate(raw: number, k = 9, s0 = 0.32): number {
  const p = 1 / (1 + Math.exp(-k * (raw - s0)));
  // Clamp to avoid claiming certainty from lexical signals alone.
  return Math.min(0.98, Math.max(0.02, p));
}
