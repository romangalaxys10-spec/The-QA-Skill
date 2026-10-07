import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HealingOrchestrator, extractFailedSelector, groupByTier } from '../src/index.js';
import { LearningStore } from '@the-qa-skill/core';
import type { FailedTestRecord, TriageResult } from '@the-qa-skill/core';

const failure = (testId: string, category: TriageResult['category']): FailedTestRecord => ({
  testId,
  name: testId,
  filePath: `tests/${testId}.spec.ts`,
  layer: 'e2e',
  attempts: [{ status: 'failed', durationMs: 100, timestamp: '2026-10-07T10:00:00Z', environment: 'ci', errorType: 'TimeoutError', errorMessage: 'waiting for locator .old-btn' }],
  changedFiles: [],
  recentRuns: ['passed', 'passed'],
});

const triage = (testId: string, category: TriageResult['category']): TriageResult => ({
  testId,
  category,
  confidence: 0.9,
  rootCauseHypothesis: 'h',
  signals: [],
  contradictingSignals: [],
  recommendedAction: 'a',
  evidence: [],
  label: 'OBSERVED',
});

describe('HealingOrchestrator', () => {
  const snapshot = `<button data-testid="new-btn">Go</button>`;

  it('allows HIGH tier only for SELECTOR_FAILURE with observed evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tqa-horch-'));
    try {
      const orch = new HealingOrchestrator(dir);
      const proposals = orch.proposeForFailures(
        [failure('t1', 'SELECTOR_FAILURE')],
        [triage('t1', 'SELECTOR_FAILURE')],
        [{ testId: 't1', candidate: {
          filePath: 'tests/t1.spec.ts',
          kind: 'selector',
          description: 'selector swap',
          currentCode: `await page.locator('.old-btn').click();`,
          proposedCode: `await page.getByTestId('new-btn').click();`,
          observedInTarget: snapshot,
          signals: ['old selector absent'],
        } }],
      );
      expect(proposals[0]?.tier).toBe('HIGH');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('caps non-selector categories at MEDIUM even with clean mechanical checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tqa-horch2-'));
    try {
      const orch = new HealingOrchestrator(dir);
      const proposals = orch.proposeForFailures(
        [failure('t2', 'REAL_REGRESSION')],
        [triage('t2', 'REAL_REGRESSION')],
        [{ testId: 't2', candidate: {
          filePath: 'tests/t2.spec.ts',
          kind: 'selector',
          description: 'swap',
          currentCode: `await page.locator('.a').click();`,
          proposedCode: `await page.getByTestId('b').click();`,
          observedInTarget: snapshot,
          signals: [],
        } }],
      );
      expect(proposals[0]?.tier).toBe('MEDIUM');
      expect(proposals[0]?.rationale).toMatch(/REAL_REGRESSION/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('demotes previously rejected targets to LOW and records apply outcomes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tqa-horch3-'));
    try {
      mkdirSync(join(dir, 'tests'), { recursive: true });
      const store = new LearningStore(join(dir, '.theqa', 'learning.jsonl'));
      store.append({ type: 'healing_rejected', tags: ['healing'], payload: { testId: 't3' }, effect: 'human rejected this heal' });
      const orch = new HealingOrchestrator(dir, { learning: store });
      const proposals = orch.proposeForFailures(
        [failure('t3', 'SELECTOR_FAILURE')],
        [triage('t3', 'SELECTOR_FAILURE')],
        [{ testId: 't3', candidate: {
          filePath: 'tests/t3.spec.ts',
          kind: 'selector',
          description: 'swap',
          currentCode: `await page.locator('.x').click();`,
          proposedCode: `await page.getByTestId('y').click();`,
          observedInTarget: snapshot,
          signals: [],
        } }],
      );
      expect(proposals[0]?.tier).toBe('LOW');
      expect(proposals[0]?.violations.join(' ')).toMatch(/rejected/);

      // A previously rejected proposal is refused even if someone flips the tier.
      writeFileSync(join(dir, 'tests', 't3.spec.ts'), `await page.locator('.x').click();\n`);
      const refused = orch.apply({ ...proposals[0]!, tier: 'HIGH' }, { confirmRisk: true });
      expect(refused.applied).toBe(false);
      expect(refused.reason).toMatch(/propose-only/);

      // A fresh, non-rejected proposal applies and records the audit trail.
      const fresh = orch.proposeForFailures(
        [failure('t4', 'SELECTOR_FAILURE')],
        [triage('t4', 'SELECTOR_FAILURE')],
        [{ testId: 't4', candidate: {
          filePath: 'tests/t3.spec.ts',
          kind: 'selector',
          description: 'swap',
          currentCode: `await page.locator('.x').click();`,
          proposedCode: `await page.getByTestId('y').click();`,
          observedInTarget: snapshot,
          signals: [],
        } }],
      );
      const applied = orch.apply(fresh[0]!, { confirmRisk: true });
      expect(applied.applied).toBe(true);
      const records = store.query({ type: 'healing_applied' });
      expect(records).toHaveLength(1);
      expect(records[0]?.effect).toMatch(/VERIFY phase/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts failed selectors from error text and groups by tier', () => {
    expect(extractFailedSelector(failure('t9', 'SELECTOR_FAILURE'))).toBe('.old-btn');
    const grouped = groupByTier([
      { id: '1', testId: 'a', filePath: 'f', kind: 'selector', description: '', currentCode: '', proposedCode: '', tier: 'HIGH', confidence: 0.9, evidence: [], rationale: '', policyChecks: [], violations: [] },
      { id: '2', testId: 'b', filePath: 'f', kind: 'timing', description: '', currentCode: '', proposedCode: '', tier: 'LOW', confidence: 0.2, evidence: [], rationale: '', policyChecks: [], violations: ['x'] },
    ]);
    expect(grouped.HIGH).toHaveLength(1);
    expect(grouped.LOW).toHaveLength(1);
  });
});
