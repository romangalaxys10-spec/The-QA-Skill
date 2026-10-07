import type { ExplainableConclusion } from '@the-qa-skill/core';

/**
 * @the-qa-skill/reasoning — the ReasoningProvider contract.
 *
 * The platform is deterministic-first: heuristic engines answer what they can,
 * and a ReasoningProvider is consulted only for genuinely open questions.
 * EVERY conclusion returned by ANY provider must be explainable: confidence in
 * [0,1], non-empty evidence (kind 'reasoning'), assumptions, input summary,
 * output schema id, and an honest fallbackUsed flag.
 */

/** Error thrown when a provider is misconfigured, fails, or returns garbage. */
export class ProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ProviderError';
    if (options && options.cause !== undefined) {
      // ES2022 Error cause — kept explicit so the original failure survives
      // even on runtimes that ignore error options.
      this.cause = options.cause;
    }
  }
}

/**
 * A reasoning backend. Implementations: DeterministicProvider (always
 * available, no model), OpenAIProvider, AnthropicProvider. Providers must
 * NEVER log or embed API keys; keys are read from constructor options or
 * environment variables only.
 */
export interface ReasoningProvider {
  /** Stable provider id, e.g. 'deterministic' | 'openai' | 'anthropic'. */
  readonly id: string;

  /**
   * Analyze an input against an objective and return a conclusion whose
   * `result` conforms to `schemaHint` (e.g. 'core.TriageResult.v1').
   */
  analyze<T>(objective: string, input: unknown, schemaHint: string): Promise<ExplainableConclusion<T>>;

  /**
   * Generate content for an objective. Deterministic implementations return
   * scaffolds, not fabricated content; model implementations return the model
   * output wrapped in the same explainability envelope.
   */
  generate<T>(objective: string, input: unknown, schemaHint: string): Promise<ExplainableConclusion<T>>;

  /**
   * Classify `input` into exactly one of `categories`. The conclusion's
   * `result` must identify the chosen category and how it was scored.
   */
  classify<T>(objective: string, input: unknown, categories: readonly string[]): Promise<ExplainableConclusion<T>>;

  /**
   * True when the provider can actually serve requests (e.g. an API key is
   * present). Registries use this to fall back to the deterministic provider
   * instead of failing.
   */
  isConfigured(): boolean;
}
