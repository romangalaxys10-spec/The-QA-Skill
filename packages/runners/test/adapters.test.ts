import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunnerContext } from '../src/types.js';
import { AppiumRunner, mapCapabilities } from '../src/appium.js';
import { JestRunner } from '../src/jest.js';
import { K6Runner } from '../src/k6.js';
import { PlaywrightRunner } from '../src/playwright.js';
import { PytestRunner, pytestFilePathFromClassName, pytestLayerFromClassName } from '../src/pytest.js';
import { VitestRunner } from '../src/vitest.js';
import { ZAPRunner } from '../src/zap.js';

const CLEANUPS: string[] = [];

function makeProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'qa-runners-'));
  CLEANUPS.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

afterEach(() => {
  while (CLEANUPS.length > 0) {
    const dir = CLEANUPS.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const ctx = (root: string, overrides: Partial<RunnerContext> = {}): RunnerContext => ({
  root,
  environment: 'ci',
  policy: 'pr',
  maxRetries: 1,
  dryRun: false,
  ...overrides,
});

describe('playwright adapter', () => {
  it('detects @playwright/test in devDependencies and via config file', () => {
    const runner = new PlaywrightRunner();
    expect(runner.detect(makeProject({ 'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '^1.40.0' } }) }))).toBe(true);
    expect(runner.detect(makeProject({ 'playwright.config.ts': 'export default {};' }))).toBe(true);
    expect(runner.detect(makeProject({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }) }))).toBe(false);
  });

  it('builds the npx playwright test --reporter=json command with retries when allowed', () => {
    const runner = new PlaywrightRunner();
    const noRetries = runner.buildCommand(ctx('/p', { maxRetries: 0 }));
    expect(noRetries).toEqual({ command: 'npx', args: ['playwright', 'test', '--reporter=json'], reporterHint: 'json' });
    const withRetries = runner.buildCommand(ctx('/p', { maxRetries: 2 }));
    expect(withRetries.args).toContain('--retries=2');
  });

  it('maps statuses including timedOut and per-attempt results', () => {
    const runner = new PlaywrightRunner();
    const raw = JSON.stringify({
      suites: [
        {
          title: 'chromium',
          suites: [
            {
              title: 'login.spec',
              file: 'tests/login.spec.ts',
              specs: [
                {
                  title: 'user logs in',
                  file: 'tests/login.spec.ts',
                  tests: [
                    {
                      results: [
                        { status: 'failed', duration: 120, error: { message: 'Error: expect(received).toBe(1)', stack: 'at login.spec.ts:9:5' } },
                        { status: 'passed', duration: 90 },
                      ],
                    },
                  ],
                },
                { title: 'slow request times out', file: 'tests/login.spec.ts', tests: [{ results: [{ status: 'timedOut', duration: 30000 }] }] },
                { title: 'auth experiment', file: 'tests/login.spec.ts', tests: [{ results: [{ status: 'skipped', duration: 0 }] }] },
                { title: 'interrupted run', file: 'tests/login.spec.ts', tests: [{ results: [{ status: 'interrupted', duration: 10 }] }] },
              ],
            },
          ],
        },
      ],
    });
    const events = runner.parseOutput(raw, ctx('/p'));
    expect(events).toHaveLength(5);
    const first = events[0]!;
    expect(first.status).toBe('failed');
    expect(first.testId).toBe('tests/login.spec.ts::user logs in');
    expect(first.retryIndex).toBe(0);
    expect(first.errorType).toBe('Error');
    expect(events[1]).toMatchObject({ status: 'passed', retryIndex: 1, durationMs: 90 });
    expect(events[2]).toMatchObject({ status: 'timedout' });
    expect(events[3]).toMatchObject({ status: 'skipped' });
    expect(events[4]).toMatchObject({ status: 'skipped' });
    expect(events.every((e) => e.framework === 'playwright')).toBe(true);
  });

  it('honors explicit `retry #N` name annotations for retryIndex', () => {
    const runner = new PlaywrightRunner();
    const raw = JSON.stringify({
      suites: [{ file: 'tests/re.spec.ts', specs: [{ title: 'checkout (retry #2)', file: 'tests/re.spec.ts', tests: [{ results: [{ status: 'failed', duration: 5 }] }] }] }],
    });
    const events = runner.parseOutput(raw, ctx('/p'));
    expect(events[0]!.retryIndex).toBe(2);
  });

  it('emits one synthetic event for top-level suite errors', () => {
    const runner = new PlaywrightRunner();
    const raw = JSON.stringify({ suites: [], errors: [{ message: 'Internal error: browser crashed' }, 'plain string error'] });
    const events = runner.parseOutput(raw, ctx('/p'));
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.status === 'failed')).toBe(true);
    expect(events[0]!.errorMessage).toBe('Internal error: browser crashed');
  });

  it('returns [] for unparseable output instead of throwing', () => {
    expect(new PlaywrightRunner().parseOutput('total garbage', ctx('/p'))).toEqual([]);
  });
});

describe('vitest & jest adapters', () => {
  it('detects vitest via dependency and config file', () => {
    const runner = new VitestRunner();
    expect(runner.detect(makeProject({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^2.1.0' } }) }))).toBe(true);
    expect(runner.detect(makeProject({ 'vitest.config.ts': 'export default {};' }))).toBe(true);
    expect(runner.detect(makeProject())).toBe(false);
  });

  it('detects jest via dependency and config file', () => {
    const runner = new JestRunner();
    expect(runner.detect(makeProject({ 'package.json': JSON.stringify({ devDependencies: { jest: '^29.0.0' } }) }))).toBe(true);
    expect(runner.detect(makeProject({ 'jest.config.js': 'module.exports = {};' }))).toBe(true);
  });

  it('builds the right commands', () => {
    expect(new VitestRunner().buildCommand(ctx('/p', { maxRetries: 0 }))).toEqual({
      command: 'npx',
      args: ['vitest', 'run', '--reporter=json'],
      reporterHint: 'json',
    });
    expect(new VitestRunner().buildCommand(ctx('/p', { maxRetries: 3 })).args).toContain('--retry=3');
    expect(new JestRunner().buildCommand(ctx('/p'))).toEqual({ command: 'npx', args: ['jest', '--json'], reporterHint: 'json' });
  });

  it.each([
    ['vitest', new VitestRunner()],
    ['jest', new JestRunner()],
  ])('parses the jest-style JSON summary (%s)', (framework, runner) => {
    const raw = JSON.stringify({
      numTotalTests: 3,
      testResults: [
        {
          name: '/repo/tests/orders.test.ts',
          assertionResults: [
            { fullName: 'orders computes totals', status: 'passed', duration: 4 },
            {
              fullName: 'orders rejects negative quantities',
              status: 'failed',
              duration: 7,
              failureMessages: ['AssertionError: expected -5 to be rejected', '    at orders.test.ts:22:3'],
            },
            { fullName: 'orders legacy mode', status: 'pending', duration: 0 },
          ],
        },
      ],
    });
    const events = runner.parseOutput(raw, ctx('/repo'));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      framework,
      status: 'passed',
      testId: 'tests/orders.test.ts::orders computes totals',
      durationMs: 4,
    });
    expect(events[1]).toMatchObject({ status: 'failed', errorType: 'AssertionError', retryIndex: 0 });
    expect(events[1]!.errorMessage).toBe('AssertionError: expected -5 to be rejected');
    expect(events[2]).toMatchObject({ status: 'skipped' });
  });
});

describe('pytest adapter', () => {
  it('detects pytest via marker files and requirements content', () => {
    const runner = new PytestRunner();
    expect(runner.detect(makeProject({ 'pytest.ini': '[pytest]\naddopts = -q' }))).toBe(true);
    expect(runner.detect(makeProject({ 'conftest.py': 'import pytest' }))).toBe(true);
    expect(runner.detect(makeProject({ 'requirements.txt': 'pytest==8.0.0\nrequests\n' }))).toBe(true);
    expect(runner.detect(makeProject({ 'requirements.txt': 'requests\nflask\n' }))).toBe(false);
  });

  it('builds the python -m pytest command pointing at the artifacts dir', () => {
    const runner = new PytestRunner();
    const cmd = runner.buildCommand(ctx('/p'), { artifactsDir: '/tmp/art' });
    expect(cmd).toEqual({
      command: 'python',
      args: ['-m', 'pytest', `--junitxml=${join('/tmp/art', 'pytest-junit.xml')}`, '-q'],
      reporterHint: 'junit-file',
    });
  });

  it('reads the produced junit file as its result source', () => {
    const root = makeProject({ 'conftest.py': '' });
    const runner = new PytestRunner();
    const artifacts = join(root, '.theqa', 'artifacts');
    expect(runner.readResult!(ctx(root), artifacts)).toBeNull();
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'pytest-junit.xml'), '<testsuite name="pytest" tests="1"><testcase name="t1" classname="tests.unit.test_x" time="0.2"/></testsuite>');
    const raw = runner.readResult!(ctx(root), artifacts);
    expect(raw).toContain('test_x');
    const events = runner.parseOutput(raw!, ctx(root));
    expect(events[0]).toMatchObject({
      framework: 'pytest',
      filePath: 'tests/unit/test_x.py',
      status: 'passed',
      durationMs: 200,
    });
  });

  it('parses junit content passed as raw and maps failures', () => {
    const runner = new PytestRunner();
    const junit = `<testsuites><testsuite name="pytest" tests="2" failures="1" time="1.0">
  <testcase name="test_ok" classname="tests/api/test_health.py" time="0.1"/>
  <testcase name="test_breaks" classname="tests/e2e/test_checkout.py" time="0.9">
    <failure message="assert 500 == 200" type="AssertionError">traceback here</failure>
  </testcase>
</testsuite></testsuites>`;
    const events = runner.parseOutput(junit, ctx('/p'));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ status: 'passed', filePath: 'tests/api/test_health.py' });
    expect(events[1]).toMatchObject({ status: 'failed', errorType: 'AssertionError', errorStack: 'traceback here' });
  });

  it('classifies layers from classnames and normalizes dotted modules', () => {
    expect(pytestLayerFromClassName('tests/e2e/test_buy')).toBe('e2e');
    expect(pytestLayerFromClassName('tests/integration/test_x')).toBe('integration');
    expect(pytestLayerFromClassName('tests/api/test_y')).toBe('api');
    expect(pytestLayerFromClassName('tests/unit/test_z')).toBe('unit');
    expect(pytestFilePathFromClassName('tests.unit.test_orders')).toBe('tests/unit/test_orders.py');
    expect(pytestFilePathFromClassName('')).toBe('pytest/unknown.py');
  });
});

describe('k6 adapter', () => {
  it('detects k6 scripts and config', () => {
    const runner = new K6Runner();
    expect(runner.detect(makeProject({ 'k6/smoke.k6.js': 'export const options = { thresholds: {} };' }))).toBe(true);
    expect(runner.detect(makeProject({ 'perf/load.js': 'http.get("https://x");' }))).toBe(true);
    expect(runner.detect(makeProject({ 'src/index.js': 'console.log(1);' }))).toBe(false);
  });

  it('builds the k6 run command with summary export and a detected script', () => {
    const root = makeProject({ 'k6/smoke.k6.js': 'export default function() {}' });
    const runner = new K6Runner();
    const cmd = runner.buildCommand(ctx(root), { artifactsDir: '/tmp/art' });
    expect(cmd.command).toBe('k6');
    expect(cmd.args).toEqual(['run', `--summary-export=${join('/tmp/art', 'k6-summary.json')}`, 'k6/smoke.k6.js']);
  });

  it('throws an honest error when no script exists and none was provided', () => {
    const runner = new K6Runner();
    expect(() => runner.buildCommand(ctx('/nonexistent-root-xyz'), { artifactsDir: '/tmp/art' })).toThrow(/opts\.script/);
  });

  it('synthesizes events from thresholds, top-level threshold map, and checks', () => {
    const runner = new K6Runner();
    const summary = JSON.stringify({
      metrics: {
        checks: { type: 'rate', values: { rate: 0.9 }, thresholds: [{ ok: false }] },
        http_req_duration: { type: 'trend', values: { avg: 120, 'p(95)': 300 } },
        http_req_failed: { type: 'rate', values: { rate: 0.01 }, thresholds: [{ ok: true }] },
        data_received: { type: 'counter', values: { count: 123 } },
      },
      thresholds: { data_received: { ok: true } },
      root_group: {
        name: '',
        path: '',
        checks: [{ name: 'top check', path: '::top check', passes: 5, fails: 0 }],
        groups: [
          {
            name: 'auth',
            path: '::auth',
            checks: [{ name: 'status is 200', path: '::auth::status is 200', passes: 90, fails: 10 }],
          },
        ],
      },
    });
    const events = runner.parseOutput(summary, ctx('/p'));
    const byName = new Map(events.map((e) => [e.name, e]));
    expect(events).toHaveLength(6);
    expect(byName.get('[k6] threshold: checks')).toMatchObject({ status: 'failed', errorType: 'threshold' });
    expect(byName.get('[k6] metric: http_req_duration')).toMatchObject({ status: 'passed' });
    expect(byName.get('[k6] threshold: http_req_failed')).toMatchObject({ status: 'passed' });
    expect(byName.get('[k6] threshold: data_received')).toMatchObject({ status: 'passed' });
    expect(byName.get('[k6] check: ::top check')).toMatchObject({ status: 'passed' });
    expect(byName.get('[k6] check: ::auth::status is 200')).toMatchObject({ status: 'failed' });
    expect(events.every((e) => e.framework === 'k6' && e.durationMs === 0)).toBe(true);
  });
});

describe('zap adapter', () => {
  it('detects zap configuration files', () => {
    const runner = new ZAPRunner();
    expect(runner.detect(makeProject({ 'zap-baseline.yaml': 'target: https://x' }))).toBe(true);
    expect(runner.detect(makeProject({ '.zap/rules.json': '{}' }))).toBe(true);
    expect(runner.detect(makeProject({ 'src/app.ts': '' }))).toBe(false);
  });

  it('builds a plan-only scan plan and never executes', () => {
    const runner = new ZAPRunner();
    const plan = runner.buildPlan('https://staging.example.com', { activeScan: false, policies: ['baseline', 'api-scan'] });
    expect(plan).toMatchObject({
      target: 'https://staging.example.com',
      policies: ['baseline', 'api-scan'],
      activeScan: false,
      spider: true,
      mode: 'plan-only',
    });
    expect(plan.note).toContain('never runs live scans');
    const cmd = runner.buildCommand(ctx('/p'));
    expect(cmd.command).toBe('echo');
  });

  it('parses ZAP alerts into failed events prefixed [ZAP]', () => {
    const runner = new ZAPRunner();
    const alerts = JSON.stringify({
      site: [
        {
          '@name': 'https://example.com',
          alerts: [
            {
              name: 'Content Security Policy Header Not Set',
              riskcode: '2',
              url: 'https://example.com/login',
              description: 'No CSP header',
              solution: 'Add CSP',
            },
            { name: 'Cookie Without Secure Flag', riskcode: '1', url: 'https://example.com/app', description: 'insecure cookie' },
          ],
        },
      ],
    });
    const events = runner.parseOutput(alerts, ctx('/p'));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      framework: 'zap',
      status: 'failed',
      name: '[ZAP] Content Security Policy Header Not Set',
      filePath: 'https://example.com/login',
      errorType: 'riskcode=2',
    });
    expect(events[0]!.failureCategory).toBeUndefined(); // security findings are triaged separately
    expect(events[1]).toMatchObject({ name: '[ZAP] Cookie Without Secure Flag', errorType: 'riskcode=1' });
  });
});

