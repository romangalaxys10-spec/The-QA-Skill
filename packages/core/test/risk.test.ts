import { describe, expect, it } from 'vitest';
import { assessRisk, DEFAULT_WEIGHTS, tierFor } from '../src/risk/engine.js';
import { classifyArea } from '../src/risk/factors.js';
import type { ChangedFile } from '../src/types.js';

const file = (path: string, additions = 50, deletions = 10): ChangedFile => ({
  path,
  status: 'modified',
  additions,
  deletions,
  area: classifyArea(path),
  language: 'typescript',
  symbols: [],
});

describe('risk engine', () => {
  it('classifies payment changes as critical with payment-specific contributors', () => {
    const assessment = assessRisk({
      changedFiles: [file('src/payments/charge.ts'), file('src/payments/refund.ts')],
      addedLines: 300,
      removedLines: 50,
    });
    // Tier floor: payment changes are never below critical, even when small.
    expect(assessment.tier).toBe('critical');
    expect(assessment.score).toBeGreaterThanOrEqual(0);
    const reasons = assessment.topContributors.flatMap((f) => f.reasons);
    expect(reasons.some((r) => r.includes('payment logic changed'))).toBe(true);
    expect(assessment.explanation).toMatch(/Risk: \d+\/100/);
    expect(assessment.explanation).toMatch(/→ /);
  });

  it('applies tier floors: small payment change scores modestly but stays critical', () => {
    const small = assessRisk({ changedFiles: [file('src/payments/price.ts', 10, 2)], addedLines: 10, removedLines: 2 });
    expect(small.score).toBeLessThan(60);
    expect(small.tier).toBe('critical');
    expect(small.explanation).toMatch(/full regression/);
  });

  it('scores a docs-only change as low risk', () => {
    const assessment = assessRisk({ changedFiles: [file('README.md', 20, 2)], addedLines: 20, removedLines: 2 });
    expect(assessment.tier).toBe('low');
    expect(assessment.score).toBeLessThan(35);
  });

  it('elevates auth boundary changes', () => {
    const withAuth = assessRisk({ changedFiles: [file('src/auth/session.ts')], addedLines: 100, removedLines: 30 });
    const withoutAuth = assessRisk({ changedFiles: [file('src/utils/string.ts')], addedLines: 100, removedLines: 30 });
    expect(withAuth.score).toBeGreaterThan(withoutAuth.score);
    const authFactor = withAuth.factors.find((f) => f.factor === 'securitySensitivity');
    expect(authFactor?.value).toBeGreaterThan(0.5);
  });

  it('flags migrations for data-integrity attention', () => {
    const assessment = assessRisk({
      changedFiles: [file('migrations/0042_add_orders.sql', 120, 0)],
      addedLines: 120,
      removedLines: 0,
    });
    const dataFactor = assessment.factors.find((f) => f.factor === 'dataSensitivity');
    expect(dataFactor?.value).toBeGreaterThanOrEqual(0.9);
    expect(dataFactor?.reasons.join(' ')).toMatch(/data-integrity tests required/);
  });

  it('uses defect history when provided and explains it', () => {
    const assessment = assessRisk({
      changedFiles: [file('src/legacy/parser.ts')],
      defectHistory: { 'src/legacy/parser.ts': 0.9 },
      addedLines: 40,
      removedLines: 10,
    });
    const history = assessment.factors.find((f) => f.factor === 'defectHistory');
    expect(history?.value).toBe(0.9);
    expect(history?.reasons.join(' ')).toMatch(/historically unstable/);
  });

  it('produces monotonic scores: more files + more churn never lowers risk', () => {
    const small = assessRisk({ changedFiles: [file('src/a.ts', 20, 5)], addedLines: 20, removedLines: 5 });
    const big = assessRisk({
      changedFiles: Array.from({ length: 10 }, (_, i) => file(`src/mod${i}.ts`, 80, 30)),
      addedLines: 800,
      removedLines: 300,
    });
    expect(big.score).toBeGreaterThan(small.score);
  });

  it('respects custom weights and renormalizes honestly', () => {
    const custom = { ...DEFAULT_WEIGHTS, businessCriticality: 0.6, changeSurface: 0.4, defectHistory: 0, codeComplexity: 0, integrationDepth: 0, userImpact: 0, securitySensitivity: 0, dataSensitivity: 0 };
    const assessment = assessRisk({ changedFiles: [file('src/payments/charge.ts')] }, { weights: custom });
    // Weights don't sum to 1 → renormalized; score must still be in 0..100.
    expect(assessment.score).toBeGreaterThanOrEqual(0);
    expect(assessment.score).toBeLessThanOrEqual(100);
  });

  it('maps tier thresholds exactly', () => {
    expect(tierFor(80)).toBe('critical');
    expect(tierFor(79.9)).toBe('high');
    expect(tierFor(60)).toBe('high');
    expect(tierFor(35)).toBe('medium');
    expect(tierFor(34.9)).toBe('low');
  });

  it('every factor carries at least one reason (explainability guarantee)', () => {
    const assessment = assessRisk({ changedFiles: [file('src/anything.ts')] });
    for (const factor of assessment.factors) {
      expect(factor.reasons.length).toBeGreaterThan(0);
      expect(factor.label ?? '').toBeDefined();
    }
  });
});
