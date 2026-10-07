import { describe, expect, it } from 'vitest';
import type { ReleaseGateResult, RiskAssessment } from '@the-qa-skill/core';
import { colorForVerdict, toSlackPayload } from '../src/slack.js';

const gate = (verdict: ReleaseGateResult['verdict']): ReleaseGateResult => ({
  verdict,
  reasons: ['reason one'],
  blockingFindings: verdict === 'BLOCKED' ? ['1 real regression failure(s)'] : [],
  warnings: verdict === 'PASS_WITH_WARNINGS' ? ['evidence incomplete'] : [],
  label: 'OBSERVED',
});

const risk: RiskAssessment = {
  score: 87,
  tier: 'critical',
  factors: [],
  topContributors: [],
  explanation: 'payment changed',
  label: 'INFERRED',
};

describe('slack payload', () => {
  it('maps verdicts to the documented colors', () => {
    expect(colorForVerdict('PASS')).toBe('good');
    expect(colorForVerdict('PASS_WITH_WARNINGS')).toBe('#e2b203');
    expect(colorForVerdict('BLOCKED')).toBe('danger');
    expect(colorForVerdict('FAIL')).toBe('danger');
    expect(colorForVerdict('UNKNOWN')).toBe('#808080');
    expect(colorForVerdict(undefined)).toBe('#808080');
  });

  it('builds header + fields + verdict attachment', () => {
    const msg = toSlackPayload({ title: 'QA run on main', gate: gate('BLOCKED'), failing: 3, total: 40, risk });
    expect(msg.text).toContain('QA run on main');
    expect(msg.text).toContain('BLOCKED');

    const header = msg.blocks.find((b) => b.type === 'header');
    expect(header?.text?.text).toBe('QA run on main');

    const fields = msg.blocks.find((b) => b.type === 'section')?.fields ?? [];
    const fieldText = fields.map((f) => f.text).join('\n');
    expect(fieldText).toContain('37/40');
    expect(fieldText).toContain('Failing');
    expect(fieldText).toContain('3');
    expect(fieldText).toContain('critical (87/100)');

    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]!.color).toBe('danger');
    expect(JSON.stringify(msg.attachments[0]!.blocks)).toContain('1 real regression failure(s)');
  });

  it('uses the amber color with warnings listed for PASS_WITH_WARNINGS', () => {
    const msg = toSlackPayload({ title: 't', gate: gate('PASS_WITH_WARNINGS'), failing: 1, total: 10 });
    expect(msg.attachments[0]!.color).toBe('#e2b203');
    expect(JSON.stringify(msg.attachments[0]!.blocks)).toContain('evidence incomplete');
  });

  it('degrades honestly without a gate (grey UNKNOWN, no invented verdict)', () => {
    const msg = toSlackPayload({ title: 't', failing: 0, total: 0 });
    expect(msg.blocks.some((b) => b.text?.text.includes('UNKNOWN') || b.fields?.some((f) => f.text.includes('UNKNOWN')))).toBe(true);
    expect(msg.attachments[0]!.color).toBe('#808080');
    expect(msg.attachments[0]!.blocks[0]!.text?.text).toContain('No release gate evaluation');
  });

  it('includes a report link context block when a url is given', () => {
    const msg = toSlackPayload({ title: 't', failing: 0, total: 5, url: 'https://ci.example.com/run/1' });
    const context = msg.blocks.find((b) => b.type === 'context');
    expect(context?.elements?.[0]?.text).toContain('https://ci.example.com/run/1');
  });
});
