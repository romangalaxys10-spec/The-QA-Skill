import { describe, expect, it } from 'vitest';
import type { ReleaseGateResult, RiskAssessment, SelectionResult, TestEvent } from '@the-qa-skill/core';
import { renderConsoleSummary } from '../src/console.js';

const risk: RiskAssessment = {
  score: 87,
  tier: 'critical',
  factors: [],
  topContributors: [{ factor: 'businessCriticality', value: 0.9, weight: 20, contribution: 18, reasons: [] }],
  explanation: 'payment changed',
  label: 'INFERRED',
};

const selection: SelectionResult = {
  selected: [],
  unaffected: [],
  routing: [],
  summary: 'summary',
  label: 'INFERRED',
};

const gate: ReleaseGateResult = {
  verdict: 'BLOCKED',
  reasons: ['1 real regression failed'],
  blockingFindings: ['1 real regression failure(s)'],
  warnings: [],
  label: 'OBSERVED',
};

const events: TestEvent[] = [
  ...Array.from({ length: 4 }, () => event('passed')),
  event('failed'),
  event('timedout'),
];

function event(status: TestEvent['status']): TestEvent {
  return {
    runId: 'run-1',
    testId: `t::${status}`,
    name: status,
    timestamp: '2026-10-07T12:00:00.000Z',
    status,
    durationMs: 10,
    framework: 'vitest',
    environment: 'ci',
    retryIndex: 0,
  };
}

describe('console summary', () => {
  it('contains the risk line with score, tier, and label', () => {
    const out = renderConsoleSummary({ risk });
    expect(out).toContain('risk:');
    expect(out).toContain('87/100 (critical)');
    expect(out).toContain('(INFERRED)');
    expect(out).toContain('businessCriticality');
  });

  it('contains selection, triage, gate, and event lines when provided', () => {
    const out = renderConsoleSummary({ risk, selection, triage: [], gate, events });
    expect(out).toContain('selection:');
    expect(out).toContain('triage:');
    expect(out).toContain('gate:      BLOCKED');
    expect(out).toContain('4 passed');
    expect(out).toContain('1 failed');
    expect(out).toContain('1 timedout');
    expect(out).toContain('(OBSERVED)');
  });

  it('uses no ANSI escape codes — the CLI owns colorization', () => {
    const out = renderConsoleSummary({ risk, gate, events });
    expect(out).not.toMatch(/\u001b\[/);
  });

  it('states honest absence with no data at all', () => {
    const out = renderConsoleSummary({});
    expect(out).toContain('no data provided');
    expect(out).toContain('UNKNOWN');
    expect(out).toContain('(NOT_VERIFIED)');
  });
});
