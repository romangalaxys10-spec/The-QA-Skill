import type { ExplainableConclusion } from '@the-qa-skill/core';

import {
  CLASSIFICATION_SCHEMA,
  buildConclusion,
  extractAnthropicText,
  postJson,
  summarizeInput,
  systemPrompt,
} from './internal.js';
import { ProviderError, type ReasoningProvider } from './provider.js';

/**
 * @the-qa-skill/reasoning — Anthropic messages provider.
 *
 * SECURITY: the API key is read from constructor options or the
 * ANTHROPIC_API_KEY environment variable and is only ever sent in the
 * x-api-key header. It is never logged, never embedded in request bodies,
 * and never included in error messages.
 */

const DEFAULT_MODEL = 'claude-3-5-haiku-latest';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Constructor options. `fetchImpl` enables fully mocked tests (no network). */
export interface AnthropicProviderOptions {
  apiKey?: string;
  model?: string;
  /** Defaults to https://api.anthropic.com; the /v1/messages path is appended. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
}

/** AnthropicReasoningProvider over POST {baseUrl}/v1/messages. */
export class AnthropicProvider implements ReasoningProvider {
  readonly id = 'anthropic';

  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /** True when an API key is available (option or ANTHROPIC_API_KEY env var). */
  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  /** @inheritdoc */
  analyze<T>(objective: string, input: unknown, schemaHint: string): Promise<ExplainableConclusion<T>> {
    return this.conclude<T>(objective, input, schemaHint);
  }

  /** @inheritdoc */
  generate<T>(objective: string, input: unknown, schemaHint: string): Promise<ExplainableConclusion<T>> {
    return this.conclude<T>(objective, input, schemaHint);
  }

  /** @inheritdoc */
  classify<T>(objective: string, input: unknown, categories: readonly string[]): Promise<ExplainableConclusion<T>> {
    return this.conclude<T>(objective, input, CLASSIFICATION_SCHEMA, categories);
  }

  private async conclude<T>(
    objective: string,
    input: unknown,
    schemaHint: string,
    categories?: readonly string[],
  ): Promise<ExplainableConclusion<T>> {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new ProviderError('anthropic provider is not configured: set ANTHROPIC_API_KEY or pass apiKey');
    }
    const inputSummary = summarizeInput(input);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0,
      system: systemPrompt(schemaHint, categories),
      messages: [{ role: 'user', content: JSON.stringify({ objective, input, schemaHint, categories }) }],
    };
    const payload = await postJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      },
      { providerId: this.id, timeoutMs: this.timeoutMs },
    );
    const text = extractAnthropicText(payload);
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (e) {
      throw new ProviderError('anthropic message content is not valid JSON', { cause: e });
    }
    return buildConclusion<T>(raw, { objective, inputSummary, schemaHint });
  }
}
