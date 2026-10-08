import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LearningStore, SelectionResult, SelectedTest } from '@the-qa-skill/core';
import { LearningStore as RealLearningStore } from '@the-qa-skill/core';
import { RunExecutor } from '../src/executor.js';
import type { RunExecutorOptions, SpawnImpl } from '../src/executor.js';
import { PlaywrightRunner } from '../src/playwright.js';
import { PytestRunner } from '../src/pytest.js';
import { VitestRunner } from '../src/vitest.js';
import type { RunnerContext } from '../src/types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'qa-executor-'));
  // Make the temp project detectable by both JS runners.
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify({ devDependencies: { '@playwright/test': '^1.40.0', vitest: '^2.1.0' } }),
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const ctx = (overrides: Partial<RunnerContext> = {}): RunnerContext => ({
  root: tmp,
  environment: 'ci',
  policy: 'pre_merge',
  maxRetries: 1,
  dryRun: false,
  commit: 'c0ffee0',
  branch: 'main',
  ...overrides,
});

interface RecordedSpawn {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
}

function fakeSpawn(
  stdout: string,
  opts: { code?: number; timedOut?: boolean; stderr?: string } = {},
): { impl: SpawnImpl; calls: RecordedSpawn[] } {
  const calls: RecordedSpawn[] = [];
  const impl: SpawnImpl = async (command, args, options) => {
    calls.push({ command, args, env: options.env, cwd: options.cwd, timeoutMs: options.timeoutMs });
    return { code: opts.code ?? 0, stdout, stderr: opts.stderr ?? '', timedOut: opts.timedOut ?? false };
  };
  return { impl, calls };
}

function makeExecutorOptions(
  runners: RunExecutorOptions['runners'],
  spawnImpl: SpawnImpl,
  extra: Partial<RunExecutorOptions> = {},
): RunExecutorOptions {
  return { runners, evidenceRoot: join(tmp, 'evidence'), spawnImpl, ...extra };
}

const PLAYWRIGHT_JSON = JSON.stringify({
  suites: [
    {
      title: 'chromium',
      specs: [
        { title: 'passes fine', file: 'tests/x.spec.ts', tests: [{ results: [{ status: 'passed', duration: 10 }] }] },
        {
          title: 'breaks on checkout',
          file: 'tests/x.spec.ts',
          tests: [{ results: [{ status: 'failed', duration: 40, error: { message: 'Error: expected 200 to equal 500', stack: 'at x.spec.ts:3:1' } }] }],
        },
      ],
    },
  ],
});

describe('RunExecutor — happy path', () => {
  it('spawns the planned command, maps events, and writes evidence for failures', async () => {
    const { impl, calls } = fakeSpawn(PLAYWRIGHT_JSON);
    const executor = new RunExecutor(makeExecutorOptions([new PlaywrightRunner()], impl));
    const outcome = await executor.execute(ctx());

    expect(outcome.dryRun).toBe(false);
    expect(outcome.runnerIdsUsed).toEqual(['playwright']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'npx',
      args: ['playwright', 'test', '--reporter=json', '--retries=1'],
      cwd: tmp,
    });

    expect(outcome.events).toHaveLength(2);
    const [passed, failed] = outcome.events;
    expect(passed).toMatchObject({
      status: 'passed',
      testId: 'tests/x.spec.ts::passes fine',
      framework: 'playwright',
      environment: 'ci',
      commit: 'c0ffee0',
    });
    expect(failed).toMatchObject({ status: 'failed', testId: 'tests/x.spec.ts::breaks on checkout' });

    // All events share one runId.
    expect(new Set(outcome.events.map((e) => e.runId))).toEqual(new Set([outcome.runId]));

    // Evidence bundle for the failed test only.
    expect(outcome.bundles).toHaveLength(1);
    const bundle = outcome.bundles[0]!;
    expect(bundle.testId).toBe('tests/x.spec.ts::breaks on checkout');
    expect(existsSync(bundle.path)).toBe(true);
    expect(bundle.files).toEqual(expect.arrayContaining(['metadata.json', 'console.log', 'network.json', 'failure.md']));
    const consoleLog = readFileSync(join(bundle.path, 'console.log'), 'utf8');
    expect(consoleLog).toContain('expected 200 to equal 500');
  });

  it('scrubs secrets from captured console output in evidence', async () => {
    const leaky = JSON.stringify({
      suites: [
        {
          file: 'tests/secret.spec.ts',
          specs: [
            {
              title: 'prints a token',
              file: 'tests/secret.spec.ts',
              tests: [{ results: [{ status: 'failed', duration: 1, error: { message: 'Error: bad' } }] }],
            },
          ],
        },
      ],
    });
    const stdout = `${leaky}\napi_key: "supersecret123"`;
    const { impl } = fakeSpawn(stdout);
    const executor = new RunExecutor(makeExecutorOptions([new PlaywrightRunner()], impl));
    const outcome = await executor.execute(ctx());
    const consoleLog = readFileSync(join(outcome.bundles[0]!.path, 'console.log'), 'utf8');
    expect(consoleLog).not.toContain('supersecret123');
    expect(consoleLog).toContain('[REDACTED]');
  });

  it('uses file-reporting runners: pytest junit content comes from the artifact file', async () => {
    writeFileSync(join(tmp, 'conftest.py'), 'import pytest\n'); // make pytest detectable
    const { impl, calls } = fakeSpawn('pytest console noise (not junit)');
    const executor = new RunExecutor(makeExecutorOptions([new PytestRunner()], impl));
    // Simulate pytest having produced its junit file in the artifacts dir.
    const artifacts = join(tmp, 'evidence', 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(
      join(artifacts, 'pytest-junit.xml'),
      '<testsuite name="pytest" tests="1"><testcase name="test_ok" classname="tests/unit/test_ok.py" time="0.5"/></testsuite>',
    );
    const outcome = await executor.execute(ctx());
    expect(calls[0]!.args.join(' ')).toContain('--junitxml=');
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]).toMatchObject({ framework: 'pytest', status: 'passed', filePath: 'tests/unit/test_ok.py' });
  });
});

