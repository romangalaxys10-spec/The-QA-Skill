import { describe, expect, it } from 'vitest';
import { auditGoldenRules, compressText, DTOC_CAPS, estimateTokens } from '../src/index.js';

describe('mechanical golden-rule audits', () => {
  it('flags arbitrary sleeps (rule 3) in healed code', () => {
    const report = auditGoldenRules('heal', {
      proposedPatch: "await page.waitForTimeout(3000);\nawait page.click('#x');",
      seed: 'abc123',
    });
    const r3 = report.results.find((r) => r.id === 3);
    expect(r3?.applicable).toBe(true);
    expect(r3?.passed).toBe(false);
    expect(report.valid).toBe(false);
    expect(report.violations[0]).toContain('Rule 3');
  });

  it('passes clean code and blocks REAL_REGRESSION retry masking (rule 2)', () => {
    const clean = auditGoldenRules('heal', {
      proposedPatch: "await expect(page.getByRole('button')).toBeVisible();",
      seed: 42,
      explanation: 'Replaced brittle id locator with semantic role locator; assertions preserved.',
    });
    expect(clean.violations).toHaveLength(0);
    expect(clean.checked).toBeGreaterThanOrEqual(2);

    const masked = auditGoldenRules('triage', { retryCount: 5, category: 'REAL_REGRESSION' });
    expect(masked.valid).toBe(false);
    expect(masked.violations[0]).toContain('Rule 2');
  });

  it('CONFIRMED without evidence violates rule 4; with evidence passes', () => {
    const bad = auditGoldenRules('test', { status: 'CONFIRMED' });
    expect(bad.violations.some((v) => v.startsWith('Rule 4'))).toBe(true);

    const good = auditGoldenRules('test', { status: 'CONFIRMED', evidenceRunId: 'run-2026-10-08-a1', category: 'ENVIRONMENT_FAILURE' });
    expect(good.violations.some((v) => v.startsWith('Rule 4'))).toBe(false);
  });

  it('e2e ratio over 0.4 violates the pyramid budget (rule 5)', () => {
    const report = auditGoldenRules('generate', { e2eRatio: 0.6, seed: 's' });
    expect(report.violations.some((v) => v.startsWith('Rule 5'))).toBe(true);
  });

  it('secrets in payloads violate rule 8', () => {
    const report = auditGoldenRules('test', { log: 'token ghp_' + 'a'.repeat(36) });
    expect(report.violations.some((v) => v.startsWith('Rule 8'))).toBe(true);
  });

  it('inapplicable rules report applicable=false instead of fake passes', () => {
    const report = auditGoldenRules('coverage', { note: 'no relevant fields' });
    for (const r of report.results) {
      // Nothing here is judgeable except secrets scan on strings.
      if (r.id !== 8) expect(r.applicable).toBe(false);
    }
  });

  it('triage payloads without explanations violate rule 14', () => {
    const report = auditGoldenRules('triage', { testId: 't1' });
    expect(report.violations.some((v) => v.startsWith('Rule 14'))).toBe(true);
  });
});

describe('token efficiency DTOC', () => {
  it('keeps short text untouched', () => {
    const out = compressText('logs', 'line1\nline2');
    expect(out.truncated).toBe(false);
    expect(out.text).toBe('line1\nline2');
  });

  it('keeps the HEAD for diffs and the TAIL for logs, always with a visible marker', () => {
    const diffLines = Array.from({ length: 250 }, (_, i) => `diff line ${i + 1}`).join('\n');
    const d = compressText('diff', diffLines);
    expect(d.truncated).toBe(true);
    expect(d.keptLines).toBe(DTOC_CAPS.diff);
    expect(d.text).toContain('diff line 1');
    expect(d.text).toContain(`DTOC: ${250 - DTOC_CAPS.diff} of 250 lines truncated`);
    expect(d.tokensAfter).toBeLessThan(d.tokensBefore);

    const logLines = Array.from({ length: 60 }, (_, i) => `log ${i + 1}`).join('\n');
    const l = compressText('logs', logLines);
    expect(l.text).toContain('log 60');
    expect(l.text).not.toContain('log 1\n');
    expect(l.marker).toBeDefined();
  });

  it('token estimates are stable and monotonic', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});
