import { describe, expect, it } from 'vitest';
import { analyzeTestFile, suiteHealth } from '../src/quality/score.js';
import { QUALITY_DIMENSIONS } from '../src/quality/dimensions.js';

describe('test quality score (17 dimensions)', () => {
  it('penalizes waitForTimeout, weak assertions, and secrets with reasons', () => {
    const bad = `
      const API_KEY = 'sk_live_abcdefghijklmnop1234';
      test('checkout', async ({ page }) => {
        await page.goto('/checkout');
        await page.waitForTimeout(5000);
        expect(true).toBe(true);
      });
    `;
    const report = analyzeTestFile('tests/checkout.spec.ts', bad);
    const dims = report.deductions.map((d) => d.dimension);
    expect(dims).toContain('determinism');
    expect(dims).toContain('assertionStrength');
    expect(dims).toContain('security');
    expect(report.score).toBeLessThan(80);
    const securityDeduction = report.deductions.find((d) => d.dimension === 'security');
    expect(securityDeduction?.reason).toMatch(/secret/);
  });

  it('gives a clean, well-asserted test a high score', () => {
    const good = `
      describe('cart totals', () => {
        it('adds two line items', () => {
          const cart = makeCart();
          cart.add(lineItem(10));
          cart.add(lineItem(15));
          expect(cart.total()).toBe(25);
        });
        it('rejects a negative price', () => {
          expect(() => lineItem(-1)).toThrow(/price must be non-negative/);
        });
        it('treats zero-quantity item as free', () => {
          const cart = makeCart();
          cart.add(lineItem(10, 0));
          expect(cart.total()).toBe(0);
        });
      });
    `;
    const report = analyzeTestFile('tests/cart.test.ts', good);
    expect(report.score).toBeGreaterThanOrEqual(85);
    expect(report.strengths.length).toBeGreaterThan(0);
  });

  it('penalizes test.only with a correctness deduction', () => {
    const report = analyzeTestFile('tests/a.test.ts', `test.only('one', () => { expect(1).toBe(1); });`);
    const d = report.deductions.find((x) => x.dimension === 'correctness');
    expect(d).toBeDefined();
    expect(d?.reason).toMatch(/only/);
  });

  it('penalizes empty catches under observability', () => {
    const report = analyzeTestFile('tests/b.test.ts', `test('x', async () => { try { await run(); } catch (e) {} });`);
    expect(report.deductions.some((d) => d.dimension === 'observability')).toBe(true);
  });

  it('defines exactly 17 dimensions with weights summing to 100', () => {
    expect(QUALITY_DIMENSIONS).toHaveLength(17);
    const total = QUALITY_DIMENSIONS.reduce((a, d) => a + d.weight, 0);
    expect(total).toBe(100);
  });

  it('suite health combines 10 documented components', () => {
    const health = suiteHealth({
      testReports: [analyzeTestFile('tests/a.test.ts', `test('a', () => { expect(sum(1,2)).toBe(3); });`)],
      weightedCoverage: 72,
      flakeHealthScore: 88,
      avgRuntimeMs: 20_000,
    });
    expect(health.components).toHaveLength(10);
    expect(health.score).toBeGreaterThan(0);
    expect(health.score).toBeLessThanOrEqual(100);
    const names = health.components.map((c) => c.component);
    expect(names).toContain('flake health');
    expect(names).toContain('risk coverage');
  });
});
