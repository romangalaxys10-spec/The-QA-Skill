import { afterEach, describe, expect, it } from 'vitest';

import { AnthropicProvider, ProviderError } from '../src/index.js';

const CANNED_CONCLUSION = {
  result: { verdict: 'SELECTOR_FAILURE' },
  confidence: -3, // deliberately out of range → must clamp to 0
  evidence: ['selector .btn-submit changed in the diff'],
  assumptions: ['DOM snapshot is current'],
};

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** The input side of the fetch contract, independent of DOM lib availability. */
type FetchInput = Parameters<typeof fetch>[0];

function mockFetch(status: number, body: string): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function anthropicMessage(text: string): string {
  return JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' });
}

describe('AnthropicProvider — request shape', () => {
  const ORIGINAL_KEY = process.env['ANTHROPIC_API_KEY'];

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = ORIGINAL_KEY;
  });

  it('posts the documented URL, headers, and body; parses the canned response', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const { fetchImpl, calls } = mockFetch(200, anthropicMessage(JSON.stringify(CANNED_CONCLUSION)));
    const provider = new AnthropicProvider({ apiKey: 'ak-test-key', fetchImpl, timeoutMs: 5000 });

    const conclusion = await provider.classify<{ verdict: string }>(
      'explain the selector failure',
      { errorMessage: 'locator .btn-submit not found' },
      ['SELECTOR_FAILURE', 'FLAKE'],
    );

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as CapturedCall;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('ak-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // The key travels ONLY in the header — never in the body.
    const bodyText = String(init.body);
    expect(bodyText).not.toContain('ak-test-key');
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body['model']).toBe('claude-3-5-haiku-latest');
    expect(body['max_tokens']).toBe(1024);
    expect(body['temperature']).toBe(0);
    expect(typeof body['system']).toBe('string');
    expect(body['system']).toContain('single JSON object');
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    const userPayload = JSON.parse(messages[0]?.content ?? '{}') as Record<string, unknown>;
    expect(userPayload['objective']).toBe('explain the selector failure');
    expect(userPayload['categories']).toEqual(['SELECTOR_FAILURE', 'FLAKE']);

    // Parsed conclusion: negative confidence clamps to 0; string evidence is
    // upgraded to a full reasoning Evidence object.
    expect(conclusion.result.verdict).toBe('SELECTOR_FAILURE');
    expect(conclusion.confidence).toBe(0);
    expect(conclusion.fallbackUsed).toBe(false);
    expect(conclusion.evidence).toHaveLength(1);
    expect(conclusion.evidence[0]?.kind).toBe('reasoning');
    expect(conclusion.evidence[0]?.summary).toContain('.btn-submit');
    expect(conclusion.evidence[0]?.id).toMatch(/^ev-/);
    expect(conclusion.assumptions).toEqual(['DOM snapshot is current']);
  });

  it('honors custom baseUrl, model and maxTokens', async () => {
    const { fetchImpl, calls } = mockFetch(200, anthropicMessage(JSON.stringify(CANNED_CONCLUSION)));
    const provider = new AnthropicProvider({
      apiKey: 'ak',
      baseUrl: 'http://127.0.0.1:9000/',
      model: 'claude-3-opus-latest',
      maxTokens: 256,
      fetchImpl,
    });
    await provider.analyze('obj', { a: 1 }, 'qa.X.v1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:9000/v1/messages');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['model']).toBe('claude-3-opus-latest');
    expect(body['max_tokens']).toBe(256);
  });

  it('isConfigured reads opts first, then ANTHROPIC_API_KEY', () => {
    delete process.env['ANTHROPIC_API_KEY'];
    expect(new AnthropicProvider({ fetchImpl: mockFetch(200, '{}').fetchImpl }).isConfigured()).toBe(false);
    process.env['ANTHROPIC_API_KEY'] = 'ak-env';
    expect(new AnthropicProvider({ fetchImpl: mockFetch(200, '{}').fetchImpl }).isConfigured()).toBe(true);
  });
});

describe('AnthropicProvider — error discipline', () => {
  it('surfaces non-200 responses as ProviderError', async () => {
    const { fetchImpl } = mockFetch(529, '{"type":"error","error":{"message":"overloaded"}}');
    const provider = new AnthropicProvider({ apiKey: 'ak', fetchImpl });
    await expect(provider.analyze('obj', { a: 1 }, 'qa.X.v1')).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects responses with no text block', async () => {
    const { fetchImpl } = mockFetch(200, JSON.stringify({ content: [{ type: 'tool_use', id: 't' }] }));
    const provider = new AnthropicProvider({ apiKey: 'ak', fetchImpl });
    await expect(provider.generate('obj', { a: 1 }, 'qa.X.v1')).rejects.toThrow(/no text block/);
  });

  it('rejects non-JSON text content', async () => {
    const { fetchImpl } = mockFetch(200, anthropicMessage('prose only, no JSON'));
    const provider = new AnthropicProvider({ apiKey: 'ak', fetchImpl });
    await expect(provider.analyze('obj', { a: 1 }, 'qa.X.v1')).rejects.toBeInstanceOf(ProviderError);
  });

  it('refuses to run unconfigured', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const provider = new AnthropicProvider({ fetchImpl: mockFetch(200, '{}').fetchImpl });
    await expect(provider.analyze('obj', { a: 1 }, 'qa.X.v1')).rejects.toThrow(/not configured/);
  });
});
