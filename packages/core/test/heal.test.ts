import { describe, expect, it } from 'vitest';
import { buildProposal, changesAssertions, raisesTimeoutValue, selectorCandidatesFromSnapshot } from '../src/heal/tiers.js';
import { applyProposal, canApply, classifyDeletionRequest } from '../src/heal/policy.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('self-healing confidence tiers', () => {
  const snapshot = `<button data-testid="checkout-btn" aria-label="Checkout">Pay</button>`;

  it('HIGH tier for a pure selector swap observed in the target snapshot', () => {
    const proposal = buildProposal({
      testId: 't1',
      filePath: 'tests/checkout.spec.ts',
      kind: 'selector',
      description: 'locator .btn-checkout no longer present',
      currentCode: `await page.locator('.btn-checkout').click();`,
      proposedCode: `await page.getByTestId('checkout-btn').click();`,
      observedInTarget: snapshot,
      signals: ['selector .btn-checkout absent from DOM snapshot'],
    });
    expect(proposal.tier).toBe('HIGH');
    expect(proposal.confidence).toBeGreaterThanOrEqual(0.9);
    expect(proposal.violations).toHaveLength(0);
    expect(proposal.policyChecks.some((c) => c.includes('rule-1'))).toBe(true);
  });

  it('LOW tier and forbidden when the proposal would weaken an assertion', () => {
    const proposal = buildProposal({
      testId: 't2',
      filePath: 'tests/cart.spec.ts',
      kind: 'assertion',
      description: 'total assertion fails',
      currentCode: `expect(cart.total()).toBe(25);`,
      proposedCode: `expect(cart.total()).toBeGreaterThan(0);`,
      signals: ['assertion mismatch observed'],
    });
    expect(proposal.tier).toBe('LOW');
    expect(proposal.violations.join(' ')).toMatch(/weakening/);
    expect(canApply(proposal)).toBe(false);
  });

  it('LOW tier when the proposed selector was never observed (no guessing)', () => {
    const proposal = buildProposal({
      testId: 't3',
      filePath: 'tests/nav.spec.ts',
      kind: 'selector',
      description: 'guessing a new selector',
      currentCode: `await page.locator('.old-nav').click();`,
      proposedCode: `await page.locator('.nav-guess').click();`,
      signals: ['old selector missing'],
    });
    expect(proposal.tier).toBe('LOW');
    expect(proposal.violations.join(' ')).toMatch(/not observed/);
  });

  it('LOW tier when the proposal adds a sleep or raises a timeout', () => {
    const sleep = buildProposal({
      testId: 't4',
      filePath: 'tests/x.spec.ts',
      kind: 'timing',
      description: 'wait longer',
      currentCode: `await page.click('#go');`,
      proposedCode: `await page.waitForTimeout(9000); await page.click('#go');`,
      signals: [],
    });
    expect(sleep.tier).toBe('LOW');

    const timeout = buildProposal({
      testId: 't5',
      filePath: 'tests/y.spec.ts',
      kind: 'timing',
      description: 'raise timeout',
      currentCode: `await page.click('#go', { timeout: 5000 });`,
      proposedCode: `await page.click('#go', { timeout: 30000 });`,
      signals: [],
    });
    expect(timeout.violations.join(' ')).toMatch(/timeout/);
  });

  it('detects assertion changes and timeout increases precisely', () => {
    expect(changesAssertions(`expect(a).toBe(1);`, `expect(a).toBe(1);`)).toBe(false);
    expect(changesAssertions(`expect(a).toBe(1);`, `expect(a).toBe(2);`)).toBe(true);
    expect(raisesTimeoutValue(`{ timeout: 5000 }`, `{ timeout: 5000 }`)).toBe(false);
    expect(raisesTimeoutValue(`{ timeout: 5000 }`, `{ timeout: 15000 }`)).toBe(true);
  });

  it('generates semantic selector candidates from a DOM snapshot', () => {
    const candidates = selectorCandidatesFromSnapshot(snapshot, '.btn-checkout');
    expect(candidates).toContain(`getByTestId('checkout-btn')`);
    expect(candidates).toContain(`getByLabel('Checkout')`);
    expect(candidates).not.toContain('.btn-checkout');
  });

  it('applies HIGH-tier proposals with a backup and refuses propose-only tiers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tqa-heal-'));
    try {
      mkdirSync(join(dir, 'tests'), { recursive: true });
      const rel = 'tests/checkout.spec.ts';
      const abs = join(dir, rel);
      writeFileSync(abs, `await page.locator('.btn-checkout').click();\n`, 'utf8');
      const proposal = buildProposal({
        testId: 't1',
        filePath: rel,
        kind: 'selector',
        description: 'selector swap',
        currentCode: `await page.locator('.btn-checkout').click();`,
        proposedCode: `await page.getByTestId('checkout-btn').click();`,
        observedInTarget: snapshot,
        signals: [],
      });
      const result = applyProposal(proposal, dir, { confirmRisk: true });
      expect(result.applied).toBe(true);
      expect(readFileSync(abs, 'utf8')).toContain(`getByTestId('checkout-btn')`);
      expect(existsBackup(abs)).toBe(true);

      const low = { ...proposal, tier: 'LOW' as const, id: 'heal-low' };
      const refused = applyProposal(low, dir);
      expect(refused.applied).toBe(false);
      expect(refused.reason).toMatch(/propose-only/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never allows automatic deletion (golden rule 7)', () => {
    expect(classifyDeletionRequest(5).allowed).toBe(false);
    expect(classifyDeletionRequest(5, 'other-test').allowed).toBe(false);
    expect(classifyDeletionRequest(5, 'other-test').reason).toMatch(/human approval/);
  });
});

function existsBackup(path: string): boolean {
  try {
    readFileSync(`${path}.pre-heal.bak`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