describe('RunExecutor — dry run', () => {
  it('never spawns, marks selected tests not_run, and records the plan', async () => {
    const { impl, calls } = fakeSpawn(PLAYWRIGHT_JSON);
    const executor = new RunExecutor(makeExecutorOptions([new PlaywrightRunner(), new VitestRunner()], impl));
    const selection = makeSelection([
      inventory('tests/x.spec.ts::passes fine'),
      inventory('tests/x.spec.ts::breaks on checkout'),
    ]);
    const outcome = await executor.execute(ctx({ dryRun: true }), selection);

    expect(calls).toHaveLength(0); // nothing spawned
    expect(outcome.dryRun).toBe(true);
    expect(outcome.bundles).toHaveLength(0);
    expect(outcome.runnerIdsUsed).toEqual(['playwright']);
    expect(outcome.events.map((e) => e.status)).toEqual(['not_run', 'not_run']);
    expect(outcome.events.every((e) => e.retryIndex === 0)).toBe(true);
    expect(outcome.events.every((e) => e.durationMs === 0)).toBe(true);

    const planPath = join(tmp, 'evidence', outcome.runId, 'plan.json');
    expect(existsSync(planPath)).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as { planned: Array<{ command: string; args: string[] }> };
    expect(plan.planned).toHaveLength(1);
    expect(plan.planned[0]!.args).toContain('--reporter=json');
  });

  it('dry run without a selection plans every detected runner and emits zero events', async () => {
    const { impl, calls } = fakeSpawn('');
    const executor = new RunExecutor(makeExecutorOptions([new PlaywrightRunner(), new VitestRunner()], impl));
    const outcome = await executor.execute(ctx({ dryRun: true }));
    expect(calls).toHaveLength(0);
    expect(outcome.events).toEqual([]);
    expect(outcome.runnerIdsUsed).toEqual(['playwright', 'vitest']);
  });
});

describe('RunExecutor — selection filtering', () => {
  it('executes only runners whose framework appears in the selection', async () => {
    const { impl, calls } = fakeSpawn(PLAYWRIGHT_JSON);
    const executor = new RunExecutor(makeExecutorOptions([new PlaywrightRunner(), new VitestRunner()], impl));
    // Selection contains only vitest tests → playwright must not run.
    const selection = makeSelection([inventory('tests/a.test.ts::a', 'vitest')]);
    const outcome = await executor.execute(ctx(), selection);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0]).toBe('vitest'); // the vitest command, not playwright
    expect(outcome.runnerIdsUsed).toEqual(['vitest']);
  });
});

