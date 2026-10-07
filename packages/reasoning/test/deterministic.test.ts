import { describe, expect, it } from 'vitest';

import { DeterministicProvider, ProviderError } from '../src/index.js';
import type { ExplainableConclusion } from '@the-qa-skill/core';

/** The shape analyze() documents for its result. */
interface DescriptorResult {
  kind: string;
  inputType: string;
  keys?: string[];
  observations: string[];
}

/** The shape classify() documents for its result. */
interface ClassifyResult {
  category: string;
  runnerUp: string | null;
  scores: Record<string, number>;
  matchedKeywords: string[];
}

const CATEGORIES = ['REAL_REGRESSION', 'FLAKE', 'NETWORK_FAILURE', 'SELECTOR_FAILURE'] as const;

describe('DeterministicProvider — contract', () => {
  const provider = new DeterministicProvider();

  it('is always configured and exposes its id', () => {
    expect(provider.id).toBe('deterministic');
    expect(provider.isConfigured()).toBe(true);
  });

  it('analyze returns a fully-formed INFERRED conclusion with fallbackUsed', async () => {
    const conclusion = await provider.analyze<DescriptorResult>(
      'explain what changed',
      { filePath: 'src/cart/total.ts', symbols: ['computeTotal'], additions: 12 },
      'qa.InputDescriptor.v1',
    );
    expect(conclusion.fallbackUsed).toBe(true);
    expect(conclusion.confidence).toBeGreaterThanOrEqual(0);
    expect(conclusion.confidence).toBeLessThanOrEqual(1);
    expect(conclusion.reasoningObjective).toBe('explain what changed');
    expect(conclusion.outputSchema).toBe('qa.InputDescriptor.v1');
    expect(conclusion.inputSummary).toContain('object:');
    expect(conclusion.evidence.length).toBeGreaterThan(0);
    for (const item of conclusion.evidence) {
      expect(item.kind).toBe('reasoning');
      expect(item.label).toBe('INFERRED');
      expect(item.summary.length).toBeGreaterThan(0);
      expect(item.id).toMatch(/^ev-/);
      expect(item.collectedAt).toBeTruthy();
    }
    expect(conclusion.assumptions.length).toBeGreaterThan(0);
    expect(conclusion.result.kind).toBe('input_descriptor');
    expect(conclusion.result.inputType).toBe('object');
    expect(conclusion.result.observations.length).toBeGreaterThan(0);
  });

  it('generate returns a deterministic scaffold, not fabricated content', async () => {
    const conclusion = await provider.generate<{ kind: string; generated: boolean; suggestions: string[] }>(
      'draft a test plan',
      { auth: 'login flow', payment: 'checkout flow' },
      'qa.Plan.v1',
    );
    expect(conclusion.fallbackUsed).toBe(true);
    expect(conclusion.confidence).toBeLessThanOrEqual(0.85);
    expect(conclusion.outputSchema).toBe('qa.Plan.v1');
    expect(conclusion.result.generated).toBe(false);
    expect(conclusion.result.suggestions.some((s) => s.includes('auth'))).toBe(true);
    expect(conclusion.evidence.length).toBeGreaterThan(0);
    expect(conclusion.evidence[0]?.kind).toBe('reasoning');
  });
});

describe('DeterministicProvider — keyword scoring', () => {
  const provider = new DeterministicProvider();

  it('picks the expected category with documented margin-based confidence', async () => {
    const conclusion = await provider.classify<ClassifyResult>(
      'triage this failure',
      { errorType: 'TimeoutError', errorMessage: 'intermittent flake: failed once, passed on retry' },
      CATEGORIES,
    );
    expect(conclusion.fallbackUsed).toBe(true);
    expect(conclusion.result.category).toBe('FLAKE');
    expect(conclusion.result.scores['FLAKE']).toBeGreaterThan(0);
    expect(conclusion.result.scores['REAL_REGRESSION']).toBe(0);
    expect(conclusion.confidence).toBeCloseTo(0.85, 5); // clean single-category match
    expect(conclusion.confidence).toBeLessThanOrEqual(0.85);
    expect(conclusion.outputSchema).toBe('reasoning.Classification.v1');
    expect(conclusion.evidence[0]?.summary).toContain('FLAKE=1');
  });

  it('counts occurrences, not just presence', async () => {
    const conclusion = await provider.classify<ClassifyResult>(
      'triage',
      { errorMessage: 'network error: network unreachable while calling dependency' },
      ['NETWORK_FAILURE', 'FLAKE'],
    );
    expect(conclusion.result.scores['NETWORK_FAILURE']).toBe(2); // 'network' twice
    expect(conclusion.result.category).toBe('NETWORK_FAILURE');
  });

  it('ties resolve to the first category with ~0.45 confidence', async () => {
    // 'flake' and 'regression' each occur exactly once → an even race.
    const conclusion = await provider.classify<ClassifyResult>(
      'triage',
      { errorMessage: 'flake regression in the build' },
      ['REAL_REGRESSION', 'FLAKE'],
    );
    expect(conclusion.result.category).toBe('REAL_REGRESSION'); // first on tie
    expect(conclusion.result.runnerUp).toBe('FLAKE');
    expect(conclusion.confidence).toBeCloseTo(0.45, 5);
  });

  it('matches keywords as substrings only — flaky does not contain flake', async () => {
    const conclusion = await provider.classify<ClassifyResult>(
      'triage',
      { errorMessage: 'flaky behavior observed' },
      ['FLAKE', 'NETWORK_FAILURE'],
    );
    // Documented semantics: case-insensitive substring matching. 'flaky'
    // does not contain 'flake', so no signal → first category, low confidence.
    expect(conclusion.result.scores['FLAKE']).toBe(0);
    expect(conclusion.confidence).toBe(0.1);
  });

  it('no signal returns the first category with 0.1 confidence', async () => {
    const conclusion = await provider.classify<ClassifyResult>('triage', { note: 'nothing relevant here' }, CATEGORIES);
    expect(conclusion.result.category).toBe('REAL_REGRESSION');
    expect(conclusion.confidence).toBe(0.1);
    expect(conclusion.result.matchedKeywords).toEqual([]);
  });

  it('confidence stays capped at 0.85 even with overwhelming signal', async () => {
    const conclusion = await provider.classify<ClassifyResult>(
      'triage',
      { errorMessage: 'flake flake flake flake flake flake flake flake flake flake' },
      CATEGORIES,
    );
    expect(conclusion.confidence).toBe(0.85);
  });

  it('rejects empty category lists with ProviderError', async () => {
    await expect(provider.classify('triage', {}, [])).rejects.toBeInstanceOf(ProviderError);
  });

  it('respects the ExplainableConclusion envelope for every method', async () => {
    const conclusions: ExplainableConclusion<unknown>[] = [
      await provider.analyze('a', 42, 's'),
      await provider.generate('b', [1, 2, 3], 's'),
      await provider.classify('c', 'flake', CATEGORIES),
    ];
    for (const conclusion of conclusions) {
      expect(conclusion.confidence).toBeGreaterThanOrEqual(0);
      expect(conclusion.confidence).toBeLessThanOrEqual(0.85);
      expect(conclusion.evidence.length).toBeGreaterThan(0);
      expect(conclusion.assumptions.length).toBeGreaterThan(0);
      expect(conclusion.inputSummary.length).toBeGreaterThan(0);
      expect(conclusion.outputSchema.length).toBeGreaterThan(0);
      expect(conclusion.fallbackUsed).toBe(true);
    }
  });
});
