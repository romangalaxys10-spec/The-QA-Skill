import type { Evidence, ExplainableConclusion, VerificationLabel } from '@the-qa-skill/core';

import { ProviderError } from './provider.js';

/**
 * @the-qa-skill/reasoning — internal helpers shared by all providers.
 * Not exported from the package barrel: this is implementation detail.
 */

/** All legal VerificationLabel values (mirrors core.types). */
const LABELS: readonly VerificationLabel[] = ['NOT_VERIFIED', 'NOT_RUN', 'INFERRED', 'OBSERVED', 'CONFIRMED'];

/**
 * Schema id used for classify() conclusions, which have no schemaHint
 * parameter (the categories list IS the schema). Shared by every provider so
 * consumers can branch on it consistently.
 */
export const CLASSIFICATION_SCHEMA = 'reasoning.Classification.v1';

/** FNV-1a 32-bit hash rendered as 8 hex chars — stable evidence ids. */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Truncate a string, appending an ellipsis when cut. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Compact, type-tagged summary of an arbitrary input for `inputSummary`.
 * Bounded in length so huge payloads never leak into conclusions verbatim.
 */
export function summarizeInput(input: unknown, max = 240): string {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else {
    try {
      text = JSON.stringify(input) ?? String(input);
    } catch {
      text = String(input);
    }
  }
  const kind = input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input;
  const full = `${kind}: ${text}`;
  return full.length <= max ? full : `${truncate(full, max - 1)}…`;
}

/** Build the single 'reasoning'-kind evidence item every conclusion requires. */
export function reasoningEvidence(summary: string): Evidence {
  return {
    id: `ev-${shortHash(summary)}`,
    kind: 'reasoning',
    summary,
    collectedAt: new Date().toISOString(),
    label: 'INFERRED',
  };
}

/** The system prompt sent to model providers. Enforces JSON-only output. */
export function systemPrompt(schemaHint: string, categories?: readonly string[]): string {
  const lines = [
    'You are the reasoning engine of The-QA-Skill, a deterministic-first QA platform.',
    'Respond with a single JSON object and nothing else — no prose, no markdown fences.',
    'The JSON object MUST contain these keys:',
    '  - "result": the answer, conforming to the schema hint below;',
    '  - "confidence": a number between 0 and 1;',
    '  - "evidence": a NON-EMPTY array of objects shaped { "id": string, "summary": string, "location"?: string };',
    '  - "assumptions": an array of strings (may be empty);',
    '  - "reasoningObjective", "inputSummary", "outputSchema": strings echoing the objective, the input and the schema hint.',
    'Every claim must be backed by evidence. Never invent data that is not present in or derivable from the input.',
    `Schema hint: ${schemaHint}`,
  ];
  if (categories && categories.length > 0) {
    lines.push(`"result.category" MUST be exactly one of: ${categories.join(', ')}.`);
  }
  return lines.join('\n');
}

/** Context used to backfill conclusion fields the provider omitted. */
export interface ConclusionContext {
  objective: string;
  inputSummary: string;
  schemaHint: string;
}

/**
 * Normalize a raw model JSON payload into an ExplainableConclusion:
 *  - confidence must be a finite number and is clamped into [0, 1];
 *  - evidence must be a non-empty array; every item is mapped to kind
 *    'reasoning' with a generated id and INFERRED label when absent;
 *  - assumptions are coerced to a string array;
 *  - fallbackUsed is always false (this path means a model responded).
 * Malformed payloads throw ProviderError — garbage in never becomes a verdict.
 */
