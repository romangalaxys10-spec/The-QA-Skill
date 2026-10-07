import { createHash } from 'node:crypto';

/**
 * Failure signature normalization + root-cause clustering.
 * Signature = error type + normalized stack frames + test file + browser + env.
 * Normalization strips absolute paths, versions, ports, IDs, and line numbers
 * so that "the same failure" maps to the same signature across runs.
 */

export interface RawFailure {
  testId: string;
  name: string;
  filePath: string;
  errorType?: string;
  errorMessage?: string;
  errorStack?: string;
  browser?: string;
  environment?: string;
}

export interface NormalizedSignature {
  /** Short stable hash — the cluster id. */
  id: string;
  /** Human-readable normalized signature string. */
  signature: string;
  errorType: string;
  normalizedMessage: string;
  normalizedFrames: string[];
}

const NOISE_PATTERNS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  { re: /\/[\w.\-/]+node_modules\//g, replacement: '<nm>/' },
  { re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?\b/g, replacement: '<ts>' },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replacement: '<uuid>' },
  { re: /0x[0-9a-f]+/gi, replacement: '<hex>' },
  { re: /(https?:\/\/[^\s:'"]+):\d+(?::\d+)?/g, replacement: '$1:<port>' },
  { re: /:\d+:\d+/g, replacement: ':<line>' },
  { re: /:\d+/g, replacement: ':<line>' },
  { re: /\b\d+(\.\d+)+(ms|s|kb|mb|gb)?\b/gi, replacement: '<num>' },
  { re: /(?<![\w])\d{2,}(?![\w])/g, replacement: '<num>' },
  { re: /expected.+to.+equal.+/gi, replacement: 'expected <x> to equal <y>' },
  { re: /expected.+to.+(contain|match|have).+/gi, replacement: 'expected <x> to <op> <y>' },
];

export function normalizeMessage(message: string): string {
  let out = message;
  for (const { re, replacement } of NOISE_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out.trim().slice(0, 300);
}

/** First meaningful stack frames (test file first), normalized. */
export function normalizeFrames(stack: string | undefined, maxFrames = 3): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const m = line.match(/(?:at\s+)?(?:.*?\()?([^\s()]+?):\d+:\d+\)?/);
    if (!m || !m[1]) continue;
    let frame = m[1];
    const nmIdx = frame.lastIndexOf('node_modules/');
    if (nmIdx >= 0) frame = `<nm>/${frame.slice(nmIdx + 'node_modules/'.length)}`;
    frames.push(frame.replace(/:\d+:\d+$/, '').replace(/:\d+$/, ''));
    if (frames.length >= maxFrames) break;
  }
  return frames;
}

export function buildSignature(failure: RawFailure): NormalizedSignature {
  const errorType = failure.errorType ?? 'UnknownError';
  const normalizedMessage = normalizeMessage(failure.errorMessage ?? '');
  const normalizedFrames = normalizeFrames(failure.errorStack);
  const parts = [errorType, normalizedMessage, normalizedFrames.join('|'), failure.filePath, failure.browser ?? 'any', failure.environment ?? 'any'];
  const canonical = parts.join('§');
  const id = createHash('sha256').update(canonical).digest('hex').slice(0, 8);
  return { id, signature: `${errorType}: ${normalizedMessage}`, errorType, normalizedMessage, normalizedFrames };
}

/** Jaccard similarity over normalized tokens of two signatures. */
export function signatureSimilarity(a: NormalizedSignature, b: NormalizedSignature): number {
  const tokenize = (s: NormalizedSignature): Set<string> => {
    const tokens = `${s.errorType} ${s.normalizedMessage} ${s.normalizedFrames.join(' ')}`
      .toLowerCase()
      .split(/[^a-z<>/_]+/)
      .filter((t) => t.length > 2);
    return new Set(tokens);
  };
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

export interface ClusterOptions {
  /** Similarity threshold above which failures merge into one cluster. */
  threshold?: number;
}

export interface SimpleCluster {
  id: string;
  signature: string;
  testIds: string[];
  representative: NormalizedSignature;
}

/** Cluster raw failures: exact signature id first, then token similarity merge. */
export function clusterFailures(failures: RawFailure[], opts: ClusterOptions = {}): SimpleCluster[] {
  const threshold = opts.threshold ?? 0.6;
  const entries = failures.map((f) => ({ raw: f, sig: buildSignature(f) }));
  const clusters: SimpleCluster[] = [];

  for (const entry of entries) {
    let merged = false;
    for (const cluster of clusters) {
      if (signatureSimilarity(cluster.representative, entry.sig) >= threshold) {
        if (!cluster.testIds.includes(entry.raw.testId)) cluster.testIds.push(entry.raw.testId);
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({ id: entry.sig.id, signature: entry.sig.signature, testIds: [entry.raw.testId], representative: entry.sig });
    }
  }
  return clusters.sort((a, b) => b.testIds.length - a.testIds.length);
}
