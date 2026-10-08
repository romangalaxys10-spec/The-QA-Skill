import { describe, expect, it } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import { commitAll, initRepo, makeTempDir, write } from './helpers.js';

function makeRepo(): string {
  const root = makeTempDir('orchestrator-repo');
  initRepo(root, { name: 'sample-app', private: true });
  write(root, 'README.md', '# Sample app\n\n- The app must serve the checkout page\n');
  commitAll(root, 'docs: readme');
  write(root, 'src/payment.ts', 'export const charge = (n: number): number => n * 100;\n');
  commitAll(root, 'feat: payment logic');
  return root;
}

describe('Orchestrator.runIntent', () => {
  it('walks "qa this pr" as a dry-run pipeline: all phases done-or-skipped, no throw, label present', async () => {
    const root = makeRepo();
    const orchestrator = new Orchestrator(root);
    const result = await orchestrator.runIntent('qa this pr', { dryRun: true });

    // Lifecycle: every phase complete or skipped — never pending/blocked.
    expect(result.lifecycle).toHaveLength(12);
    for (const phase of result.lifecycle) {
      expect(['complete', 'skipped']).toContain(phase.status);
      if (phase.status === 'skipped') expect(phase.note).toBeDefined();
    }

    // Plan steps mirror the walk.
    expect(result.plan).toHaveLength(12);
    for (const step of result.plan) {
      expect(['done', 'skipped']).toContain(step.status);
      expect(step.action.length).toBeGreaterThan(0);
    }

    // Pipeline payload.
    expect(result.risk).toBeDefined();
    expect(result.risk?.tier).toBe('critical'); // payment change in the diff
    expect(result.selection).toBeDefined();
    expect(result.events).toEqual([]); // dry-run: nothing executed
    expect(result.triage).toEqual([]);
    expect(result.gate).toBeDefined();
    expect(['NOT_VERIFIED', 'NOT_RUN', 'INFERRED', 'OBSERVED', 'CONFIRMED']).toContain(result.label);
    expect(result.label).toBe('INFERRED');
  });

  it('throws for production intents without confirmRisk and runs with it', async () => {
    const root = makeRepo();
    const orchestrator = new Orchestrator(root);

    await expect(orchestrator.runIntent('run production smoke tests')).rejects.toThrow(/HIGH_RISK/);

    const result = await orchestrator.runIntent('run production smoke tests', { confirmRisk: true, dryRun: true });
    expect(result.lifecycle.every((p) => p.status === 'complete' || p.status === 'skipped')).toBe(true);
  });

  it('skips HEAL and LEARN with recorded reasons when there is nothing to do', async () => {
    const root = makeRepo();
    const result = await new Orchestrator(root).runIntent('qa this pr', { dryRun: true });

    const heal = result.lifecycle.find((p) => p.phase === 'HEAL');
    const learn = result.lifecycle.find((p) => p.phase === 'LEARN');
    expect(heal?.status).toBe('skipped');
    expect(heal?.note).toMatch(/no healing proposals/);
    expect(learn?.status).toBe('skipped');
    expect(learn?.note).toMatch(/no lessons/);
  });

  it('forces dry-run execution for read-only intents', async () => {
    const root = makeRepo();
    const result = await new Orchestrator(root).runIntent('discover the test inventory');
    const execute = result.plan.find((s) => s.phase === 'EXECUTE');
    expect(execute?.note).toMatch(/dry-run/);
    expect(result.events).toEqual([]);
  });

  it('degrades honestly when the diff range cannot be resolved (first-commit repo)', async () => {
    const root = makeTempDir('orchestrator-single');
    initRepo(root);
    const result = await new Orchestrator(root).runIntent('qa this pr', { dryRun: true, range: 'HEAD~1' });
    // HEAD~1 fails, empty-tree fallback succeeds → PLAN completes with empty diff.
    const plan = result.lifecycle.find((p) => p.phase === 'PLAN');
    expect(plan?.status).toBe('complete');
    expect(result.risk).toBeDefined();
    expect(result.label).toBeDefined();
  });
});
