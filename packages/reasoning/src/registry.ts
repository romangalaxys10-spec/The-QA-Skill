import type { TheQAConfig } from '@the-qa-skill/core';

import { AnthropicProvider } from './anthropic.js';
import { DeterministicProvider } from './deterministic.js';
import { OpenAIProvider } from './openai.js';
import type { ReasoningProvider } from './provider.js';

/**
 * @the-qa-skill/reasoning — provider registry and config-driven wiring.
 *
 * The registry NEVER throws for missing configuration: resolving a preferred
 * provider that is absent or unconfigured always falls back to the
 * deterministic provider (whose conclusions carry fallbackUsed: true, so the
 * fallback is recorded in the conclusion itself).
 */

export { ProviderError } from './provider.js';

/**
 * Ordered provider registry with guaranteed deterministic fallback.
 * Registering a provider with an existing id replaces it.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ReasoningProvider>();

  /** Register (or replace) a provider by its id. */
  register(provider: ReasoningProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Look up a provider by id, or undefined. */
  get(id: string): ReasoningProvider | undefined {
    return this.providers.get(id);
  }

  /** All registered provider ids in registration order. */
  ids(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Resolve a usable provider. Returns the preferred provider when it is
   * registered AND configured; otherwise falls back to the registered
   * deterministic provider — creating and registering one if none exists.
   * Never throws.
   */
  resolve(preferred?: string): ReasoningProvider {
    if (preferred !== undefined) {
      const provider = this.providers.get(preferred);
      if (provider && provider.isConfigured()) return provider;
    }
    const deterministic = this.providers.get('deterministic');
    if (deterministic) return deterministic;
    const created = new DeterministicProvider();
    this.providers.set(created.id, created);
    return created;
  }
}

/**
 * Build a registry from TheQAConfig. The deterministic provider is always
 * registered. config.integrations.reasoningProvider selects the preferred
 * provider: 'openai' → OpenAIProvider (key from env), 'anthropic' →
 * AnthropicProvider (key from env); 'deterministic' | 'gemini' | 'local' map
 * to deterministic only ('gemini' and 'local' have no provider yet — they are
 * explicitly mapped to the deterministic fallback rather than failing).
 * Callers then resolve with the same preference string.
 */
export function createRegistryFromConfig(config: TheQAConfig): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(new DeterministicProvider());
  switch (config.integrations.reasoningProvider) {
    case 'openai':
      registry.register(new OpenAIProvider());
      break;
    case 'anthropic':
      registry.register(new AnthropicProvider());
      break;
    case 'deterministic':
    case 'gemini':
    case 'local':
      // Deterministic-only: no model wiring (or none available yet).
      break;
  }
  return registry;
}
