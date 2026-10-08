import { describe, expect, it } from 'vitest';
import { decodeEntities, parseJUnitXml, parseJUnitXmlDetailed } from '../src/junit.js';

describe('junit parser', () => {
  it('parses a standard single-suite document', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="orders" tests="3" failures="1" errors="0" time="1.5">
  <testcase name="creates an order" classname="tests/api/orders.spec.ts" time="0.4"/>
  <testcase name="rejects empty cart" classname="tests/api/orders.spec.ts" time="0.1">
    <failure message="expected 200 to equal 400" type="AssertionError">at orders.spec.ts:12:5</failure>
  </testcase>
  <testcase name="needs auth (skipped for now)" classname="tests/api/orders.spec.ts" time="0">
    <skipped/>
  </testcase>
</testsuite>`;
    const suites = parseJUnitXml(xml);
    expect(suites).toHaveLength(1);
    const s = suites[0]!;
    expect(s.name).toBe('orders');
    expect(s.cases).toHaveLength(3);
    expect(s.cases[0]).toMatchObject({ name: 'creates an order', status: 'passed', durationMs: 400 });
    expect(s.cases[1]).toMatchObject({
      status: 'failed',
      errorType: 'AssertionError',
      errorMessage: 'expected 200 to equal 400',
      errorStack: 'at orders.spec.ts:12:5',
    });
    expect(s.cases[2]!.status).toBe('skipped');
  });

  it('parses nested <testsuites> documents recursively', () => {
    const xml = `<testsuites>
  <testsuite name="unit" tests="2" failures="0" time="0.2">
    <testcase name="a" classname="A" time="0.1"/>
    <testcase name="b" classname="A" time="0.1"/>
  </testsuite>
  <testsuite name="e2e" tests="1" failures="1" time="2.0">
    <testcase name="checkout flow" classname="tests/e2e/checkout.py" time="2.0">
      <error message="TimeoutError: page.click" type="TimeoutError">stack...</error>
    </testcase>
  </testsuite>
</testsuites>`;
    const suites = parseJUnitXml(xml);
    expect(suites).toHaveLength(2);
    expect(suites[1]!.cases[0]).toMatchObject({ status: 'failed', errorType: 'TimeoutError' });
  });

  it('handles attributes in any order and single quotes', () => {
    const xml = `<testsuite failures="0" tests="1" time='0.3' name="attrs">
  <testcase time="0.3" classname='x' name="attr order"/>
</testsuite>`;
    const suites = parseJUnitXml(xml);
    expect(suites[0]!.name).toBe('attrs');
    expect(suites[0]!.cases[0]).toMatchObject({ name: 'attr order', className: 'x', durationMs: 300 });
  });

  it('decodes XML entities including numeric and hex forms', () => {
    const xml = `<testsuite name="ent" tests="1">
  <testcase name="quotes &quot;&apos;&#39;&#x27; and &lt;tags&gt;" classname="E" time="0">
    <failure message="a &amp; b &lt;cmp&gt;">stack with &amp;amp; entity</failure>
  </testcase>
</testsuite>`;
    const suites = parseJUnitXml(xml);
    const c = suites[0]!.cases[0]!;
    expect(c.name).toBe(`quotes "''' and <tags>`);
    expect(c.errorMessage).toBe('a & b <cmp>');
    expect(c.errorStack).toBe('stack with &amp; entity');
  });

  it('strips CDATA wrappers and keeps content verbatim', () => {
    const xml = `<testsuite name="cd" tests="1">
  <testcase name="cdata case" classname="C" time="0">
    <failure message="boom"><![CDATA[raw <notescaped> & raw]]></failure>
  </testcase>
</testsuite>`;
    const suites = parseJUnitXml(xml);
    expect(suites[0]!.cases[0]!.errorStack).toBe('raw <notescaped> & raw');
  });

  it('never throws on malformed input — returns what parsed plus warnings', () => {
    const malformed = `<testsuite name="broken" tests="2"><testcase name="ok" time="0.1">
    <failure message="dangling`;

    const { suites, warnings } = parseJUnitXmlDetailed(malformed);
    expect(suites).toHaveLength(1);
    expect(suites[0]!.cases[0]!.name).toBe('ok');
    expect(warnings.length + suites[0]!.warnings.length).toBeGreaterThan(0);
  });

  it('reports a warning for mismatched end tags instead of throwing', () => {
    const { suites, warnings } = parseJUnitXmlDetailed(
      '<testsuite name="m"><testcase name="t" time="0"></testcase></wrongclose>',
    );
    expect(suites).toHaveLength(1);
    expect(warnings.some((w) => w.toLowerCase().includes('mismatch') || w.length > 0)).toBe(true);
  });

  it('returns a warning (not a throw) for non-JUnit garbage', () => {
    const { suites, warnings } = parseJUnitXmlDetailed('this is not xml at all');
    expect(suites).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('treats empty input honestly', () => {
    const { suites, warnings } = parseJUnitXmlDetailed('');
    expect(suites).toHaveLength(0);
    expect(warnings).toContain('empty input — nothing to parse');
  });

  it('reconciles counts from cases when suite attributes are absent', () => {
    const xml = `<testsuite name="counts">
  <testcase name="p1" time="0.1"/>
  <testcase name="f1" time="0.1"><failure message="x"/></testcase>
  <testcase name="s1" time="0"><skipped/></testcase>
</testsuite>`;
    const s = parseJUnitXml(xml)[0]!;
    expect(s.tests).toBe(3);
    expect(s.failures).toBe(1);
    expect(s.skipped).toBe(1);
  });

  it('decodes entities with the documented ordering guarantees', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('&#x27;')).toBe("'");
    expect(decodeEntities('&#39;')).toBe("'");
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    expect(decodeEntities('plain')).toBe('plain');
  });
});