export function buildConclusion<T>(raw: unknown, ctx: ConclusionContext): ExplainableConclusion<T> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProviderError('provider payload must be a JSON object');
  }
  const record = raw as Record<string, unknown>;

  if (!('result' in record) || record['result'] === undefined) {
    throw new ProviderError('provider payload is missing "result"');
  }

  const confidenceRaw = record['confidence'];
  if (typeof confidenceRaw !== 'number' || !Number.isFinite(confidenceRaw)) {
    throw new ProviderError('provider payload "confidence" must be a finite number');
  }
  const confidence = Math.min(1, Math.max(0, confidenceRaw));

  const evidenceRaw = record['evidence'];
  if (!Array.isArray(evidenceRaw) || evidenceRaw.length === 0) {
    throw new ProviderError('provider payload must include a non-empty "evidence" array');
  }
  const collectedAt = new Date().toISOString();
  const evidence: Evidence[] = evidenceRaw.map((item, index) => {
    if (typeof item === 'string') {
      return { id: `ev-${shortHash(item)}`, kind: 'reasoning', summary: item, collectedAt, label: 'INFERRED' };
    }
    if (typeof item !== 'object' || item === null) {
      throw new ProviderError(`provider evidence[${index}] must be an object or string`);
    }
    const entry = item as Record<string, unknown>;
    const summary = typeof entry['summary'] === 'string' ? entry['summary'] : truncate(JSON.stringify(entry) ?? '', 200);
    const labelRaw: unknown = entry['label'];
    const label = (LABELS as readonly unknown[]).includes(labelRaw) ? (labelRaw as VerificationLabel) : 'INFERRED';
    return {
      id: typeof entry['id'] === 'string' && entry['id'].length > 0 ? entry['id'] : `ev-${shortHash(summary)}-${index}`,
      kind: 'reasoning',
      location: typeof entry['location'] === 'string' ? entry['location'] : undefined,
      summary,
      collectedAt: typeof entry['collectedAt'] === 'string' ? entry['collectedAt'] : collectedAt,
      label,
    };
  });

  const assumptions = Array.isArray(record['assumptions'])
    ? (record['assumptions'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];

  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.length > 0 ? value : fallback;

  return {
    result: record['result'] as T,
    confidence,
    reasoningObjective: str(record['reasoningObjective'], ctx.objective),
    inputSummary: str(record['inputSummary'], ctx.inputSummary),
    outputSchema: str(record['outputSchema'], ctx.schemaHint),
    evidence,
    assumptions,
    fallbackUsed: false,
  };
}

/**
 * POST JSON and parse the response with strict error discipline. Timeouts use
 * an AbortController. Non-2xx responses, unreadable bodies and non-JSON
 * payloads all throw ProviderError. API keys travel only in headers and are
 * never included in error messages.
 */
export async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opts: { providerId: string; timeoutMs: number },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (e) {
    const reason = controller.signal.aborted
      ? `timed out after ${opts.timeoutMs}ms`
      : truncate((e as Error).message, 200);
    throw new ProviderError(`${opts.providerId} request failed (${reason})`, { cause: e });
  } finally {
    clearTimeout(timer);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (e) {
    throw new ProviderError(`${opts.providerId} failed reading response body`, { cause: e });
  }
  if (!response.ok) {
    throw new ProviderError(`${opts.providerId} API responded ${response.status}: ${truncate(text, 300)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw new ProviderError(`${opts.providerId} response was not valid JSON`, { cause: e });
  }
}

/** Pull the message content string out of an OpenAI chat completion payload. */
export function extractOpenAIContent(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new ProviderError('openai response payload must be an object');
  }
  const choices = (payload as Record<string, unknown>)['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderError('openai response has no choices');
  }
  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    throw new ProviderError('openai choices[0] is not an object');
  }
  const message = (first as Record<string, unknown>)['message'];
  if (typeof message !== 'object' || message === null) {
    throw new ProviderError('openai choices[0].message is missing');
  }
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content !== 'string' || content.length === 0) {
    throw new ProviderError('openai choices[0].message.content is missing or empty');
  }
  return content;
}

/** Pull the first text block out of an Anthropic messages payload. */
export function extractAnthropicText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new ProviderError('anthropic response payload must be an object');
  }
  const content = (payload as Record<string, unknown>)['content'];
  if (!Array.isArray(content) || content.length === 0) {
    throw new ProviderError('anthropic response has no content blocks');
  }
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const record = block as Record<string, unknown>;
      if (record['type'] === 'text' && typeof record['text'] === 'string' && record['text'].length > 0) {
        return record['text'];
      }
    }
  }
  throw new ProviderError('anthropic response contains no text block');
}
