import { describe, expect, it } from 'vitest';
import { configSchema, ConfigError, loadConfig, renderDefaultConfig } from '../src/config.js';
import { buildContext, parseContext, serializeContext, withRisk, ContextValidationError } from '../src/context.js';
import { analyzeCoverage } from '../src/coverage/analyze.js';
import { scrubSecrets, writeEvidenceBundle, evidenceBundleLayout, runIdFor } from '../src/evidence/bundle.js';
import { LearningStore } from '../src/learning/store.js';
import { detectStack, inventoryTests } from '../src/discovery/stack.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestEvent } from '../src/types.js';

describe('config', () => {
  it('validates and applies defaults', () => {
    const cfg = configSchema.parse({ schemaVersion: 1, project: { name: 'demo' } });
    expect(cfg.risk.thresholds.critical).toBe(80);
    expect(cfg.execution.maxRetries).toBe(1);
  });

  it('rejects unknown schema versions and bad weights', () => {
    expect(() => configSchema.parse({ schemaVersion: 2, project: { name: 'x' } })).toThrow();
    expect(() => configSchema.parse({ schemaVersion: 1, project: { name: 'x', }, risk: { weights: { businessCriticality: 7 } } })).toThrow();
  });

  it('gives readable issues on invalid files', () => {
    try {
      throw new ConfigError(['project.name: required']);
    } catch (e) {
      expect((e as ConfigError).issues).toContain('project.name: required');
      expect((e as Error).message).toMatch(/Invalid theqa\.config\.json/);
    }
  });

  it('renders a loadable default config for qa init', () => {
    const text = renderDefaultConfig('fresh-project');
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe('QA context model', () => {
  const base = {
    generatedAt: '2026-10-07T00:00:00Z',
    root: '/repo',
    application: { type: 'web', language: 'typescript' },
  };

  it('builds with defaults and rejects bad risk scores', () => {
    const ctx = buildContext(base);
    expect(ctx.schemaVersion).toBe(1);
    expect(ctx.qualityGates.minWeightedCoverage).toBe(60);
    expect(() => buildContext({ ...base, risk: { overall: 250, tier: 'critical', areas: [] } })).toThrow(ContextValidationError);
  });

  it('round-trips through JSON unchanged', () => {
    const ctx = withRisk(buildContext(base), {
      score: 42, tier: 'medium', factors: [], topContributors: [], explanation: 'x', label: 'INFERRED',
    });
    expect(parseContext(serializeContext(ctx))).toEqual(ctx);
  });
});

describe('business-risk-aware coverage', () => {
  it('weights payment/auth files above docs and surfaces critical gaps', () => {
    const report = analyzeCoverage(
      ['src/payments/charge.ts', 'src/utils/slug.ts', 'README.md', 'tests/x.test.ts'],
      [{ testId: 't1', name: 'x', filePath: 'tests/x.test.ts', layer: 'unit', framework: 'vitest', covers: ['src/payments/charge.ts'] }],
      [{ name: 'checkout flow', patterns: ['payments'] }],
    );
    expect(report.weightedCoverage).toBeGreaterThan(0);
    const slugGap = report.gaps.find((g) => g.path === 'src/utils/slug.ts');
    expect(slugGap).toBeUndefined(); // low-weight gap, not surfaced
    expect(report.criticalFlowCoverage[0]?.covered).toBe(true);
  });

  it('reports uncovered critical flows explicitly', () => {
    const report = analyzeCoverage(
      ['src/payments/refund.ts'],
      [],
      [{ name: 'refund flow', patterns: ['payments'] }],
    );
    expect(report.criticalFlowCoverage[0]?.covered).toBe(false);
    expect(report.gaps[0]?.reason).toMatch(/highest-priority|security-critical|integrity/);
  });
});

describe('evidence bundles', () => {
  it('scrubs secrets before anything touches disk', () => {
    const dirty = 'Authorization: Bearer ghp_vo0123456789abcdefghijklmnop plus api_key: "super-secret-123"';
    const clean = scrubSecrets(dirty);
    expect(clean).not.toMatch(/ghp_/);
    expect(clean).not.toContain('super-secret-123');
    expect(clean).toContain('[REDACTED');
  });

  it('writes the documented bundle layout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tqa-ev-'));
    try {
      const event: TestEvent = {
        runId: runIdFor(), testId: 'tests/auth.spec.ts::login', name: 'login works',
        timestamp: '2026-10-07T10:00:00Z', status: 'failed', durationMs: 1234,
        framework: 'playwright', environment: 'ci', browser: 'chromium',
        commit: 'abc1234', branch: 'main', retryIndex: 0,
        errorType: 'AssertionError', errorMessage: 'expected 401 to equal 200',
      };
      const bundle = writeEvidenceBundle(dir, {
        event,
        consoleLog: 'GET /api/session api_key: "abcd1234efgh"',
        network: [{ url: '/api/session', status: 401 }],
        failureNarrative: 'custom narrative',
      });
      expect(bundle.files).toEqual(expect.arrayContaining(['metadata.json', 'console.log', 'network.json', 'failure.md']));
      expect(bundle.path).toContain('run-2026-10-07');
      expect(bundle.path).toContain('auth.spec.ts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('layout helper is path-safe for exotic test ids', () => {
    const event = { timestamp: '2026-10-07T10:00:00Z', testId: 'a/b c::d<>e' } as TestEvent;
    const layout = evidenceBundleLayout('/art', event);
    expect(layout).not.toMatch(/[<>:]/);
    expect(layout).toContain('run-2026-10-07');
  });
});

describe('learning loop', () => {
  it('appends, queries, and explains effects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tqa-lrn-'));
    try {
      const store = new LearningStore(join(dir, '.theqa', 'learning.jsonl'));
      store.append({ type: 'failure', tags: ['auth'], payload: { paths: ['src/auth/session.ts'] }, effect: 'risk boost for src/auth/session.ts' });
      store.append({ type: 'healing_rejected', tags: ['auth'], payload: { testId: 't9' }, effect: 'healing for t9 requires human review' });
      const failures = store.query({ type: 'failure' });
      expect(failures).toHaveLength(1);
      expect(failures[0]?.effect).toMatch(/risk boost/);
      expect(store.failureDensityByPath()['src/auth/session.ts']).toBe(1);
      expect(store.rejectedHealingsFor('t9')).toHaveLength(1);
      expect(store.summarize()).toMatch(/2 records/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('discovery', () => {
  it('detects a node/test project and inventories its tests', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tqa-disc-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'tests'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { vitest: '^2', '@playwright/test': '^1' } }));
      writeFileSync(join(dir, 'tsconfig.json'), '{}');
      writeFileSync(join(dir, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
      writeFileSync(join(dir, 'tests', 'math.test.ts'), `test('add', () => { expect(1).toBe(1); });\n`);
      writeFileSync(join(dir, 'tests', 'login.spec.ts'), `import { test } from '@playwright/test';\ntest('login', async () => {});\ntest('logout', async () => {});\n`);

      const stack = detectStack(dir);
      expect(stack.language).toBe('typescript');
      expect(stack.testFrameworks).toEqual(expect.arrayContaining(['vitest', 'playwright']));

      const tests = inventoryTests(dir);
      const math = tests.find((t) => t.filePath === 'tests/math.test.ts');
      const login = tests.find((t) => t.filePath === 'tests/login.spec.ts');
      expect(math?.framework).toBe('vitest'); // *.test.ts → vitest pattern
      expect(login?.framework).toBe('playwright');
      expect(login?.estimatedCases).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
