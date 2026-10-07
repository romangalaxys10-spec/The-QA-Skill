import { describe, expect, it } from 'vitest';
import { computeGate } from '../src/gate.js';
import type { CoverageReport, ReleaseGateInput, RiskAssessment, TriageResult } from '@the-qa-skill/core';

const riskAssessment = { score: 40, tier: 'medium', factors: [], topContributors: [], explanation: '', label: 'INFERRED' } as unknown as RiskAssessment;
const triageResult = { testId: 't', category: 'FLAKE', confidence: 0.8, rootCauseHypothesis: '', signals: [], contradictingSignals: [], recommendedAction: '', evidence: [], label: 'OBSERVED' } as unknown as TriageResult;
const coverage: CoverageReport = { weightedCoverage: 45, fileCoverage: 50, gaps: [], criticalFlowCoverage: [], label: 'INFERRED' };

function input(partial: Partial<ReleaseGateInput>): ReleaseGateInput {
  return {
    riskAssessments: [riskAssessment],
    triageResults: [triageResult],
    flakeAssessments: [],
    failedRealRegressions: 0,
    openUnknownCategories: 0,
    criticalFlakeCount: 0,
    evidenceComplete: true,
    environment: 'ci',
    ...partial,
  };
}

describe('computeGate (local, core-only gate used by the orchestrator)', () => {
  it('returns UNKNOWN with NOT_VERIFIED when no inputs exist', () => {
    const gate = computeGate({
      riskAssessments: [], triageResults: [], flakeAssessments: [],
      failedRealRegressions: 0, openUnknownCategories: 0, criticalFlakeCount: 0,
      evidenceComplete: true, environment: 'ci',
    });
    expect(gate.verdict).toBe('UNKNOWN');
    expect(gate.label).toBe('NOT_VERIFIED');
  });

  it('blocks on real regressions', () => {
    const gate = computeGate(input({ failedRealRegressions: 2 }));
    expect(gate.verdict).toBe('BLOCKED');
    expect(gate.blockingFindings.join(' ')).toMatch(/2 REAL_REGRESSION/);
  });

  it('warns on unknowns above budget, critical flakes, and low coverage', () => {
    const gate = computeGate(input({ openUnknownCategories: 3, criticalFlakeCount: 1, coverage }));
    expect(gate.verdict).toBe('PASS_WITH_WARNINGS');
    expect(gate.warnings.join(' ')).toMatch(/UNKNOWN triage results/);
    expect(gate.warnings.join(' ')).toMatch(/critical flaky/);
    expect(gate.warnings.join(' ')).toMatch(/below the 60% gate minimum/);
  });

  it('downgrades PASS to PASS_WITH_WARNINGS when evidence is incomplete', () => {
    const gate = computeGate(input({ evidenceComplete: false }));
    expect(gate.verdict).toBe('PASS_WITH_WARNINGS');
    expect(gate.warnings.join(' ')).toMatch(/incomplete/);
    expect(gate.label).toBe('INFERRED');
  });

  it('passes with complete evidence and clean checks', () => {
    const gate = computeGate(input({}));
    expect(gate.verdict).toBe('PASS');
    expect(gate.blockingFindings).toEqual([]);
    expect(gate.warnings).toEqual([]);
    expect(gate.label).toBe('OBSERVED');
  });

  it('is UNKNOWN when nothing executed and nothing was triaged', () => {
    const gate = computeGate(input({ evidenceComplete: false, triageResults: [] }));
    expect(gate.verdict).toBe('UNKNOWN');
    expect(gate.reasons.join(' ')).toMatch(/no execution evidence/);
  });
});
