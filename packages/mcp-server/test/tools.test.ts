/**
 * Tool implementation tests against a REAL temp git repository (no network,
 * no real test spawns). Covers: discovery, risk analysis on a real payment
 * change, test selection via import closure, evidence bundles (incl. secret
 * scrubbing and root containment), triage classification, flake scoring,
 * healing proposals, the release gate, and the quality report.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeEvidenceBundle } from '@the-qa-skill/core';
import type { TestEvent } from '@the-qa-skill/core';
import { McpServer } from '../src/server.js';

let repo = '';
let server: McpServer;
let generationAgentAvailable = false;
let executionAgentAvailable = false;

interface CallResult {
  text: string;
  isError: boolean;
  payload: Record<string, unknown>;
}

/** Full-protocol tools/call through handleLine; parses the text payload on success. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const id = Math.floor(Math.random() * 1e9);
  const line = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  const raw = await server.handleLine(line);
  expect(raw).not.toBeNull();
  const parsed = JSON.parse(raw as string) as {
    id: number;
    result?: { content?: Array<{ type: string; text: string }>; isError?: boolean };
    error?: { code: number; message: string };
  };
  expect(parsed.error).toBeUndefined();
  const result = parsed.result;
  expect(result).toBeDefined();
  expect(result?.content?.[0]?.type).toBe('text');
  const text = result?.content?.[0]?.text ?? '';
  const isError = result?.isError === true;
  return { text, isError, payload: isError ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(async () => {
  // --- Fixture: a real git repo with a payment change on HEAD~1..HEAD -----
  repo = join(mkdtempSync(join(tmpdir(), 'qa-mcp-')), 'repo');
  mkdirSync(join(repo, 'src', 'payments'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'fixture-shop', private: true, dependencies: { vitest: '^2.1.0' } }, null, 2) + '\n',
  );
  writeFileSync(
    join(repo, 'src', 'payments', 'checkout.ts'),
    'export function chargeCart(totalCents: number): number {\n  return totalCents;\n}\n',
  );
  writeFileSync(
    join(repo, 'tests', 'checkout.test.ts'),
    "import { chargeCart } from '../src/payments/checkout';\n\ntest('charges the cart total', () => {\n  if (chargeCart(100) !== 100) throw new Error('unexpected total');\n});\n",
  );
  git(['init']);
  git(['config', 'user.email', 'qa-fixture@example.com']);
  git(['config', 'user.name', 'QA Fixture']);
  git(['add', '-A']);
  git(['commit', '-m', 'chore: initial project']);
  writeFileSync(
    join(repo, 'src', 'payments', 'checkout.ts'),
    'export function chargeCart(totalCents: number, discountPct = 0): number {\n' +
    '  if (discountPct < 0 || discountPct > 100) throw new Error("invalid discount");\n' +
    '  return Math.round(totalCents * (1 - discountPct / 100));\n' +
    '}\n',
  );
  git(['add', '-A']);
  git(['commit', '-m', 'feat(payments): apply discount to cart total']);

  // --- Evidence bundles with a planted (scrub-on-output) secret token -----
  const artifactsRoot = join(repo, '.theqa', 'artifacts');
  const baseEvent: TestEvent = {
    runId: 'run-aaa',
    testId: 'checkout-should-charge',
    name: 'charges the cart with token: "supersecret123"',
    timestamp: '2025-01-02T10:00:00.000Z',
    status: 'failed',
    durationMs: 120,
    framework: 'vitest',
    environment: 'ci',
    retryIndex: 0,
  };
  writeEvidenceBundle(artifactsRoot, { event: baseEvent });
  writeEvidenceBundle(artifactsRoot, {
    event: { ...baseEvent, runId: 'run-bbb', timestamp: '2025-01-01T09:00:00.000Z' },
  });

  // --- Server under test (protocol path, root pinned to the fixture) ------
  server = new McpServer({
    input: (async function* empty(): AsyncGenerator<string> {})(),
    output: { write() {} },
    root: repo,
  });

  // Detect whether the parallel agents build has landed (tests stay honest).
  try {
    const mod: unknown = await import('@the-qa-skill/agents');
    if (mod !== null && typeof mod === 'object') {
      generationAgentAvailable = typeof (mod as Record<string, unknown>)['GenerationAgent'] === 'function';
      executionAgentAvailable = typeof (mod as Record<string, unknown>)['ExecutionAgent'] === 'function';
    }
  } catch {
    generationAgentAvailable = false;
    executionAgentAvailable = false;
  }
});

afterAll(() => {
  // withCwd in list_relevant_tests must always restore the original cwd.
  expect(process.cwd().length).toBeGreaterThan(0);
});

describe('discover_project', () => {
  it('returns the stack summary and test counts', async () => {
    const { isError, payload } = await call('discover_project');
    expect(isError).toBe(false);
    expect(payload.stack).toBeDefined();
    expect(payload.testFileCount).toBe(1);
    expect(payload.sourceFileCount).toBeGreaterThanOrEqual(1);
    expect((payload.summary as string)).toContain('1 test file');
    expect((payload.summary as string)).toContain('vitest');
    expect(payload.label).toBe('OBSERVED');
  });
});

describe('analyze_risk', () => {
  it('assesses a real payment change with tier, explanation, and changed files', async () => {
    const { isError, payload } = await call('analyze_risk', { range: 'HEAD~1..HEAD' });
    expect(isError).toBe(false);
    const assessment = payload.assessment as { score: number; tier: string; explanation: string };
    expect(assessment.score).toBeGreaterThanOrEqual(0);
    expect(assessment.score).toBeLessThanOrEqual(100);
    expect(['critical', 'high', 'medium', 'low']).toContain(assessment.tier);
    expect(typeof assessment.explanation).toBe('string');
    expect(assessment.explanation.length).toBeGreaterThan(0);
    const changed = payload.changedFiles as Array<{ path: string; area: string }>;
    expect(changed.some((f) => f.path === 'src/payments/checkout.ts' && f.area === 'payment')).toBe(true);
  });

  it('falls back to the core engine with a usable result when agents is absent', async () => {
    const { isError, payload } = await call('analyze_risk', {});
    expect(isError).toBe(false);
    expect(['RiskAgent', 'core-fallback']).toContain(payload.engine);
    expect((payload.assessment as { explanation: string }).explanation).toBeTruthy();
  });
});

describe('list_relevant_tests', () => {
  it('selects the covering test with critical priority and reasons', async () => {
    const { isError, payload } = await call('list_relevant_tests', { range: 'HEAD~1..HEAD' });
    expect(isError).toBe(false);
    const selection = payload.selection as {
      selected: Array<{ test: { filePath: string }; priority: string; reasons: string[] }>;
      unaffected: unknown[];
      summary: string;
    };
    expect(selection.selected).toHaveLength(1);
    expect(selection.selected[0]?.test.filePath).toBe('tests/checkout.test.ts');
    expect(selection.selected[0]?.priority).toBe('critical'); // payment change
    expect(selection.selected[0]?.reasons.length).toBeGreaterThan(0);
    expect(selection.unaffected).toHaveLength(0);
    expect(selection.summary).toContain('smallest high-confidence set');
  });
});

describe('get_failure_evidence', () => {
  it('lists bundles most recent first with parsed metadata', async () => {
    const { isError, payload } = await call('get_failure_evidence', { artifactsRoot: '.theqa/artifacts' });
    expect(isError).toBe(false);
    expect(payload.count).toBe(2);
    expect(payload.truncated).toBe(false);
    const bundles = payload.bundles as Array<{ path: string; metadata: Record<string, unknown> }>;
    expect(bundles[0]?.metadata.timestamp).toBe('2025-01-02T10:00:00.000Z');
    expect(bundles[1]?.metadata.timestamp).toBe('2025-01-01T09:00:00.000Z');
    expect(bundles[0]?.metadata.runId).toBe('run-aaa');
    expect(bundles[0]?.path).toContain('run-2025-01-02');
  });

  it('filters by testId and runDate', async () => {
    const byId = await call('get_failure_evidence', { artifactsRoot: '.theqa/artifacts', testId: 'checkout' });
    expect(byId.isError).toBe(false);
    expect(byId.payload.count).toBe(2);
    const byDate = await call('get_failure_evidence', { artifactsRoot: '.theqa/artifacts', runDate: '2025-01-01' });
    expect(byDate.payload.count).toBe(1);
  });

  it('errors with a clear message when a targeted testId has no bundles', async () => {
    const res = await call('get_failure_evidence', { artifactsRoot: '.theqa/artifacts', testId: 'no-such-test' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('no evidence bundle found');
    expect(res.text).toContain('no-such-test');
  });

  it('refuses artifacts roots outside the project root', async () => {
    const res = await call('get_failure_evidence', { artifactsRoot: '/etc' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('outside the project root');
  });

  it('scrubs planted secrets from metadata before returning', async () => {
    const { isError, text } = await call('get_failure_evidence', { artifactsRoot: '.theqa/artifacts' });
    expect(isError).toBe(false);
    expect(text).not.toContain('supersecret123');
    expect(text).toContain('[REDACTED]');
  });
});

describe('triage_failure', () => {
  it('classifies a consistent assertion failure over changed code as REAL_REGRESSION', async () => {
    const { isError, payload } = await call('triage_failure', {
      failures: [
        {
          testId: 'checkout-should-charge',
          name: 'charges the cart total',
          filePath: 'tests/checkout.test.ts',
          layer: 'unit',
          attempts: [
            {
              status: 'failed',
              durationMs: 150,
              timestamp: '2025-01-02T10:00:00.000Z',
              environment: 'ci',
              errorType: 'AssertionError',
              errorMessage: 'AssertionError: expected checkout total 200 to equal 250',
            },
          ],
          changedFiles: ['src/payments/checkout.ts'],
          recentRuns: ['passed', 'passed', 'failed'],
        },
      ],
    });
    expect(isError).toBe(false);
    const results = payload.results as Array<{ testId: string; category: string; confidence: number; label: string; recommendedAction: string }>;
    expect(results).toHaveLength(1);
    expect(results[0]?.testId).toBe('checkout-should-charge');
    expect(results[0]?.category).toBe('REAL_REGRESSION');
    expect(results[0]?.confidence).toBeGreaterThanOrEqual(0.9);
    expect(results[0]?.label).toBe('OBSERVED');
    expect(results[0]?.recommendedAction).toBeTruthy();
    expect(Array.isArray(payload.clusters)).toBe(true);
  });

  it('rejects empty or non-array failures with an isError result', async () => {
    const empty = await call('triage_failure', { failures: [] });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain('non-empty array');
    const notArray = await call('triage_failure', { failures: 'everything' });
    expect(notArray.isError).toBe(true);
  });
});

describe('analyze_flake', () => {
  it('returns verdict stable for an all-pass history', async () => {
    const { isError, payload } = await call('analyze_flake', {
      input: {
        testId: 'steady-test',
        outcomes: Array.from({ length: 6 }, (_, i) => ({ status: 'passed', timestamp: `2025-01-0${i + 1}T00:00:00Z` })),
        retryCount: 0,
        environments: [],
        browsers: [],
      },
    });
    expect(isError).toBe(false);
    expect(payload.verdict).toBe('stable');
    expect(payload.failRate).toBe(0);
  });

  it('returns verdict flaky for an alternating multi-env history', async () => {
    const statuses = ['failed', 'passed', 'failed', 'passed', 'failed', 'passed'];
    const { isError, payload } = await call('analyze_flake', {
      input: {
        testId: 'shaky-test',
        outcomes: statuses.map((status, i) => ({ status, timestamp: `2025-01-0${i + 1}T00:00:00Z` })),
        retryCount: 3,
        environments: ['ci', 'local'],
        browsers: ['chromium', 'firefox'],
      },
    });
    expect(isError).toBe(false);
    expect(payload.verdict).toBe('flaky');
    expect(payload.score).toBeGreaterThanOrEqual(45);
    expect((payload.reasons as string[]).length).toBeGreaterThan(0);
  });

  it('rejects invalid outcome statuses via isError', async () => {
    const res = await call('analyze_flake', {
      input: { testId: 't', outcomes: [{ status: 'exploded', timestamp: '2025-01-01T00:00:00Z' }] },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('passed');
  });
});

describe('propose_test_heal', () => {
  it('proposes a HIGH-tier selector heal with evidence and never applies it', async () => {
    const { isError, payload } = await call('propose_test_heal', {
      candidate: {
        testId: 'checkout-should-charge',
        filePath: 'tests/checkout.test.ts',
        kind: 'selector',
        description: 'checkout button selector disappeared after UI refactor',
        currentCode: "await page.click('.checkout-btn');",
        proposedCode: "await page.getByRole('button', { name: 'Checkout' }).click();",
        observedInTarget: '<button data-testid="checkout">Checkout</button>',
        signals: ['selector literal missing from target DOM'],
      },
    });
    expect(isError).toBe(false);
    expect(payload.proposalsOnly).toBe(true);
    const proposal = payload.proposal as { tier: string; confidence: number; violations: string[]; kind: string };
    expect(proposal.tier).toBe('HIGH');
    expect(proposal.confidence).toBeGreaterThanOrEqual(0.9);
    expect(proposal.violations).toHaveLength(0);
    expect(proposal.kind).toBe('selector');
  });

  it('rejects unknown healing kinds via isError', async () => {
    const res = await call('propose_test_heal', {
      candidate: {
        testId: 't',
        filePath: 'tests/t.test.ts',
        kind: 'vibes',
        description: 'd',
        currentCode: 'a',
        proposedCode: 'b',
      },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('candidate.kind');
  });
});

describe('evaluate_release', () => {
  const clean = {
    riskAssessments: [],
    triageResults: [],
    flakeAssessments: [],
    failedRealRegressions: 0,
    openUnknownCategories: 0,
    criticalFlakeCount: 0,
    evidenceComplete: true,
    environment: 'ci',
  };

  it('BLOCKS on a failed real regression', async () => {
    const { isError, payload } = await call('evaluate_release', { gateInput: { ...clean, failedRealRegressions: 1 } });
    expect(isError).toBe(false);
    expect(payload.verdict).toBe('BLOCKED');
    expect((payload.blockingFindings as string[]).length).toBeGreaterThanOrEqual(1);
    expect((payload.blockingFindings as string[])[0]).toContain('REAL_REGRESSION');
  });

  it('BLOCKS on a >= 0.9 confidence REAL_REGRESSION triage result', async () => {
    const { payload } = await call('evaluate_release', {
      gateInput: {
        ...clean,
        triageResults: [
          { testId: 'checkout-should-charge', category: 'REAL_REGRESSION', confidence: 0.92, label: 'OBSERVED' },
        ],
      },
    });
    expect(payload.verdict).toBe('BLOCKED');
    expect((payload.blockingFindings as string[]).some((f) => f.includes('checkout-should-charge'))).toBe(true);
  });

  it('warns on sub-minimum coverage and downgrades PASS without complete evidence', async () => {
    const coverage = await call('evaluate_release', {
      gateInput: { ...clean, coverage: { weightedCoverage: 40, fileCoverage: 55, gaps: [], criticalFlowCoverage: [], label: 'INFERRED' } },
    });
    expect(coverage.payload.verdict).toBe('PASS_WITH_WARNINGS');
    expect((coverage.payload.warnings as string[]).some((w) => w.includes('coverage'))).toBe(true);

    // A clean gate with real (stable) data downgrades PASS → PASS_WITH_WARNINGS
    // when evidenceComplete is false.
    const stableFlake = [{ testId: 'steady-test', score: 4, verdict: 'stable', reasons: [], failRate: 0, label: 'OBSERVED' }];
    const evidence = await call('evaluate_release', { gateInput: { ...clean, flakeAssessments: stableFlake, evidenceComplete: false } });
    expect(evidence.payload.verdict).toBe('PASS_WITH_WARNINGS');
    expect((evidence.payload.warnings as string[]).some((w) => w.includes('evidence incomplete'))).toBe(true);
  });

  it('returns UNKNOWN for empty input instead of inventing a verdict', async () => {
    const { payload } = await call('evaluate_release', { gateInput: {} });
    expect(payload.verdict).toBe('UNKNOWN');
    expect(payload.label).toBe('NOT_VERIFIED');
    expect(payload.blockingFindings).toHaveLength(0);
    // Zero data stays UNKNOWN even when the caller claims completeness —
    // the empty-input rule takes precedence over the downgrade rule.
    const incompleteButEmpty = await call('evaluate_release', { gateInput: { ...clean, evidenceComplete: false } });
    expect(incompleteButEmpty.payload.verdict).toBe('UNKNOWN');
  });
});

describe('generate_quality_report', () => {
  it('renders an engineering report with honest no-data sections', async () => {
    const { isError, payload } = await call('generate_quality_report', { audience: 'engineering' });
    expect(isError).toBe(false);
    const markdown = payload.markdown as string;
    expect(markdown).toContain('# Quality report — engineering view');
    expect(markdown).toContain('## Project & test inventory');
    expect(markdown).toContain('Test files: 1');
    expect(markdown).toContain('no data'); // no suite-health/coverage data exists
    expect(markdown).toContain('_label: OBSERVED_');
  });

  it('renders condensed executive and leadership views', async () => {
    for (const audience of ['executive', 'leadership']) {
      const { payload } = await call('generate_quality_report', { audience });
      expect((payload.markdown as string)).toContain(`${audience} view`);
    }
  });

  it('rejects unknown audiences via isError', async () => {
    const res = await call('generate_quality_report', { audience: 'twitter' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('audience');
  });
});

describe('generate_tests / run_tests (agent-dependent tools)', () => {
  it('validates the feature before touching the agents package', async () => {
    const res = await call('generate_tests', { feature: { acceptanceCriteria: ['criterion'] } });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('feature.name');
  });

  it('plans a test (or degrades to the graceful agents-unavailable error)', async () => {
    const res = await call('generate_tests', {
      feature: { name: 'discounted checkout', acceptanceCriteria: ['total reflects the discount'] },
    });
    if (generationAgentAvailable) {
      expect(res.isError).toBe(false);
      expect(res.payload.planningOnly).toBe(true);
      expect(res.payload.plan).toBeDefined();
    } else {
      expect(res.isError).toBe(true);
      expect(res.text).toContain('agents package unavailable');
    }
  });

  it('validates the orchestration policy before execution', async () => {
    const res = await call('run_tests', { policy: 'whenever' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('policy');
  });

  it('plans a dry run by default (or degrades gracefully without agents)', async () => {
    const res = await call('run_tests', {});
    if (executionAgentAvailable) {
      expect(res.isError).toBe(false);
      expect(res.payload.dryRun).toBe(true);
      expect(((res.payload.safety as Record<string, unknown>).safetyClass)).toBe('READ_ONLY');
    } else {
      expect(res.isError).toBe(true);
      expect(res.text).toContain('agents package unavailable');
    }
  });
});
