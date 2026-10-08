import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SelectionResult } from '@the-qa-skill/core';
import { DefaultRunnerAdapter, ExecutionAgent } from '../src/agents/execution.js';
import type { SpawnFn } from '../src/agents/execution.js';
import { makeTempDir, write } from './helpers.js';

function rootWithVitest(): string {
  const root = makeTempDir('execution');
  write(root, 'package.json', JSON.stringify({ name: 'app', private: true, devDependencies: { vitest: '^2.1.0' } }));
  return root;
}

const VITEST_JSON = JSON.stringify({
  testResults: [
    {
      assertionResults: [
        { fullName: 'pays with a valid card', status: 'passed', duration: 12 },
        { fullName: 'rejects an invalid card', status: 'failed', duration: 8, filePath: 'tests/checkout.test.ts' },
      ],
    },
  ],
});

describe('ExecutionAgent', () => {
  it('dry-run plans commands for detected runners without spawning anything', async () => {
    const root = rootWithVitest();
    const calls: number[] = [];
    const spawner: SpawnFn = async () => {
      calls.push(1);
      return { stdout: '', stderr: '', code: 0 };
    };
    const agent = new ExecutionAgent(root, { spawner });

    const outcome = await agent.execute(null, { policy: 'pr', dryRun: true });

    expect(calls).toHaveLength(0);
    expect(outcome.dryRun).toBe(true);
    expect(outcome.events).toEqual([]);
    expect(outcome.bundles).toEqual([]);
    expect(outcome.plannedCommands).toEqual([{ runner: 'vitest', command: 'npx', args: ['vitest', 'run'] }]);
  });

  it('null selection plans whole-suite commands; selection filters files', async () => {
    const root = rootWithVitest();
    const agent = new ExecutionAgent(root, {
      spawner: async () => ({ stdout: '', stderr: '', code: 0 }),
    });

    const wholeSuite = await agent.execute(null, { policy: 'pr', dryRun: true });
    expect(wholeSuite.plannedCommands[0]?.args).toEqual(['vitest', 'run']);

    const selection: SelectionResult = {
      selected: [
        {
          test: {
            testId: 'tests/checkout.test.ts',
            name: 'checkout.test.ts',
            filePath: 'tests/checkout.test.ts',
            layer: 'unit',
            framework: 'vitest',
            covers: [],
          },
          priority: 'high',
          reasons: ['covers changed file'],
        },
      ],
      unaffected: [],
      routing: [],
      summary: '1 selected',
      label: 'INFERRED',
    };
    const filtered = await agent.execute(selection, { policy: 'pr', dryRun: true });
    expect(filtered.plannedCommands[0]?.args).toEqual(['vitest', 'run', 'tests/checkout.test.ts']);
  });

  it('real run maps stdout JSON onto core TestEvents and re-stamps identity', async () => {
    const root = rootWithVitest();
    const seen: Array<{ command: string; args: string[]; timeoutMs: number }> = [];
    const spawner: SpawnFn = async (command, args, ctx) => {
      seen.push({ command, args, timeoutMs: ctx.timeoutMs });
      return { stdout: VITEST_JSON, stderr: 'ERR boom: payment gateway unreachable\n', code: 1 };
    };
    const agent = new ExecutionAgent(root, { spawner });

    const outcome = await agent.execute(null, { policy: 'pr', dryRun: false, environment: 'ci' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.command).toBe('npx');
    expect(seen[0]?.timeoutMs).toBe(600000);
    expect(outcome.dryRun).toBe(false);
    expect(outcome.runId).toMatch(/^run-[0-9a-f]{10}$/);
    expect(outcome.events).toHaveLength(2);

    const passed = outcome.events.find((e) => e.name === 'pays with a valid card');
    expect(passed?.status).toBe('passed');
    expect(passed?.runId).toBe(outcome.runId);
    expect(passed?.framework).toBe('vitest');
    expect(passed?.environment).toBe('ci');
    expect(passed?.durationMs).toBe(12);

    const failed = outcome.events.find((e) => e.name === 'rejects an invalid card');
    expect(failed?.status).toBe('failed');
    expect(failed?.errorMessage).toContain('payment gateway unreachable');
    expect(failed?.filePath).toBe('tests/checkout.test.ts');

    // Evidence bundles are written for failures under the artifacts layout.
    expect(outcome.bundles).toHaveLength(1);
    expect(outcome.bundles[0]?.testId).toBe('rejects an invalid card');
    expect(existsSync(outcome.bundles[0]?.path ?? '')).toBe(true);
  });

  it('synthesizes a suite-level failure when a runner exits non-zero without parseable output', async () => {
    const root = rootWithVitest();
    const agent = new ExecutionAgent(root, {
      spawner: async () => ({ stdout: 'no json here', stderr: 'crashed: cannot find module', code: 1 }),
    });
    const outcome = await agent.execute(null, { policy: 'pr', dryRun: false });
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]?.testId).toBe('vitest:suite');
    expect(outcome.events[0]?.status).toBe('failed');
    expect(outcome.events[0]?.errorMessage).toContain('cannot find module');
  });

  it('detects no frameworks without package.json and plans nothing', async () => {
    const root = makeTempDir('no-framework');
    const agent = new ExecutionAgent(root, { spawner: async () => ({ stdout: '', stderr: '', code: 0 }) });
    const outcome = await agent.execute(null, { policy: 'nightly', dryRun: false });
    expect(outcome.plannedCommands).toEqual([]);
    expect(outcome.events).toEqual([]);
  });
});

describe('DefaultRunnerAdapter', () => {
  const adapter = new DefaultRunnerAdapter();

  it('detects frameworks from package.json in deterministic order', () => {
    const root = makeTempDir('adapter-detect');
    write(root, 'package.json', JSON.stringify({ devDependencies: { '@playwright/test': '^1.0.0', vitest: '^2.0.0', jest: '^29.0.0' } }));
    expect(adapter.frameworksAt(root)).toEqual(['vitest', 'jest', 'playwright']);
    expect(adapter.frameworksAt(makeTempDir('adapter-empty'))).toEqual([]);
  });

  it('parses tolerant JSON shapes and maps statuses conservatively', () => {
    const events = adapter.parse('vitest', `noise before {"events":[{"title":"a","status":"passed"},{"title":"b","state":"failed"},{"title":"c","status":"pending"},{"title":"d","status":"timed_out"}]} noise after`);
    expect(events.map((e) => e.status)).toEqual(['passed', 'failed', 'skipped', 'timedout']);
    expect(events.every((e) => e.framework === 'vitest')).toBe(true);

    const weird = adapter.parse('vitest', '{"tests":[{"title":"x","status":"banana"}]}');
    expect(weird[0]?.status).toBe('not_run');

    expect(adapter.parse('vitest', 'plain text output')).toEqual([]);
    expect(adapter.parse('vitest', '{"broken": ')).toEqual([]);
  });
});