describe('appium adapter', () => {
  it('maps neutral capabilities onto W3C appium: namespaced caps', () => {
    expect(
      mapCapabilities({
        platformName: 'Android',
        deviceName: 'Pixel 7',
        platformVersion: '14',
        app: '/builds/app.apk',
        automationName: 'UiAutomator2',
        extra: { autoGrantPermissions: true },
      }),
    ).toEqual({
      platformName: 'Android',
      'appium:deviceName': 'Pixel 7',
      'appium:platformVersion': '14',
      'appium:app': '/builds/app.apk',
      'appium:automationName': 'UiAutomator2',
      'appium:autoGrantPermissions': true,
    });
  });

  it('detects appium via wdio config or dependency and builds the wdio command', () => {
    const runner = new AppiumRunner();
    expect(runner.detect(makeProject({ 'wdio.conf.js': 'exports.config = {};' }))).toBe(true);
    expect(runner.detect(makeProject({ 'package.json': JSON.stringify({ devDependencies: { appium: '^2.0.0' } }) }))).toBe(true);
    expect(runner.buildCommand(ctx('/p'))).toEqual({ command: 'npx', args: ['wdio', 'run', 'wdio.conf.js'], reporterHint: 'junit-stdout' });
  });

  it('parses wdio junit output and carries the device identity', () => {
    const runner = new AppiumRunner();
    const junit = `<testsuite name="mobile" tests="1" failures="1">
  <testcase name="login on Pixel 7" classname="specs/android/login.spec.js" time="3.2">
    <failure message="element not found" type="NoSuchElementError">at login.spec.js:14</failure>
  </testcase>
</testsuite>`;
    const events = runner.parseOutput(junit, ctx('/p', { browser: 'Pixel 7' }));
    expect(events[0]).toMatchObject({
      framework: 'appium',
      status: 'failed',
      filePath: 'specs/android/login.spec.js',
      device: 'Pixel 7',
      errorType: 'NoSuchElementError',
      durationMs: 3200,
    });
  });
});
