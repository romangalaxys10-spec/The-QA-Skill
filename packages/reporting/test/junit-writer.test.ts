import { describe, expect, it } from 'vitest';
import { parseJUnitXml } from '@the-qa-skill/runners';
import type { TestEvent } from '@the-qa-skill/core';
import { toJUnitXml } from '../src/junit-writer.js';

function ev(overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    runId: 'run-abc123',
    testId: 'tests/x.spec.ts::case',
    name: 'case',
    timestamp: '2026-10-07T12:00:00.000Z',
    status: 'passed',
    durationMs: 500,
    framework: 'playwright',
    environment: 'ci',
    retryIndex: 0,
    filePath: 'tests/x.spec.ts',
    ...overrides,
  };
}

describe('JUnit XML writer', () => {
  it('round-trips through the runners package JUnit parser', () => {
    const events = [
      ev({ testId: 'tests/x.spec.ts::a', name: 'a', status: 'passed', durationMs: 1234 }),
      ev({ testId: 'tests/x.spec.ts::b', name: 'b', status: 'failed', durationMs: 2000, errorMessage: 'expected 200 to equal 500', errorType: 'AssertionError', errorStack: 'at x.spec.ts:9' }),
      ev({ testId: 'tests/x.spec.ts::c', name: 'c', status: 'timedout', durationMs: 60000, errorMessage: 'hard timeout exceeded' }),
      ev({ testId: 'tests/y.spec.ts::d', name: 'd', status: 'skipped', durationMs: 0, filePath: 'tests/y.spec.ts' }),
      ev({ testId: 'tests/y.spec.ts::e', name: 'e', status: 'not_run', durationMs: 0, filePath: 'tests/y.spec.ts' }),
    ];
    const xml = toJUnitXml(events, { rootName: 'qa-run' });
    const suites = parseJUnitXml(xml);

    expect(suites).toHaveLength(2); // grouped by filePath
    const suiteX = suites.find((s) => s.name === 'tests/x.spec.ts')!;
    const suiteY = suites.find((s) => s.name === 'tests/y.spec.ts')!;
    expect(suiteX.cases).toHaveLength(3);
    expect(suiteY.cases).toHaveLength(2);

    // Document-level aggregates from the parser's reconciliation:
    const total = suites.reduce((n, s) => n + s.cases.length, 0);
    expect(total).toBe(5);

    const failed = suiteX.cases.find((c) => c.name === 'b')!;
    expect(failed.status).toBe('failed');
    expect(failed.errorType).toBe('AssertionError');
    expect(failed.errorMessage).toBe('expected 200 to equal 500');
    expect(failed.errorStack).toBe('at x.spec.ts:9');

    // timedout becomes a JUnit <error type="Timeout"> — honestly distinguishable.
    const timedout = suiteX.cases.find((c) => c.name === 'c')!;
    expect(timedout.status).toBe('failed');
    expect(timedout.errorType).toBe('Timeout');
    expect(timedout.errorMessage).toBe('hard timeout exceeded');

    // skipped and not_run both land as skipped in JUnit (documented mapping).
    expect(suiteY.cases.every((c) => c.status === 'skipped')).toBe(true);

    // Duration conversion: 1234ms → "1.234".
    expect(xml).toContain('time="1.234"');
  });

  it('escapes XML entities and survives the round-trip byte-for-byte in names', () => {
    const trickyName = 'renders <b> & "quotes" \'single\' &amp; entities';
    const xml = toJUnitXml([ev({ name: trickyName, testId: 'x::t', status: 'failed', errorMessage: 'a < b && c > d' })]);
    expect(xml).not.toContain('<b>');
    const suites = parseJUnitXml(xml);
    expect(suites[0]!.cases[0]!.name).toBe(trickyName);
    expect(suites[0]!.cases[0]!.errorMessage).toBe('a < b && c > d');
  });

  it('produces well-formed aggregated counts', () => {
    const events = [
      ev({ status: 'passed' }),
      ev({ status: 'passed', testId: 't2', name: 't2' }),
      ev({ status: 'failed', testId: 't3', name: 't3' }),
      ev({ status: 'timedout', testId: 't4', name: 't4' }),
      ev({ status: 'skipped', testId: 't5', name: 't5' }),
      ev({ status: 'not_run', testId: 't6', name: 't6' }),
    ];
    const xml = toJUnitXml(events);
    expect(xml).toContain('<testsuites name="The-QA-Skill" tests="6" failures="1" errors="1" skipped="2"');
    // Well-formedness: matching root tags exactly once.
    expect(xml.match(/<testsuites /g)).toHaveLength(1);
    expect(xml.match(/<\/testsuites>/g)).toHaveLength(1);
  });

  it('supports a single forced suite name', () => {
    const xml = toJUnitXml([ev(), ev({ filePath: 'tests/other.spec.ts' })], { suiteName: 'full-regression' });
    expect(xml).toContain('<testsuite name="full-regression" tests="2"');
    expect(parseJUnitXml(xml)).toHaveLength(1);
  });

  it('emits an honest empty document for zero events', () => {
    const xml = toJUnitXml([]);
    expect(xml).toContain('tests="0"');
    expect(parseJUnitXml(xml)).toHaveLength(0);
  });

  it('strips XML-illegal control characters', () => {
    const xml = toJUnitXml([ev({ name: 'bad\u0007control', status: 'passed' })]);
    expect(xml).not.toContain('\u0007');
    expect(parseJUnitXml(xml)[0]!.cases[0]!.name).toBe('badcontrol');
  });
});
