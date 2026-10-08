import type { ExplainableConclusion } from '@the-qa-skill/core';

import { CLASSIFICATION_SCHEMA, reasoningEvidence, summarizeInput } from './internal.js';
import { ProviderError, type ReasoningProvider } from './provider.js';

/**
 * @the-qa-skill/reasoning — the deterministic provider.
 *
 * Produces 'INFERRED'-labeled conclusions WITHOUT any model call. The results
 * are honest structural descriptors of the input (never fabricated content):
 *  - analyze  → a structural descriptor + derived observations of the input;
 *  - generate → a scaffold of suggestions derived from the input shape;
 *  - classify → keyword scoring over the requested categories, with counts.
 * Every conclusion has fallbackUsed: true so callers can see a model was not
 * consulted, and confidence is derived from signal strength, never above 0.85.
 */

/** Justification for the double cast: the provider cannot know the caller's T.
 * It returns a documented, structured descriptor; the caller owns the schema
 * (that is what schemaHint declares) and performs the single narrowing cast. */
function asResult<T>(value: object): T {
  return value as unknown as T;
}

const BASE_ASSUMPTIONS: readonly string[] = [
  'No model was consulted; the conclusion is derived purely from documented heuristics over the input.',
];

const CLASSIFY_ASSUMPTIONS: readonly string[] = [
  ...BASE_ASSUMPTIONS,
  'Category keywords are matched as case-insensitive substrings of the JSON-serialized input, including key names.',
];

/** Structural description of the input, produced by analyze. */
function describeInput(input: unknown): {
  inputType: string;
  keyCount?: number;
  keys?: string[];
  itemCount?: number;
  length?: number;
} {
  if (input === null) return { inputType: 'null' };
  if (Array.isArray(input)) return { inputType: 'array', itemCount: input.length };
  const t = typeof input;
  if (t === 'object') {
    const keys = Object.keys(input as Record<string, unknown>);
    return { inputType: 'object', keyCount: keys.length, keys: keys.slice(0, 12) };
  }
  if (t === 'string') return { inputType: 'string', length: (input as string).length };
  return { inputType: t };
}

