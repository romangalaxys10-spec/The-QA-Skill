import { afterEach, describe, expect, it } from 'vitest';

import { OpenAIProvider, ProviderError } from '../src/index.js';

interface ClassifyResult {
  category: string;
}

const CANNED_CONCLUSION = {
  result: { category: 'FLAKE' },
  confidence: 1.7,
  reasoningObjective: 'triage this failure',
  inputSummary: 'will be echoed back',
  outputSchema: 'reasoning.Classification.v1',
  evidence: [{ id: 'ev-1', summary: 'failed once then passed on retry', collectedAt: '2026-10-07T10:00:00Z' }],
  assumptions: ['environment healthy'],
};

function openAICompletion(content: string): string {
  return JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
}

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

describe('OpenAIProvider — request shape', () => {
  const ORIGINAL_KEY = process.env['OPENAI_API_KEY'];

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = ORIGINAL_KEY;
  });

  it('posts the documented URL, headers, and body; parses the canned response', async () => {
    delete process.env['OPENAI_API_KEY'];
    const { fetchImpl, calls } = mockFetch(200, openAICompletion(JSON.stringify(CANNED_CONCLUSION)));
    const provider = new OpenAIProvider({ apiKey: 'sk-test-key', fetchImpl, timeoutMs: 5000 });

    const conclusion = await provider.classify<ClassifyResult>(
      'triage this failure',
      { errorMessage: 'failed once then passed' },
      ['REAL_REGRESSION', 'FLAKE'],
    );

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0] as CapturedCall;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    // The key travels ONLY in the Authorization header — never in the body.
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test-key');
    const bodyText = String(init.body);
    expect(bodyText).not.toContain('sk-test-key');
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    expect(body['model']).toBe('gpt-4o-mini');
    expect(body['temperature']).toBe(0);
    expect(body['response_format']).toEqual({ type: 'json_object' });
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('single JSON object');
    expect(messages[0]?.content).toContain('reasoning.Classification.v1');
    expect(messages[0]?.content).toContain('REAL_REGRESSION, FLAKE');
    expect(messages[1]?.role).toBe('user');
    const userPayload = JSON.parse(messages[1]?.content ?? '{}') as Record<string, unknown>;
    expect(userPayload['objective']).toBe('triage this failure');
    expect(userPayload['categories']).toEqual(['REAL_REGRESSION', 'FLAKE']);

    // Parsed conclusion: confidence clamped, evidence forced to kind 'reasoning'.
    expect(conclusion.result.category).toBe('FLAKE');
    expect(conclusion.confidence).toBe(1); // 1.7 clamped into [0,1]
    expect(conclusion.fallbackUsed).toBe(false);
    expect(conclusion.evidence).toHaveLength(1);
    expect(conclusion.evidence[0]?.kind).toBe('reasoning');
    expect(conclusion.evidence[0]?.label).toBe('INFERRED');
    expect(conclusion.evidence[0]?.id).toBe('ev-1');
    expect(conclusion.assumptions).toEqual(['environment healthy']);
    expect(conclusion.outputSchema).toBe('reasoning.Classification.v1');
  });

  it('honors custom baseUrl and model', async () => {
    const { fetchImpl, calls } = mockFetch(200, openAICompletion(JSON.stringify(CANNED_CONCLUSION)));
    const provider = new OpenAIProvider({ apiKey: 'k', baseUrl: 'http://127.0.0.1:11434/v1/', model: 'llama-3', fetchImpl });
    await provider.analyze('obj', { a: 1 }, 'qa.X.v1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['model']).toBe('llama-3');
  });

  it('isConfigured reads opts first, then OPENAI_API_KEY', () => {
    delete process.env['OPENAI_API_KEY'];
    expect(new OpenAIProvider({ fetchImpl: mockFetch(200, '{}').fetchImpl }).isConfigured()).toBe(false);
    process.env['OPENAI_API_KEY'] = 'sk-env';
    expect(new OpenAIProvider({ fetchImpl: mockFetch(200, '{}').fetchImpl }).isConfigured()).toBe(true);
    expect(new OpenAIProvider({ apiKey: 'sk-opt', fetchImpl: mockFetch(200, '{}').fetchImpl }).isConfigured()).toBe(true);
  });
});

describe('OpenAIProvider — error discipline', () => {
  it('surfaces non-200 responses as ProviderError without leaking the key', async () => {
    const { fetchImpl, calls } = mockFetch(401, '{"error":{"message":"bad key"}}');
    const provider = new OpenAIProvider({ apiKey: 'sk-secret', fetchImpl });
    const error = await provider.analyze('obj', { a: 1 }, 'qa.X.v1').then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain('sk-secret');
    expect(calls).toHaveLength(1);
  });

  it('rejects non-JSON message content', async () => {
    const { fetchImpl } = mockFetch(200, openAICompletion('this is not json'));
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl });
    await expect(provider.generate('obj', { a: 1 }, 'qa.X.v1')).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects payloads without evidence (explainability is mandatory)', async () => {
    const noEvidence = { result: { ok: true }, confidence: 0.9, assumptions: [] };
    const { fetchImpl } = mockFetch(200, openAICompletion(JSON.stringify(noEvidence)));
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl });
    await expect(provider.analyze('obj', { a: 1 }, 'qa.X.v1')).rejects.toThrow(/non-empty "evidence"/);
  });

  it('times out via AbortController and surfaces ProviderError', async () => {
    const fetchImpl = (async (_input: FetchInput, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const provider = new OpenAIProvider({ apiKey: 'k', fetchImpl, timeoutMs: 25 });
    await expect(provider.analyze('obj', { a: 1 }, 'qa.X.v1')).rejects.toThrow(/timed out after 25ms/);
  });
});
