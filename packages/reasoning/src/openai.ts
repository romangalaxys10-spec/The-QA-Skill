import type { ExplainableConclusion } from '@the-qa-skill/core';

import {
  CLASSIFICATION_SCHEMA,
  buildConclusion,
  extractOpenAIContent,
  postJson,
  summarizeInput,
  systemPrompt,
} from './internal.js';
import { ProviderError, type ReasoningProvider } from './provider.js';

/**
 * @the-qa-skill/reasoning — OpenAI chat-completions provider.
 *
 * SECURITY: the API key is read from constructor options or the
 * OPENAI_API_KEY environment variable and is only ever sent in the
 * Authorization header. It is never logged, never embedded in request bodies,
 * and never included in error messages.
 */

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

/** Constructor options. `fetchImpl` enables fully mocked tests (no network). */
export interface OpenAIProviderOptions {
  apiKey?: string;
  model?: string;
  /** Defaults to https://api.openai.com/v1; a custom value replaces it fully and should include the version path. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** OpenAIReasoningProvider over POST {baseUrl}/chat/completions. */
export class OpenAIProvider implements ReasoningProvider {
  readonly id = 'openai';

  private readonly apiKey?: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env['OPENAI_API_KEY'];
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** True when an API key is available (option or OPENAI_API_KEY env var). */
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
      throw new ProviderError('openai provider is not configured: set OPENAI_API_KEY or pass apiKey');
    }
    const inputSummary = summarizeInput(input);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt(schemaHint, categories) },
        { role: 'user', content: JSON.stringify({ objective, input, schemaHint, categories }) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    };
    const payload = await postJson(
      this.fetchImpl,
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      },
      { providerId: this.id, timeoutMs: this.timeoutMs },
    );
    const content = extractOpenAIContent(payload);
    let raw: unknown;
    try {
      raw = JSON.parse(content) as unknown;
    } catch (e) {
      throw new ProviderError('openai message content is not valid JSON', { cause: e });
    }
    return buildConclusion<T>(raw, { objective, inputSummary, schemaHint });
  }
}
