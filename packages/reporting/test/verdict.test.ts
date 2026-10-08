import { describe, expect, it } from 'vitest';
import type { ReleaseGateInput, RiskAssessment, TriageResult } from '@the-qa-skill/core';
import { computeReleaseGate } from '../src/verdict.js';

const lowRisk: RiskAssessment = {
  score: 10,
  tier: 'low',
  factors: [],
  topContributors: [],
  explanation: 'docs only',
  label: 'INFERRED',
};

function triageResult(testId: string, category: TriageResult['category'], confidence: number): TriageResult {
  return {
    testId,
    category,
    confidence,
    rootCauseHypothesis: 'hypothesis',
    signals: [],
    contradictingSignals: [],
    recommendedAction: 'fix it',
    evidence: [],
    label: 'INFERRED',
  };
}

/** Non-empty, fully clean baseline (a real gate always sees something). */
function cleanInput(overrides: Partial<ReleaseGateInput> = {}): ReleaseGateInput {
  return {
    riskAssessments: [lowRisk],
    triageResults: [],
    flakeAssessments: [],
    failedRealRegressions: 0,
    openUnknownCategories: 0,
    criticalFlakeCount: 0,
    evidenceComplete: true,
    environment: 'ci',
    ...overrides,
  };
}

describe('computeReleaseGate — deterministic decision table', () => {
  it('1. empty input → UNKNOWN, never PASS on no data', () => {
    const result = computeReleaseGate({
      riskAssessments: [],
      triageResults: [],
      flakeAssessments: [],
      failedRealRegressions: 0,
      openUnknownCategories: 0,
      criticalFlakeCount: 0,
      evidenceComplete: true,
      environment: 'ci',
    });
    expect(result.verdict).toBe('UNKNOWN');
    expect(result.label).toBe('NOT_VERIFIED');
    expect(result.reasons[0]).toContain('no data');
  });

  it('2. clean input → PASS with reasons', () => {
    const result = computeReleaseGate(cleanInput());
    expect(result.verdict).toBe('PASS');
    expect(result.blockingFindings).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.reasons.some((r) => r.includes('all evaluated gates passed'))).toBe(true);
  });

  it('3. observed real regression failure → BLOCKED with finding', () => {
    const result = computeReleaseGate(cleanInput({ failedRealRegressions: 1 }));
    expect(result.verdict).toBe('BLOCKED');
    expect(result.blockingFindings[0]).toContain('1 real regression failure(s)');
    expect(result.label).toBe('OBSERVED');
  });

  it('4. high-confidence triaged REAL_REGRESSION → BLOCKED naming the testId', () => {
    const result = computeReleaseGate(
      cleanInput({ triageResults: [triageResult('tests/pay.spec.ts::charge card', 'REAL_REGRESSION', 0.95)] }),
    );
    expect(result.verdict).toBe('BLOCKED');
    expect(result.blockingFindings.some((f) => f.includes('tests/pay.spec.ts::charge card'))).toBe(true);
  });

  it('5. low-confidence REAL_REGRESSION triage does not block (deterministic threshold 0.9)', () => {
    const result = computeReleaseGate(
      cleanInput({ triageResults: [triageResult('tests/pay.spec.ts::charge card', 'REAL_REGRESSION', 0.8)] }),
    );
    expect(result.verdict).toBe('PASS');
    expect(result.blockingFindings).toHaveLength(0);
  });

  it('6. real regression with blocking disabled → PASS_WITH_WARNINGS (policy recorded)', () => {
    const result = computeReleaseGate(cleanInput({ failedRealRegressions: 2 }), { blockOnRealRegression: false });
    expect(result.verdict).toBe('PASS_WITH_WARNINGS');
    expect(result.warnings.some((w) => w.includes('blockOnRealRegression=false'))).toBe(true);
  });

  it('7. incomplete evidence downgrades PASS → PASS_WITH_WARNINGS', () => {
    const result = computeReleaseGate(cleanInput({ evidenceComplete: false }));
    expect(result.verdict).toBe('PASS_WITH_WARNINGS');
    expect(result.warnings.some((w) => w.includes('evidence incomplete'))).toBe(true);
  });

  it('8. too many open UNKNOWN triage categories → PASS_WITH_WARNINGS', () => {
    const result = computeReleaseGate(cleanInput({ openUnknownCategories: 3 }));
    expect(result.verdict).toBe('PASS_WITH_WARNINGS');
    expect(result.warnings.some((w) => w.includes('maxUnknownTriage=2'))).toBe(true);
    // within budget → stays PASS
    expect(computeReleaseGate(cleanInput({ openUnknownCategories: 2 })).verdict).toBe('PASS');
  });

  it('9. critical flake above zero tolerance → PASS_WITH_WARNINGS', () => {
    const result = computeReleaseGate(cleanInput({ criticalFlakeCount: 1 }));
    expect(result.verdict).toBe('PASS_WITH_WARNINGS');
    expect(result.warnings.some((w) => w.includes('critical flaky'))).toBe(true);
  });

  it('10. low weighted coverage → PASS_WITH_WARNINGS; sufficient coverage → PASS', () => {
    const coverage = (weightedCoverage: number) => ({
      weightedCoverage,
      fileCoverage: 50,
      gaps: [],
      criticalFlowCoverage: [],
      label: 'INFERRED' as const,
    });
    expect(computeReleaseGate(cleanInput({ coverage: coverage(45) })).verdict).toBe('PASS_WITH_WARNINGS');
    expect(computeReleaseGate(cleanInput({ coverage: coverage(75) })).verdict).toBe('PASS');
  });

  it('11. custom thresholds are honored (deterministic, configurable)', () => {
    const result = computeReleaseGate(cleanInput({ openUnknownCategories: 5 }), { maxUnknownTriage: 10 });
    expect(result.verdict).toBe('PASS');
  });

  it('12. BLOCKED beats warnings when both apply', () => {
    const result = computeReleaseGate(
      cleanInput({
        failedRealRegressions: 1,
        criticalFlakeCount: 5,
        evidenceComplete: false,
      }),
    );
    expect(result.verdict).toBe('BLOCKED');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