describe('RunExecutor — timeouts & environment hygiene', () => {
  it('marks unfinished selected tests as timedout while finished tests keep their status', async () => {
    const { impl } = fakeSpawn(PLAYWRIGHT_JSON, { timedOut: true }); // partial output, then killed
    const executor = new RunExecutor(makeExecutorOptions([new PlaywrightRunner()], impl, { timeoutMs: 1234 }));
    const selection = makeSelection([
      inventory('tests/x.spec.ts::passes fine'),
      inventory('tests/y.spec.ts::never finished', 'playwright', 'tests/y.spec.ts'),
    ]);
    const outcome = await executor.execute(ctx(), selection);

    const finished = outcome.events.find((e) => e.testId === 'tests/x.spec.ts::passes fine');
    expect(finished).toMatchObject({ status: 'passed' });
    const timedOut = outcome.events.find((e) => e.testId === 'tests/y.spec.ts::never finished');
    expect(timedOut).toMatchObject({ status: 'timedout', durationMs: 1234 });
    expect(outcome.bundles.map((b) => b.testId)).toContain('tests/y.spec.ts::never finished');
  });

  it('emits one run-level timedout event without a selection', async () => {
    const { impl } = fakeSpawn('', { timedOut: true });
    const executor = new RunExecutor(makeExecutorOptions([new VitestRunner()], impl, { timeoutMs: 99 }));
    const outcome = await executor.execute(ctx());
    expect(outcome.events).toHaveLength(1);
    expect(outcome.events[0]).toMatchObject({ status: 'timedout', framework: 'vitest' });
    expect(outcome.bundles).toHaveLength(1); // timedout gets evidence too
  });

  it('passes an allowlisted environment — never the whole process.env', async () => {
    process.env['QA_EXECUTOR_TEST_MARKER'] = 'yes';
    process.env['CI_PIPELINE_ID'] = '42';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'do-not-leak';
    const { impl, calls } = fakeSpawn(PLAYWRIGHT_JSON);
    const executor = new RunExecutor(makeExecutorOptions([new PlaywrightRunner()], impl));
    try {
      await executor.execute(ctx());
      expect(calls).toHaveLength(1);
      const env = calls[0]!.env;
      expect(env['QA_EXECUTOR_TEST_MARKER']).toBe('yes');
      expect(env['CI_PIPELINE_ID']).toBe('42');
      expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
      expect(
        Object.keys(env).every(
          (k) =>
            ['PATH', 'HOME', 'LANG', 'TZ', 'CI', 'NODE_ENV'].includes(k) ||
            k.startsWith('CI_') ||
            k.startsWith('QA_'),
        ),
      ).toBe(true);
    } finally {
      delete process.env['QA_EXECUTOR_TEST_MARKER'];
      delete process.env['CI_PIPELINE_ID'];
      delete process.env['AWS_SECRET_ACCESS_KEY'];
    }
  });

  it('honors QA_RUN_TIMEOUT_MS when no explicit timeout is configured', async () => {
    process.env['QA_RUN_TIMEOUT_MS'] = '5555';
    const { impl, calls } = fakeSpawn(PLAYWRIGHT_JSON);
    const executor = new RunExecutor(makeExecutorOptions([new PlaywrightRunner()], impl));
    try {
      await executor.execute(ctx());
      expect(calls[0]!.timeoutMs).toBe(5555);
    } finally {
      delete process.env['QA_RUN_TIMEOUT_MS'];
    }
  });
});

describe('RunExecutor — learning loop', () => {
  it('records failures into the learning store with an explicit effect', async () => {
    const { impl } = fakeSpawn(PLAYWRIGHT_JSON);
    const learning: LearningStore = new RealLearningStore(join(tmp, 'learning.jsonl'));
    const executor = new RunExecutor(makeExecutorOptions([new PlaywrightRunner()], impl, { learning }));
    const outcome = await executor.execute(ctx());
    const records = learning.query({ type: 'failure' });
    expect(records).toHaveLength(1);
    const payload = records[0]!.payload as { runId: string; testIds: string[] };
    expect(payload.runId).toBe(outcome.runId);
    expect(payload.testIds).toEqual(['tests/x.spec.ts::breaks on checkout']);
    expect(records[0]!.effect).toContain('defect-history');
  });
});

// ---- helpers ----------------------------------------------------------------

function inventory(testId: string, framework = 'playwright', filePath = 'tests/x.spec.ts'): SelectedTest {
  return {
    test: {
      testId,
      name: testId.split('::')[1] ?? testId,
      filePath,
      layer: 'e2e',
      framework,
      covers: [],
    },
    priority: 'high',
    reasons: ['test'],
  };
}

function makeSelection(selected: SelectedTest[]): SelectionResult {
  return {
    selected,
    unaffected: [],
    routing: [],
    summary: 'test selection',
    label: 'INFERRED',
  };
}