/** Count non-overlapping occurrences of `needle` in `haystack` (both lowercase). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** Tokens of a category name: split on non-alphanumerics, drop short noise. */
function categoryTokens(category: string): string[] {
  return category
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

/** Serialize input for keyword scoring; falls back to String() on cycles. */
function toScorableText(input: unknown): string {
  if (typeof input === 'string') return input.toLowerCase();
  try {
    return (JSON.stringify(input) ?? String(input)).toLowerCase();
  } catch {
    return String(input).toLowerCase();
  }
}

/**
 * The always-available, never-networked provider. `isConfigured()` is
 * constant true so registries can always resolve a usable provider.
 */
export class DeterministicProvider implements ReasoningProvider {
  readonly id = 'deterministic';

  /** Always true — this provider has no external dependencies. */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Analyze: return a structural descriptor of the input (type, keys/sizes)
   * plus the observations derived from it. Confidence is a documented
   * constant (0.6): the observations are factual, but no semantics were
   * understood.
   */
  async analyze<T>(objective: string, input: unknown, schemaHint: string): Promise<ExplainableConclusion<T>> {
    const inputSummary = summarizeInput(input);
    const descriptor = describeInput(input);
    const observations: string[] = [];
    if (descriptor.keys && descriptor.keys.length > 0) {
      observations.push(`input exposes ${descriptor.keyCount} top-level keys: ${descriptor.keys.join(', ')}`);
    }
    if (descriptor.itemCount !== undefined) observations.push(`input is an array with ${descriptor.itemCount} items`);
    if (descriptor.length !== undefined) observations.push(`input is a string of ${descriptor.length} characters`);
    if (observations.length === 0) observations.push('input is a primitive or empty value — no structure to expand');

    const summary = `deterministic structural analysis produced ${observations.length} observation(s)`;
    return {
      result: asResult<T>({ kind: 'input_descriptor', ...descriptor, observations }),
      confidence: 0.6,
      reasoningObjective: objective,
      inputSummary,
      outputSchema: schemaHint,
      evidence: [reasoningEvidence(`${summary}; ${observations.join('; ')}`)],
      assumptions: [...BASE_ASSUMPTIONS],
      fallbackUsed: true,
    };
  }

  /**
   * Generate: return a deterministic scaffold — suggestions derived from the
   * input shape (per-key expectations for objects, enumeration for arrays).
   * Confidence is a documented constant (0.4): this is a checklist, not
   * generated content, and it must never be presented as such.
   */
  async generate<T>(objective: string, input: unknown, schemaHint: string): Promise<ExplainableConclusion<T>> {
    const inputSummary = summarizeInput(input);
    const suggestions: string[] = [];
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      const keys = Object.keys(input as Record<string, unknown>);
      for (const key of keys.slice(0, 8)) suggestions.push(`address '${key}' explicitly in the output`);
    } else if (Array.isArray(input)) {
      suggestions.push(`enumerate all ${input.length} input items in the output`);
    } else if (typeof input === 'string' && input.length > 0) {
      suggestions.push('ground the output in the provided text');
    }
    suggestions.push('verify the result against the schema hint before trusting it');

    const summary = `deterministic scaffold with ${suggestions.length} suggestion(s); no content was fabricated`;
    return {
      result: asResult<T>({ kind: 'deterministic_scaffold', generated: false, schemaHint, suggestions }),
      confidence: 0.4,
      reasoningObjective: objective,
      inputSummary,
      outputSchema: schemaHint,
      evidence: [reasoningEvidence(`${summary}: ${suggestions.join('; ')}`)],
      assumptions: [...BASE_ASSUMPTIONS, 'The scaffold lists what a model should produce; it is not the produced content.'],
      fallbackUsed: true,
    };
  }

  /**
   * Classify: keyword scoring over `categories`. Each category's name is
   * tokenized (split on non-alphanumerics, tokens of 3+ chars); every token
   * occurrence (case-insensitive substring) in the serialized input adds 1 to
   * that category's score. The top-scoring category wins (first on ties).
   *
   * Confidence from signal strength — documented formula, capped at 0.85:
   *   no keyword matched anywhere        → 0.10
   *   otherwise 0.45 + 0.4 * margin/top  where margin = topScore - secondScore
   * (a clean single-category match → 0.85; an even race → ~0.45).
   * Result: { category, runnerUp, scores, matchedKeywords }.
   */
  async classify<T>(objective: string, input: unknown, categories: readonly string[]): Promise<ExplainableConclusion<T>> {
    if (categories.length === 0) {
      throw new ProviderError('classify requires a non-empty category list');
    }
    const inputSummary = summarizeInput(input);
    const text = toScorableText(input);
    const scores: Record<string, number> = {};
    const matchedKeywords: string[] = [];
    for (const category of categories) {
      let score = 0;
      for (const token of categoryTokens(category)) {
        const count = countOccurrences(text, token);
        if (count > 0) {
          score += count;
          matchedKeywords.push(`${category}:${token}×${count}`);
        }
      }
      scores[category] = score;
    }

    let best = categories[0];
    if (best === undefined) throw new ProviderError('classify requires a non-empty category list');
    let bestScore = scores[best] ?? 0;
    let secondScore = 0;
    let runnerUp: string | null = null;
    for (const category of categories.slice(1)) {
      const score = scores[category];
      if (score !== undefined && score > bestScore) {
        secondScore = bestScore;
        runnerUp = best;
        best = category;
        bestScore = score;
      } else if (score !== undefined && score > secondScore) {
        secondScore = score;
        runnerUp = category;
      }
    }

    const confidence =
      bestScore === 0 ? 0.1 : Math.min(0.85, 0.45 + (0.4 * (bestScore - secondScore)) / bestScore);

    const scoreLine = categories.map((c) => `${c}=${scores[c] ?? 0}`).join(', ');
    const summary = `keyword scoring: ${scoreLine}; matched: ${matchedKeywords.length > 0 ? matchedKeywords.join(', ') : 'none'}`;
    return {
      result: asResult<T>({ category: best, runnerUp, scores, matchedKeywords }),
      confidence,
      reasoningObjective: objective,
      inputSummary,
      outputSchema: CLASSIFICATION_SCHEMA,
      evidence: [reasoningEvidence(summary)],
      assumptions: [...CLASSIFY_ASSUMPTIONS],
      fallbackUsed: true,
    };
  }
}
