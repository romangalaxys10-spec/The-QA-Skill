import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LearningStore } from '@the-qa-skill/core';
import { HealingAgent } from '../src/agents/healing.js';
import { makeTempDir, write } from './helpers.js';

describe('HealingAgent', () => {
  it('proposes HIGH tier for an observed selector swap and applies it with a backup', () => {
    const root = makeTempDir('heal');
    const original = [
      "import { test, expect } from '@playwright/test';",
      '',
      "test('nav', async ({ page }) => {",
      "  await page.locator('.btn-old').click();",
      '  await expect(page).toHaveURL(/dashboard/);',
      '});',
    ].join('\n');
    write(root, 'tests/nav.spec.ts', original);
    const learning = new LearningStore(join(root, 'learning.jsonl'));
    const agent = new HealingAgent(root, { learning });

    const proposal = agent.propose({
      testId: 'nav',
      filePath: 'tests/nav.spec.ts',
      kind: 'selector',
      description: 'locator .btn-old no longer present in the DOM',
      currentCode: "await page.locator('.btn-old').click();",
      proposedCode: "await page.getByTestId('nav-cta').click();",
      observedInTarget: '<button data-testid="nav-cta">Go</button>',
      signals: ['selector .btn-old absent from the captured DOM snapshot'],
    });
    expect(proposal.tier).toBe('HIGH');
    expect(proposal.violations).toHaveLength(0);
    expect(proposal.policyChecks.join(' ')).toMatch(/rule-1/);

    const result = agent.apply(proposal, { confirmRisk: true });
    expect(result.applied).toBe(true);
    expect(result.backupPath).toBe('tests/nav.spec.ts.pre-heal.bak');
    expect(readFileSync(join(root, 'tests/nav.spec.ts'), 'utf8')).toContain("getByTestId('nav-cta')");
    expect(existsSync(join(root, 'tests', 'nav.spec.ts.pre-heal.bak'))).toBe(true);
    expect(readFileSync(join(root, 'tests', 'nav.spec.ts.pre-heal.bak'), 'utf8')).toContain('.btn-old');

    const records = learning.query({ type: 'healing_applied' });
    expect(records).toHaveLength(1);
    expect(records[0]?.effect).toMatch(/patched tests\/nav\.spec\.ts/);
  });

  it('refuses LOW-tier proposals and records the rejection with an effect', () => {
    const root = makeTempDir('heal-reject');
    write(
      root,
      'tests/nav.spec.ts',
      "import { expect, test } from '@playwright/test';\ntest('nav', async ({ page }) => {\n  await expect(page).toHaveURL(/dashboard/);\n});\n",
    );
    const learning = new LearningStore(join(root, 'learning.jsonl'));
    const agent = new HealingAgent(root, { learning });

    const proposal = agent.propose({
      testId: 'nav',
      filePath: 'tests/nav.spec.ts',
      kind: 'assertion',
      description: 'URL assertion fails after navigation change',
      currentCode: 'await expect(page).toHaveURL(/dashboard/);',
      proposedCode: 'await expect(page).toHaveURL(/home/);',
      signals: ['assertion mismatch observed once'],
    });
    expect(proposal.tier).toBe('LOW');

    const result = agent.apply(proposal, { confirmRisk: true });
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/propose-only/);
    expect(readFileSync(join(root, 'tests/nav.spec.ts'), 'utf8')).toContain('/dashboard/');

    const rejections = learning.query({ type: 'healing_rejected' });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.effect).toMatch(/NOT applied/);
  });

  it('refuses to apply when the source drifted (currentCode no longer present)', () => {
    const root = makeTempDir('heal-drift');
    write(root, 'tests/nav.spec.ts', "test('nav', async ({ page }) => {\n  await page.locator('.rewritten').click();\n});\n");
    const agent = new HealingAgent(root);
    const proposal = agent.propose({
      testId: 'nav',
      filePath: 'tests/nav.spec.ts',
      kind: 'selector',
      description: 'stale locator',
      currentCode: "await page.locator('.btn-old').click();",
      proposedCode: "await page.getByTestId('nav-cta').click();",
      observedInTarget: '<button data-testid="nav-cta">Go</button>',
      signals: [],
    });
    const result = agent.apply(proposal, { confirmRisk: true });
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/drifted|missing/);
  });
});
