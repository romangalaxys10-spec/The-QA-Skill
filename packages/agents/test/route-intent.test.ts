import { describe, expect, it } from 'vitest';
import { routeIntent } from '../src/route-intent.js';
import { LIFECYCLE_PHASES } from '@the-qa-skill/core';

describe('routeIntent', () => {
  it('classifies the eight intent kinds (table)', () => {
    const table: Array<[string, string]> = [
      ['qa this pr', 'pr_review'],
      ['review the pull request diff', 'pr_review'],
      ['run the nightly suite', 'nightly'],
      ['prepare the release checklist', 'release'],
      ['ship it to customers', 'release'],
      ['generate tests for the login flow', 'generate'],
      ['scaffold cases for checkout', 'generate'],
      ['triage last night failures', 'triage'],
      ['investigate the failure in checkout', 'triage'],
      ['heal the broken selector', 'heal'],
      ['discover the test inventory', 'discover'],
      ['what can you do for me', 'explain'],
    ];
    for (const [text, kind] of table) {
      expect(routeIntent(text).kind, `intent "${text}"`).toBe(kind);
    }
  });

  it('always plans all 12 lifecycle phases with actions and a rationale', () => {
    for (const kind of ['pr_review', 'nightly', 'release', 'generate', 'triage', 'heal', 'discover', 'explain'] as const) {
      const textFor: Record<string, string> = {
        pr_review: 'qa this pr',
        nightly: 'run the nightly suite',
        release: 'release checklist',
        generate: 'generate tests',
        triage: 'triage failures',
        heal: 'heal failures',
        discover: 'discover inventory',
        explain: 'explain yourself',
      };
      const plan = routeIntent(textFor[kind] ?? kind);
      expect(plan.kind).toBe(kind);
      expect(plan.steps.map((s) => s.phase)).toEqual([...LIFECYCLE_PHASES]);
      expect(plan.steps.every((s) => s.status === 'planned')).toBe(true);
      expect(plan.steps.every((s) => s.action.length > 0)).toBe(true);
      expect(plan.rationale.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic — identical text yields an identical plan', () => {
    const a = routeIntent('qa this pr');
    const b = routeIntent('qa this pr');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('defaults unknown intents to the read-only explain pipeline', () => {
    const plan = routeIntent('tell me a joke');
    expect(plan.kind).toBe('explain');
    expect(plan.rationale).toMatch(/no known intent keyword/);
  });
});
