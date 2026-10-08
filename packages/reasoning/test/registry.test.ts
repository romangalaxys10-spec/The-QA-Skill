import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '@the-qa-skill/core';
import type { TheQAConfig } from '@the-qa-skill/core';

import { AnthropicProvider, DeterministicProvider, OpenAIProvider, ProviderError, ProviderRegistry, createRegistryFromConfig } from '../src/index.js';

const configWith = (provider: TheQAConfig['integrations']['reasoningProvider']): TheQAConfig => ({
  ...DEFAULT_CONFIG,
  integrations: { reasoningProvider: provider },
});

describe('ProviderRegistry', () => {
  it('resolves the preferred provider when it is registered and configured', () => {
    const registry = new ProviderRegistry();
    const openai = new OpenAIProvider({ apiKey: 'sk-present' });
    registry.register(openai);
    expect(registry.resolve('openai')).toBe(openai);
  });

  it('falls back to deterministic when the preferred provider is unregistered', () => {
    const registry = new ProviderRegistry();
    registry.register(new DeterministicProvider());
    const resolved = registry.resolve('gemini');
    expect(resolved).toBeInstanceOf(DeterministicProvider);
    expect(resolved.id).toBe('deterministic');
  });

  it('falls back to deterministic when the preferred provider is unconfigured', () => {
    const original = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      const registry = new ProviderRegistry();
      registry.register(new DeterministicProvider());
      registry.register(new OpenAIProvider()); // no key anywhere
      expect(registry.resolve('openai')).toBeInstanceOf(DeterministicProvider);
    } finally {
      if (original !== undefined) process.env['OPENAI_API_KEY'] = original;
    }
  });

  it('NEVER throws — an empty registry lazily creates a deterministic provider', () => {
    const registry = new ProviderRegistry();
    expect(registry.get('deterministic')).toBeUndefined();
    const resolved = registry.resolve('openai');
    expect(resolved).toBeInstanceOf(DeterministicProvider);
    expect(registry.get('deterministic')).toBe(resolved);
  });

  it('resolve() without a preference returns deterministic', () => {
    const registry = new ProviderRegistry();
    registry.register(new OpenAIProvider({ apiKey: 'sk-present' }));
    registry.register(new DeterministicProvider());
    expect(registry.resolve()).toBeInstanceOf(DeterministicProvider);
  });

  it('registering the same id replaces the provider', () => {
    const registry = new ProviderRegistry();
    registry.register(new OpenAIProvider({ apiKey: 'a' }));
    const second = new OpenAIProvider({ apiKey: 'b' });
    registry.register(second);
    expect(registry.get('openai')).toBe(second);
    expect(registry.ids()).toEqual(['openai']);
  });
});

describe('createRegistryFromConfig', () => {
  const ORIGINALS = {
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINALS)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('maps gemini/local/none onto the deterministic fallback', () => {
    for (const provider of ['gemini', 'local', 'deterministic'] as const) {
      const registry = createRegistryFromConfig(configWith(provider));
      const resolved = registry.resolve(provider);
      expect(resolved).toBeInstanceOf(DeterministicProvider);
    }
  });

  it('wires openai when configured and the env key is present', () => {
    process.env['OPENAI_API_KEY'] = 'sk-env-present';
    const registry = createRegistryFromConfig(configWith('openai'));
    expect(registry.resolve('openai')).toBeInstanceOf(OpenAIProvider);
  });

  it('wires openai but still falls back when the env key is absent', () => {
    delete process.env['OPENAI_API_KEY'];
    const registry = createRegistryFromConfig(configWith('openai'));
    expect(registry.get('openai')).toBeInstanceOf(OpenAIProvider);
    expect(registry.resolve('openai')).toBeInstanceOf(DeterministicProvider);
  });

  it('wires anthropic when configured and the env key is present', () => {
    process.env['ANTHROPIC_API_KEY'] = 'ak-env-present';
    const registry = createRegistryFromConfig(configWith('anthropic'));
    expect(registry.resolve('anthropic')).toBeInstanceOf(AnthropicProvider);
  });
});

describe('registry error propagation', () => {
  it('surfaces provider failures as ProviderError through the resolved provider', async () => {
    const registry = new ProviderRegistry();
    const failing = new OpenAIProvider({
      apiKey: 'sk-k',
      fetchImpl: (async () => new Response('{"error":"boom"}', { status: 500 })) as unknown as typeof fetch,
    });
    registry.register(failing);
    const resolved = registry.resolve('openai');
    const error = await resolved.analyze('obj', { a: 1 }, 'qa.X.v1').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain('500');
  });

  it('the deterministic fallback records fallbackUsed in its conclusions', async () => {
    const registry = createRegistryFromConfig(configWith('openai'));
    delete process.env['OPENAI_API_KEY'];
    const conclusion = await registry.resolve('openai').analyze('obj', { a: 1 }, 'qa.X.v1');
    expect(conclusion.fallbackUsed).toBe(true);
  });
});
