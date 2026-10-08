import { describe, expect, it } from 'vitest';
import { RiskAgent } from '../src/agents/risk.js';
import { commitAll, initRepo, makeTempDir, write } from './helpers.js';

describe('RiskAgent.assess', () => {
  it('assesses a real git diff: payment change → critical tier with boundary signal', async () => {
    const root = makeTempDir('risk-repo');
    initRepo(root);
    write(root, 'README.md', '# Sample app\n\nBaseline documentation.\n');
    commitAll(root, 'docs: baseline readme');

    const paymentSource = [
      'export function chargeCard(amountMinor: number, token: string): string {',
      "  if (amountMinor <= 0) throw new Error('invalid amount');",
      "  return `charge:${token}:${amountMinor}`;",
      '}',
      '',
      'export function refund(chargeId: string, amountMinor: number): string {',
      "  if (!chargeId) throw new Error('missing charge');",
      "  return `refund:${chargeId}:${amountMinor}`;",
      '}',
    ].join('\n');
    write(root, 'src/payment.ts', `${paymentSource}\n`);
    commitAll(root, 'feat: payment charge and refund logic');

    const agent = new RiskAgent(root);
    const result = await agent.assess('HEAD~1');

    const payment = result.changedFiles.find((f) => f.path === 'src/payment.ts');
    expect(payment).toBeDefined();
    expect(payment?.area).toBe('payment');
    expect(payment?.additions).toBeGreaterThan(0);
    expect(result.routing.paymentRelated).toBe(true);
    expect(result.routing.boundarySignals).toContain('payment');
    expect(result.assessment.factors).toHaveLength(8);
    expect(result.assessment.tier).toBe('critical'); // payment floor per core engine
    expect(result.assessment.score).toBeGreaterThan(0);
    expect(result.assessment.explanation).toMatch(/Risk:/);
    expect(result.label).toBe('INFERRED');
  });

  it('respects config weights/thresholds when injected', async () => {
    const root = makeTempDir('risk-config');
    initRepo(root);
    write(root, 'src/util.ts', 'export const id = (x: number): number => x;\n');
    commitAll(root, 'feat: util');

    const agent = new RiskAgent(root, {
      config: {
        schemaVersion: 1,
        project: { name: 'test', criticalPaths: [], criticalFlows: [] },
      },
    });
    const result = await agent.assess('HEAD~1');
    expect(result.changedFiles.some((f) => f.path === 'src/util.ts')).toBe(true);
    // Util change: no critical markers → below the critical tier.
    expect(result.assessment.tier).not.toBe('critical');
    expect(result.routing.paymentRelated).toBe(false);
  });

  it('counts distinct top-level modules of changed source files', async () => {
    const root = makeTempDir('risk-modules');
    initRepo(root);
    write(root, 'src/a/one.ts', 'export const one = 1;\n');
    write(root, 'src/b/two.ts', 'export const two = 2;\n');
    write(root, 'src/a/one.test.ts', "import { it } from 'vitest';\nit('x', () => {});\n");
    commitAll(root, 'feat: modules');

    const result = await new RiskAgent(root).assess('HEAD~1');
    // src/a and src/b are two modules; the test file under src/a is excluded.
    expect(result.assessment.factors.find((f) => f.factor === 'codeComplexity')?.reasons.join(' ')).toMatch(/2 modules/);
  });
});
