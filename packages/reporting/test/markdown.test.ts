import { describe, expect, it } from 'vitest';
import type {
  CoverageReport,
  ReleaseGateResult,
  RiskAssessment,
  RiskFactorValue,
  SelectionResult,
  TestEvent,
  TriageResult,
} from '@the-qa-skill/core';
import { renderMarkdownReport } from '../src/markdown.js';
import type { MarkdownReportInput } from '../src/markdown.js';

const riskFactor: RiskFactorValue = {
  factor: 'businessCriticality',
  value: 0.9,
  weight: 20,
  contribution: 18,
  reasons: ['payment module touched'],
};

const risk: RiskAssessment = {
  score: 87,
  tier: 'critical',
  factors: [riskFactor],
  topContributors: [riskFactor],
  explanation: 'Payment logic changed; full checkout regression recommended.',
  label: 'INFERRED',
};

const triage: TriageResult = {
  testId: 'tests/checkout.spec.ts::completes a purchase',
  category: 'REAL_REGRESSION',
  confidence: 0.95,
  rootCauseHypothesis: 'Cart total rounding changed in pricing service',
  signals: [{ description: 'payment file changed', polarity: 'supports' }],
  contradictingSignals: [],
  recommendedAction: 'Revert the pricing change or fix rounding before release',
  evidence: [{ id: 'ev-1', kind: 'test_output', location: 'evidence/run-1/tests.checkout', summary: 'failing run', collectedAt: '2026-10-07T12:00:00Z', label: 'OBSERVED' }],
  label: 'INFERRED',
};

const gate: ReleaseGateResult = {
  verdict: 'BLOCKED',
  reasons: ['1 real regression failed'],
  blockingFindings: ['1 real regression failure(s) observed in environment ci'],
  warnings: [],
  label: 'OBSERVED',
};

function ev(overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    runId: 'run-1',
    testId: 'tests/checkout.spec.ts::completes a purchase',
    name: 'completes a purchase',
    timestamp: '2026-10-07T12:00:00.000Z',
    status: 'failed',
    durationMs: 1200,
    framework: 'playwright',
    environment: 'ci',
    retryIndex: 0,
    filePath: 'tests/checkout.spec.ts',
    errorMessage: 'Error: expected 9999 to equal 10000',
    ...overrides,
  };
}

const selection: SelectionResult = {
  selected: [],
  unaffected: [],
  routing: [],
  summary: '6 selected tests cover the payment change',
  label: 'INFERRED',
};

const coverage: CoverageReport = {
  weightedCoverage: 42,
  fileCoverage: 55,
  gaps: [{ path: 'src/payments/rounding.ts', area: 'payment', riskWeight: 9, coveredBy: [], reason: 'no test imports this module' }],
  criticalFlowCoverage: [{ flow: 'checkout', covered: false, note: 'gap' }],
  label: 'INFERRED',
};

const baseInput: MarkdownReportInput = {
  audience: 'engineering',
  title: 'QA report',
  risk,
  selection,
  triage: [triage],
  clusters: [{ id: 'c1', signature: 'expected N to equal M', testIds: ['a', 'b'], category: 'REAL_REGRESSION', isPrimary: true }],
  coverage,
  gate,
  events: [ev()],
  labelPolicy: true,
};

describe('markdown report — four audiences', () => {
  const render = (audience: MarkdownReportInput['audience']): string =>
    renderMarkdownReport({ ...baseInput, audience, title: `QA report (${audience})` });

  it('renders differently for every audience', () => {
    const engineering = render('engineering');
    const qa = render('qa');
    const leadership = render('leadership');
    const executive = render('executive');
    const docs = [engineering, qa, leadership, executive];
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        expect(docs[i]).not.toBe(docs[j]);
      }
    }
  });

  it('engineering: failing tests, root cause, recommended action, evidence pointers', () => {
    const md = render('engineering');
    expect(md).toContain('completes a purchase');
    expect(md).toContain('Cart total rounding changed in pricing service');
    expect(md).toContain('Revert the pricing change or fix rounding before release');
    expect(md).toContain('evidence/run-1/tests.checkout');
    expect(md).toContain('(INFERRED)');
    expect(md).toContain('(OBSERVED)');
    expect(md).toContain('tests/checkout.spec.ts::completes a purchase');
  });

  it('qa: coverage, clusters, deductions, selection', () => {
    const md = render('qa');
    expect(md).toContain('42.0%');
    expect(md).toContain('src/payments/rounding.ts');
    expect(md).toContain('checkout');
    expect(md).toContain('distinct signature cluster');
    expect(md).toContain('6 selected tests cover the payment change');
    expect(md).toContain('No test quality reports were provided (NOT_VERIFIED).');
  });

  it('leadership: confidence, critical risks, and honest trend absence', () => {
    const md = render('leadership');
    expect(md).toContain('BLOCKED');
    expect(md).toContain('CRITICAL');
    expect(md).toContain('No historical trend data was provided');
    expect(md).toContain('(NOT_VERIFIED)');
  });

  it('executive: verdict, blockers, exposure, decision', () => {
    const md = render('executive');
    expect(md).toContain('blocked by quality gate findings');
    expect(md).toContain('1 real regression failure(s) observed in environment ci');
    expect(md).toContain('Hold the release');
    expect(md).toContain('Payment logic changed');
  });

  it('states plainly when inputs are absent instead of inventing sections', () => {
    const md = renderMarkdownReport({ audience: 'leadership', title: 'Empty', labelPolicy: true });
    expect(md).toContain('No release gate evaluation was provided');
    expect(md).toContain('No risk assessment was provided');
    expect(md).toContain('No historical trend data was provided');
  });

  it('refuses to render without the label policy', () => {
    expect(() => renderMarkdownReport({ ...baseInput, labelPolicy: false as unknown as true })).toThrow(/labelPolicy/);
  });
});
