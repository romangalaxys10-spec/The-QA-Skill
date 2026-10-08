import type { TestEvent } from '@the-qa-skill/core';

/**
 * JUnit XML writer — the interchange format CI servers understand.
 *
 * Mapping decisions (documented, deterministic):
 * - Failed and timed-out events are terminal failures; they are reported as
 *   `<failure>` and `<error>` respectively (JUnit has no native "timeout").
 * - Skipped and not_run events both become `<skipped>`; not_run carries a
 *   distinguishing message ("status: not_run").
 * - Durations are seconds with 3 decimals (JUnit convention).
 * - Events are grouped into suites by filePath (falling back to framework).
 * - All text and attribute values are XML-escaped; control characters that
 *   are illegal in XML 1.0 are stripped rather than emitted.
 */

export interface JUnitWriterOptions {
  /** Suite name when everything should land in ONE suite instead of per-file groups. */
  suiteName?: string;
  /** Root <testsuites> name attribute. Defaults to 'The-QA-Skill'. */
  rootName?: string;
}

/** Escape text for XML attribute values and character data. */
export function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Format milliseconds as JUnit seconds with exactly 3 decimals. */
export function secondsFromMs(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3);
}

interface SuiteAccumulator {
  name: string;
  events: TestEvent[];
}

/**
 * Render TestEvents as well-formed JUnit XML. The output re-parses with the
 * runners package's own `parseJUnitXml` (round-trip contract) and with any
 * standards-compliant JUnit reader.
 */
export function toJUnitXml(events: TestEvent[], opts: JUnitWriterOptions = {}): string {
  const rootName = opts.rootName ?? 'The-QA-Skill';

  const suites: SuiteAccumulator[] = opts.suiteName
    ? [{ name: opts.suiteName, events: [...events] }]
    : groupByFile(events);

  const totalTests = suites.reduce((n, s) => n + s.events.length, 0);
  const totalFailures = suites.reduce((n, s) => n + s.events.filter((e) => e.status === 'failed').length, 0);
  const totalErrors = suites.reduce((n, s) => n + s.events.filter((e) => e.status === 'timedout').length, 0);
  const totalSkipped = suites.reduce(
    (n, s) => n + s.events.filter((e) => e.status === 'skipped' || e.status === 'not_run').length,
    0,
  );
  const totalTime = events.reduce((n, e) => n + Math.max(0, e.durationMs), 0);

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuites name="${escapeXml(rootName)}" tests="${totalTests}" failures="${totalFailures}" errors="${totalErrors}" skipped="${totalSkipped}" time="${secondsFromMs(totalTime)}">`,
  );
  for (const suite of suites) {
    lines.push(...renderSuite(suite));
  }
  lines.push('</testsuites>');
  return lines.join('\n') + '\n';
}

function groupByFile(events: TestEvent[]): SuiteAccumulator[] {
  const order: string[] = [];
  const byKey = new Map<string, SuiteAccumulator>();
  for (const e of events) {
    const key = e.filePath && e.filePath.length > 0 ? e.filePath : e.framework || 'unknown';
    let suite = byKey.get(key);
    if (!suite) {
      suite = { name: key, events: [] };
      byKey.set(key, suite);
      order.push(key);
    }
    suite.events.push(e);
  }
  return order.map((k) => byKey.get(k)!);
}

function renderSuite(suite: SuiteAccumulator): string[] {
  const failures = suite.events.filter((e) => e.status === 'failed').length;
  const errors = suite.events.filter((e) => e.status === 'timedout').length;
  const skipped = suite.events.filter((e) => e.status === 'skipped' || e.status === 'not_run').length;
  const time = suite.events.reduce((n, e) => n + Math.max(0, e.durationMs), 0);

  const lines: string[] = [];
  lines.push(
    `  <testsuite name="${escapeXml(suite.name)}" tests="${suite.events.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${secondsFromMs(time)}">`,
  );
  for (const e of suite.events) {
    lines.push(...renderCase(e));
  }
  lines.push('  </testsuite>');
  return lines;
}

function renderCase(e: TestEvent): string[] {
  const name = escapeXml(e.name || e.testId);
  const classname = escapeXml(e.filePath || e.framework || 'unknown');
  const time = secondsFromMs(e.durationMs);
  const attrs = `name="${name}" classname="${classname}" time="${time}"`;

  switch (e.status) {
    case 'failed': {
      const message = e.errorMessage ?? `${e.status} (no message captured)`;
      const type = e.errorType ?? 'AssertionError';
      const body = e.errorStack ?? message;
      return [`    <testcase ${attrs}>`, `      <failure message="${escapeXml(message)}" type="${escapeXml(type)}">${escapeXml(body)}</failure>`, '    </testcase>'];
    }
    case 'timedout': {
      const message = e.errorMessage ?? 'test exceeded the hard timeout';
      const body = e.errorStack ?? message;
      return [`    <testcase ${attrs}>`, `      <error message="${escapeXml(message)}" type="Timeout">${escapeXml(body)}</error>`, '    </testcase>'];
    }
    case 'skipped':
      return [`    <testcase ${attrs}>`, '      <skipped/>', '    </testcase>'];
    case 'not_run':
      return [`    <testcase ${attrs}>`, '      <skipped message="status: not_run"/>', '    </testcase>'];
    case 'passed':
    default:
      return [`    <testcase ${attrs}/>`];
  }
}
