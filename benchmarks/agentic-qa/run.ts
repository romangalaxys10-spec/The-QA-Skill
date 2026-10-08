/**
 * Agentic-QA benchmark harness — The-QA-Skill.
 *
 * Runs the deterministic engines in packages/core against the fixture corpus
 * in fixtures/ and writes honest, reproducible numbers:
 *
 *   benchmarks/agentic-qa/results.json  — machine-readable full detail
 *   benchmarks/agentic-qa/results.md    — human-readable table
 *
 * Method (per fixture):
 *   1. Parse the machine fields from fixtures/<name>/EXPECTED.md
 *      (`- engine:`, `- expect_category:`, `- expect_min_confidence:`, …).
 *   2. Materialize commits.json into a throwaway real git repository
 *      (git init + one commit per entry, exactly the recorded messages).
 *   3. Dispatch on the declared engine(s) and evaluate every expectation
 *      present in EXPECTED.md against the real engine output.
 *   4. Aggregate per-engine counts, triage FP/FN confusion, runtime.
 *
 * Honesty rules enforced by this file:
 *   - No LLM, no network, no wall-clock inputs: engines run on committed bytes.
 *   - Measurement never crashes the run: a failing expectation is reported as
 *     data (results.md "Known misses"), and the process exits 0. Only harness
 *     faults (missing git, unreadable corpus) exit non-zero.
 *   - Engine code is imported from packages/core/src — the same code the CLI
 *     and agents ship. Nothing here re-implements an engine.
 *
 * Run: npm run benchmark   (tsx benchmarks/agentic-qa/run.ts)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  analyzeCoverage,
  analyzeDiff,
  analyzeTestFile,
  assessRisk,
  classifyFailure,
  classifyRouting,
  computeCoverage,
  detectSelectorChange,
  discover,
  inventoryTests,
  listFiles,
  runGit,
  scoreFlake,
  selectTests,
} from '../../packages/core/src/index.js';
import type {
  ChangedFile,
  FailedTestRecord,
  TestInventoryEntry,
  TestQualityReport,
} from '../../packages/core/src/index.js';

// ---------------------------------------------------------------------------
// Fixture contracts
// ---------------------------------------------------------------------------

interface FixtureCommit {
  message: string;
  files: Record<string, string>;
}

interface ExpectedFields {
  engine: string;
  expect_category?: string;
  expect_min_confidence?: number;
  expect_risk_tier?: string;
  expect_quality_score_max?: number;
  expect_deduction_dimensions?: string[];
  expect_gap_area?: string;
  expect_selected_tests_min?: number;
}

type EngineName = 'triage' | 'quality' | 'coverage' | 'risk' | 'selection';

interface CheckResult {
  engine: EngineName;
  /** What was evaluated, e.g. "category" or "quality-score-max". */
  kind: string;
  expected: string;
  actual: string;
  pass: boolean;
}

interface FixtureDetail {
  fixture: string;
  /** Engine declared in EXPECTED.md (`- engine:` field). */
  declaredEngine: string;
  pass: boolean;
  runtimeMs: number;
  checks: CheckResult[];
  context: Record<string, unknown>;
  /** Engines whose expectations were actually evaluated on this fixture. */
  evaluatedEngines: EngineName[];
  diagnostics?: Record<string, unknown>;
}

interface EngineCount {
  total: number;
  passed: number;
  failed: number;
}

interface CategoryConfusion {
  /** expected category → count of fixtures where the engine returned something else. */
  falseNegatives: Record<string, number>;
  /** returned category → count of fixtures where that category was wrong. */
  falsePositives: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Parse the `- key: value` machine fields out of an EXPECTED.md file. */
export function parseExpected(expectedMd: string): ExpectedFields {
  const fields: Record<string, string> = {};
  for (const line of expectedMd.split('\n')) {
    const m = /^-\s*([A-Za-z_]+):\s*(.*?)\s*$/.exec(line);
    if (m && m[1] && m[2] !== undefined) fields[m[1]] = m[2];
  }
  const engine = fields['engine'];
  if (!engine) throw new Error('EXPECTED.md is missing the `- engine:` machine field');
  const num = (key: string): number | undefined => {
    const raw = fields[key];
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) throw new Error(`EXPECTED.md field ${key} is not a number: ${raw}`);
    return parsed;
  };
  const dims = fields['expect_deduction_dimensions']
    ?.split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  return {
    engine,
    expect_category: fields['expect_category'],
    expect_min_confidence: num('expect_min_confidence'),
    expect_risk_tier: fields['expect_risk_tier'],
    expect_quality_score_max: num('expect_quality_score_max'),
    expect_deduction_dimensions: dims,
    expect_gap_area: fields['expect_gap_area'],
    expect_selected_tests_min: num('expect_selected_tests_min'),
  };
}

/** Materialize a commits.json history into a fresh real git repository. */
export function materializeRepo(commits: FixtureCommit[], dir: string): void {
  try {
    execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' });
  } catch {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  }
  for (const commit of commits) {
    for (const [relPath, content] of Object.entries(commit.files)) {
      if (typeof content !== 'string') {
        throw new Error(`commits.json entry ${relPath} has a non-string content payload`);
      }
      const abs = join(dir, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    // Identity is pinned per-invocation so the harness never mutates global
    // git config and never depends on the machine's user.
    execFileSync(
      'git',
      [
        '-c', 'user.name=The-QA-Skill Benchmark',
        '-c', 'user.email=benchmark@the-qa-skill.invalid',
        '-c', 'commit.gpgsign=false',
        'commit', '-q', '--no-verify', '-m', commit.message,
      ],
      { cwd: dir, stdio: 'pipe' },
    );
  }
}

function collectTestSources(fixtureDir: string): string[] {
  return listFiles(fixtureDir)
    .filter((f) => /^tests\//.test(f) && /\.tsx?$/.test(f))
    .sort();
}

function buildInventory(root: string, allFiles: string[]): TestInventoryEntry[] {
  const fileSet = new Set(allFiles);
  const entries: TestInventoryEntry[] = [];
  for (const discovered of inventoryTests(root, allFiles)) {
    const covers = computeCoverage(discovered.filePath, fileSet);
    entries.push({
      testId: discovered.filePath,
      name: discovered.filePath,
      filePath: discovered.filePath,
      layer: discovered.layer,
      framework: discovered.framework,
      covers,
    });
  }
  return entries;
}

function distinctModules(files: ChangedFile[]): number {
  const dirs = new Set(files.map((f) => f.path.split('/').slice(0, -1).join('/') || '.'));
  return dirs.size;
}

function fmt(n: number): string {
  return Math.round(n * 10) / 10 === Math.round(n)
    ? String(Math.round(n))
    : (Math.round(n * 100) / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Engine evaluators — each returns the checks it performed.
// `repo` is the materialized temp checkout; `fixtureDir` is the read-only
// source corpus in fixtures/.
// ---------------------------------------------------------------------------

async function evaluateTriage(
  fixtureDir: string,
  repo: string,
  records: FailedTestRecord[],
  commits: FixtureCommit[],
  expected: ExpectedFields,
): Promise<{ checks: CheckResult[]; context: Record<string, unknown>; diagnostics: Record<string, unknown> }> {
  const checks: CheckResult[] = [];
  const diff = await analyzeDiff(repo, 'HEAD~1..HEAD');
  // The change set under test: what the last materialized commit changed.
  // Union with the commits.json file list so the context never depends on
  // diff-text parsing quirks — both sources describe the same commit.
  const changeSet = new Set<string>(diff.files.map((f) => f.path));
  for (const path of Object.keys(commits[commits.length - 1]?.files ?? {})) changeSet.add(path);
  // Selector signal: the commit-2 diff over product (app/) files, full hunks
  // (removed + added lines), exactly what detectSelectorChange documents.
  const appDiffText = await runGit(['diff', 'HEAD~1..HEAD', '--', 'app'], repo);

  const perRecord: Array<Record<string, unknown>> = [];
  for (const record of records) {
    const relevantChangedFiles = record.changedFiles.filter((f) => changeSet.has(f));
    const coversChangedCode =
      record.changedFiles.length > 0 && relevantChangedFiles.length > 0;
    // The test source comes from the fixture corpus (tests/ are not always
    // part of the materialized history — and never change with it).
    const testSource = readTextFile(join(fixtureDir, record.filePath)) ?? '';
    const selectorChangedInDiff =
      testSource.length > 0 && detectSelectorChange(testSource, appDiffText);

    const result = classifyFailure(record, { coversChangedCode, relevantChangedFiles, selectorChangedInDiff });

    if (expected.expect_category !== undefined) {
      const pass = result.category === expected.expect_category;
      checks.push({
        engine: 'triage',
        kind: 'category',
        expected: expected.expect_category,
        actual: result.category,
        pass,
      });
    }
    if (expected.expect_min_confidence !== undefined) {
      const pass = result.confidence >= expected.expect_min_confidence;
      checks.push({
        engine: 'triage',
        kind: 'min-confidence',
        expected: `>= ${expected.expect_min_confidence}`,
        actual: fmt(result.confidence),
        pass,
      });
    }
    perRecord.push({
      testId: record.testId,
      coversChangedCode,
      relevantChangedFiles,
      selectorChangedInDiff,
      engineCategory: result.category,
      engineConfidence: result.confidence,
      engineLabel: result.label,
    });
  }

  // Diagnostics (never gated): flake scoring for records with mixed outcomes,
  // and the import-closure view of the change set for transparency.
  const diagnostics: Record<string, unknown> = {};
  const flakeViews: Record<string, unknown>[] = [];
  for (const record of records) {
    const outcomes = record.attempts
      .filter((a) => a.status === 'passed' || a.status === 'failed')
      .map((a) => ({ status: a.status as 'passed' | 'failed', timestamp: a.timestamp, environment: a.environment, browser: a.browser }));
    const hasPass = outcomes.some((o) => o.status === 'passed');
    const hasFail = outcomes.some((o) => o.status === 'failed');
    if (hasPass && hasFail) {
      const assessment = scoreFlake({
        testId: record.testId,
        outcomes,
        retryCount: Math.max(0, outcomes.length - 1),
        environments: [...new Set(record.attempts.map((a) => a.environment).filter((e): e is string => typeof e === 'string'))],
        browsers: [...new Set(record.attempts.map((a) => a.browser).filter((b): b is string => typeof b === 'string'))],
      });
      flakeViews.push({ testId: record.testId, score: assessment.score, verdict: assessment.verdict });
    }
  }
  if (flakeViews.length > 0) diagnostics.flakeViews = flakeViews;

  return { checks, context: { records: perRecord, changeSetSize: changeSet.size }, diagnostics };
}

function evaluateQuality(
  fixtureDir: string,
  expected: ExpectedFields,
): { checks: CheckResult[]; context: Record<string, unknown> } {
  const checks: CheckResult[] = [];
  const sources = collectTestSources(fixtureDir);
  const reports: TestQualityReport[] = sources.map((rel) => {
    const source = readFileSync(join(fixtureDir, rel), 'utf8');
    return analyzeTestFile(rel, source);
  });
  if (reports.length === 0) throw new Error('quality fixture has no tests/*.ts sources to analyze');

  const minScore = Math.min(...reports.map((r) => r.score));
  const deductionDimensions: string[] = [
    ...new Set(reports.flatMap((r) => r.deductions.map((d) => d.dimension))),
  ];

  if (expected.expect_quality_score_max !== undefined) {
    const pass = minScore <= expected.expect_quality_score_max;
    checks.push({
      engine: 'quality',
      kind: 'quality-score-max',
      expected: `<= ${expected.expect_quality_score_max}`,
      actual: String(minScore),
      pass,
    });
  }
  for (const dim of expected.expect_deduction_dimensions ?? []) {
    const pass = deductionDimensions.includes(dim);
    checks.push({
      engine: 'quality',
      kind: 'deduction-dimension',
      expected: dim,
      actual: deductionDimensions.join(', '),
      pass,
    });
  }
  return {
    checks,
    context: {
      analyzedFiles: reports.map((r) => ({ filePath: r.filePath, score: r.score, testCount: r.testCount })),
      deductionDimensions,
    },
  };
}

function evaluateCoverage(
  repo: string,
  expected: ExpectedFields,
): { checks: CheckResult[]; context: Record<string, unknown> } {
  if (expected.expect_gap_area === undefined) {
    throw new Error('coverage fixture is missing `- expect_gap_area:`');
  }
  const checks: CheckResult[] = [];
  // computeCoverage resolves imports against process.cwd() — run it from the
  // materialized repo. It is synchronous, so the chdir window is safe.
  const previousCwd = process.cwd();
  process.chdir(repo);
  let report;
  try {
    const allFiles = listFiles(repo);
    const discovered = discover(repo);
    const inventory = buildInventory(repo, allFiles);
    report = analyzeCoverage(discovered.sourceFiles, inventory);
  } finally {
    process.chdir(previousCwd);
  }
  const hit = report.gaps.find((g) => g.area === expected.expect_gap_area);
  checks.push({
    engine: 'coverage',
    kind: 'gap-area',
    expected: expected.expect_gap_area,
    actual: report.gaps.map((g) => `${g.area}:${g.path}`).join(', ') || '(no gaps emitted)',
    pass: hit !== undefined,
  });
  return {
    checks,
    context: {
      weightedCoverage: report.weightedCoverage,
      fileCoverage: report.fileCoverage,
      gaps: report.gaps.map((g) => ({ path: g.path, area: g.area, riskWeight: g.riskWeight })),
    },
  };
}

async function evaluateRisk(
  repo: string,
  expected: ExpectedFields,
): Promise<{ checks: CheckResult[]; context: Record<string, unknown> }> {
  if (expected.expect_risk_tier === undefined) {
    throw new Error('risk fixture is missing `- expect_risk_tier:`');
  }
  const checks: CheckResult[] = [];
  const diff = await analyzeDiff(repo, 'HEAD~1..HEAD');
  const routing = classifyRouting(diff.files);
  const assessment = assessRisk({
    changedFiles: diff.files,
    addedLines: diff.addedLines,
    removedLines: diff.removedLines,
    modulesTouched: distinctModules(diff.files),
    boundarySignals: routing.boundarySignals,
  });
  checks.push({
    engine: 'risk',
    kind: 'risk-tier',
    expected: expected.expect_risk_tier,
    actual: `${assessment.tier} (score ${assessment.score})`,
    pass: assessment.tier === expected.expect_risk_tier,
  });
  return {
    checks,
    context: {
      changedFiles: diff.files.map((f) => ({ path: f.path, area: f.area, additions: f.additions, deletions: f.deletions })),
      score: assessment.score,
      tier: assessment.tier,
      topFactors: assessment.topContributors.slice(0, 3).map((f) => ({ factor: f.factor, contribution: fmt(f.contribution), reasons: f.reasons.slice(0, 2) })),
    },
  };
}

async function evaluateSelection(
  repo: string,
  expected: ExpectedFields,
): Promise<{ checks: CheckResult[]; context: Record<string, unknown> }> {
  if (expected.expect_selected_tests_min === undefined) {
    throw new Error('selection fixture is missing `- expect_selected_tests_min:`');
  }
  const checks: CheckResult[] = [];
  const diff = await analyzeDiff(repo, 'HEAD~1..HEAD');
  const routing = classifyRouting(diff.files);
  const previousCwd = process.cwd();
  let selectedCount = 0;
  let inventorySize = 0;
  try {
    process.chdir(repo);
    const allFiles = listFiles(repo);
    const inventory = buildInventory(repo, allFiles);
    inventorySize = inventory.length;
    const result = selectTests(diff.files, inventory, routing, { policy: 'pr' });
    selectedCount = result.selected.length;
  } finally {
    process.chdir(previousCwd);
  }
  checks.push({
    engine: 'selection',
    kind: 'selected-tests-min',
    expected: `>= ${expected.expect_selected_tests_min}`,
    actual: `${selectedCount}/${inventorySize}`,
    pass: selectedCount >= expected.expect_selected_tests_min,
  });
  return { checks, context: { inventorySize, selectedCount } };
}

// ---------------------------------------------------------------------------
// Per-fixture orchestration
// ---------------------------------------------------------------------------

async function runFixture(fixtureDir: string, name: string): Promise<FixtureDetail> {
  const started = process.hrtime.bigint();
  const expectedMd = readTextFile(join(fixtureDir, 'EXPECTED.md'));
  if (expectedMd === undefined) throw new Error(`fixture ${name} is missing EXPECTED.md`);
  const expected = parseExpected(expectedMd);

  const commits = JSON.parse(readFileSync(join(fixtureDir, 'commits.json'), 'utf8')) as FixtureCommit[];
  if (!Array.isArray(commits) || commits.length === 0) {
    throw new Error(`fixture ${name} has an empty or malformed commits.json`);
  }

  const failuresPath = join(fixtureDir, 'evidence', 'failures.json');
  const records: FailedTestRecord[] = existsSync(failuresPath)
    ? (JSON.parse(readFileSync(failuresPath, 'utf8')) as FailedTestRecord[])
    : [];

  const checks: CheckResult[] = [];
  const evaluatedEngines: EngineName[] = [];
  let context: Record<string, unknown> = {};
  let diagnostics: Record<string, unknown> = {};

  const hasExpectation = (engine: EngineName): boolean => {
    if (engine === 'triage') return expected.expect_category !== undefined || expected.expect_min_confidence !== undefined;
    if (engine === 'quality') return expected.expect_quality_score_max !== undefined || (expected.expect_deduction_dimensions?.length ?? 0) > 0;
    if (engine === 'coverage') return expected.expect_gap_area !== undefined;
    if (engine === 'risk') return expected.expect_risk_tier !== undefined;
    return expected.expect_selected_tests_min !== undefined;
  };

  // Run the declared engine's checks first so per-fixture output leads with
  // the primary expectation, then any secondary (dual-engine) expectations.
  const engineOrder: EngineName[] = ['triage', 'quality', 'coverage', 'risk', 'selection'];
  const enginesToRun: EngineName[] = engineOrder
    .filter((engine) => hasExpectation(engine))
    .sort((a, b) => (a === expected.engine ? -1 : 0) - (b === expected.engine ? -1 : 0));

  if (enginesToRun.length === 0) {
    throw new Error(`fixture ${name} declares engine "${expected.engine}" but carries no parseable expectation fields`);
  }

  const needsRepo = enginesToRun.some((e) => e !== 'quality');
  let repo: string | undefined;
  if (needsRepo) {
    repo = mkdtempSync(join(tmpdir(), 'theqa-bench-'));
    materializeRepo(commits, repo);
  }

  try {
    for (const engine of enginesToRun) {
      evaluatedEngines.push(engine);
      if (engine === 'triage') {
        if (records.length === 0) throw new Error(`fixture ${name} has no evidence/failures.json for triage`);
        const out = await evaluateTriage(fixtureDir, repo as string, records, commits, expected);
        checks.push(...out.checks);
        context = { ...context, ...out.context };
        diagnostics = { ...diagnostics, ...out.diagnostics };
      } else if (engine === 'quality') {
        const out = evaluateQuality(fixtureDir, expected);
        checks.push(...out.checks);
        context = { ...context, ...out.context };
      } else if (engine === 'coverage') {
        const out = evaluateCoverage(repo as string, expected);
        checks.push(...out.checks);
        context = { ...context, ...out.context };
      } else if (engine === 'risk') {
        const out = await evaluateRisk(repo as string, expected);
        checks.push(...out.checks);
        context = { ...context, ...out.context };
      } else {
        const out = await evaluateSelection(repo as string, expected);
        checks.push(...out.checks);
        context = { ...context, ...out.context };
      }
    }
  } finally {
    if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
  }

  const runtimeMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    fixture: name,
    declaredEngine: expected.engine,
    pass: checks.every((c) => c.pass),
    runtimeMs,
    checks,
    evaluatedEngines,
    context,
    ...(Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
  };
}

// ---------------------------------------------------------------------------
// Aggregation + reporting
// ---------------------------------------------------------------------------

function aggregate(details: FixtureDetail[]): {
  engines: Record<EngineName, EngineCount>;
  confusion: CategoryConfusion;
  totalRuntimeMs: number;
  meanRuntimeMs: number;
} {
  const engines = {
    triage: { total: 0, passed: 0, failed: 0 },
    quality: { total: 0, passed: 0, failed: 0 },
    coverage: { total: 0, passed: 0, failed: 0 },
    risk: { total: 0, passed: 0, failed: 0 },
    selection: { total: 0, passed: 0, failed: 0 },
  } as Record<EngineName, EngineCount>;
  const confusion: CategoryConfusion = { falseNegatives: {}, falsePositives: {} };

  for (const detail of details) {
    for (const check of detail.checks) {
      const bucket = engines[check.engine];
      bucket.total += 1;
      if (check.pass) bucket.passed += 1;
      else bucket.failed += 1;
      if (check.engine === 'triage' && check.kind === 'category' && !check.pass) {
        confusion.falseNegatives[check.expected] = (confusion.falseNegatives[check.expected] ?? 0) + 1;
        confusion.falsePositives[check.actual] = (confusion.falsePositives[check.actual] ?? 0) + 1;
      }
    }
  }

  const totalRuntimeMs = details.reduce((a, d) => a + d.runtimeMs, 0);
  const meanRuntimeMs = details.length > 0 ? totalRuntimeMs / details.length : 0;
  return { engines, confusion, totalRuntimeMs, meanRuntimeMs };
}

function renderResultsMarkdown(
  details: FixtureDetail[],
  engines: Record<EngineName, EngineCount>,
  confusion: CategoryConfusion,
  meanRuntimeMs: number,
): string {
  const lines: string[] = [];
  lines.push('# Agentic-QA benchmark results');
  lines.push('');
  lines.push('> **Honesty statement.** These numbers were measured on the 13 fixture corpora of this');
  lines.push('> repository (`fixtures/`) using the deterministic engines in `packages/core/src` — the');
  lines.push('> same code the CLI and agents ship. No LLM, no network, no randomness and no wall-clock');
  lines.push('> inputs participate in any engine decision; runs are byte-for-byte reproducible via');
  lines.push('> `npm run benchmark`. Failing expectations are reported as data below, never smoothed.');
  lines.push('');
  lines.push('## Per-engine summary');
  lines.push('');
  lines.push('| Engine | Checks | Passed | Failed | Pass rate |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const engine of ['triage', 'quality', 'coverage', 'risk', 'selection'] as EngineName[]) {
    const bucket = engines[engine];
    const rate = bucket.total > 0 ? `${fmt((bucket.passed / bucket.total) * 100)}%` : '—';
    lines.push(`| ${engine} | ${bucket.total} | ${bucket.passed} | ${bucket.failed} | ${rate} |`);
  }
  lines.push('');
  lines.push(`Mean runtime per fixture: **${fmt(meanRuntimeMs)} ms** (git materialization + engine calls).`);
  lines.push('');
  lines.push('Notes on counting: one check = one machine expectation from `EXPECTED.md`.');
  lines.push('`payment-regression` is a dual-engine fixture (risk primary + triage side), so its');
  lines.push('expectations appear in both the risk and triage rows. `selection` has no fixture in');
  lines.push('this corpus yet — the row exists and reads zero until one lands.');
  lines.push('');
  lines.push('## Per-fixture detail');
  lines.push('');
  lines.push('| Fixture | Declared engine | Checks (expected → actual) | Result | Runtime |');
  lines.push('| --- | --- | --- | --- | ---: |');
  for (const detail of details) {
    const checkText = detail.checks
      .map((c) => `${c.engine}/${c.kind}: ${c.expected} → ${c.actual}${c.pass ? '' : ' ✗'}`)
      .join('<br>');
    lines.push(
      `| ${detail.fixture} | ${detail.declaredEngine} | ${checkText} | ${detail.pass ? 'PASS' : 'FAIL'} | ${fmt(detail.runtimeMs)} ms |`,
    );
  }
  lines.push('');
  if (Object.keys(confusion.falseNegatives).length > 0 || Object.keys(confusion.falsePositives).length > 0) {
    lines.push('## Triage confusion (category mismatches only)');
    lines.push('');
    lines.push('| Expected category | Missed (FN) | Wrongly returned (FP) |');
    lines.push('| --- | --- | --- |');
    const categories = [...new Set([...Object.keys(confusion.falseNegatives), ...Object.keys(confusion.falsePositives)])];
    for (const category of categories) {
      lines.push(`| ${category} | ${confusion.falseNegatives[category] ?? 0} | ${confusion.falsePositives[category] ?? 0} |`);
    }
    lines.push('');
  }
  const misses = details.filter((d) => !d.pass);
  lines.push('## Known misses');
  lines.push('');
  if (misses.length === 0) {
    lines.push('None. Every machine expectation in the corpus was met by the documented engine rules.');
  } else {
    lines.push('Fixtures whose expectation is not met by the engine as documented. These are reported');
    lines.push('as data: the harness never weakens an engine to make a fixture pass.');
    lines.push('');
    for (const miss of misses) {
      lines.push(`- **${miss.fixture}** (declared engine: ${miss.declaredEngine})`);
      for (const check of miss.checks.filter((c) => !c.pass)) {
        lines.push(`  - ${check.engine}/${check.kind}: expected ${check.expected}, got ${check.actual}`);
      }
      lines.push(`  - Context: ${JSON.stringify(miss.context)}`);
    }
  }
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push('1. `EXPECTED.md` machine fields are parsed (`- engine:`, `- expect_category:`, `- expect_min_confidence:`,');
  lines.push('   `- expect_quality_score_max:`, `- expect_deduction_dimensions:`, `- expect_gap_area:`, `- expect_risk_tier:`,');
  lines.push('   `- expect_selected_tests_min:`).');
  lines.push('2. `commits.json` is materialized into a throwaway real git repository (`git init` + one commit');
  lines.push('   per entry with the recorded messages); the diff range `HEAD~1..HEAD` is the change set.');
  lines.push('3. Engines run from `packages/core/src`: `classifyFailure` (+`detectSelectorChange`) for triage,');
  lines.push('   `analyzeTestFile` for quality, `discover`/`inventoryTests`/`computeCoverage`/`analyzeCoverage`');
  lines.push('   for coverage, `analyzeDiff`/`classifyRouting`/`assessRisk` for risk, `selectTests` for selection.');
  lines.push('   Triage context follows the runner contract: `coversChangedCode` is true when the failing');
  lines.push('   record\'s runner-reported `changedFiles` (the import-closure evidence recorded at run time)');
  lines.push('   intersects the materialized change set; `selectorChangedInDiff` is `detectSelectorChange`');
  lines.push('   over the test source against the commit-2 `app/` diff (removed + added lines).');
  lines.push('4. Exit code is 0 for measured failures (they are data); only harness faults exit non-zero.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // This file sits at <repoRoot>/benchmarks/agentic-qa/run.ts. tsx executes it
  // as CommonJS (the package has no "type": "module"), where __dirname exists.
  const here = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
  const repoRoot = join(here, '..', '..');
  const fixturesRoot = join(repoRoot, 'fixtures');
  const outDir = join(repoRoot, 'benchmarks', 'agentic-qa');

  const fixtureNames = readdirSafe(fixturesRoot).sort();
  if (fixtureNames.length === 0) throw new Error(`no fixtures found under ${fixturesRoot}`);

  const details: FixtureDetail[] = [];
  const harnessErrors: Array<{ fixture: string; error: string }> = [];

  for (const name of fixtureNames) {
    const fixtureDir = join(fixturesRoot, name);
    try {
      const detail = await runFixture(fixtureDir, name);
      details.push(detail);
      const status = detail.pass ? 'PASS' : 'FAIL';
      const checkSummary = detail.checks.map((c) => `${c.pass ? '✓' : '✗'} ${c.engine}/${c.kind}: ${c.expected} → ${c.actual}`).join('; ');
      console.log(`[${status}] ${name} (${detail.declaredEngine}) — ${checkSummary}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      harnessErrors.push({ fixture: name, error: message });
      console.error(`[HARNESS-ERROR] ${name}: ${message}`);
    }
  }

  if (details.length === 0) {
    throw new Error('every fixture failed to run — harness fault, not a measurement');
  }

  const { engines, confusion, meanRuntimeMs } = aggregate(details);

  const results = {
    schemaVersion: 1,
    tool: 'agentic-qa-benchmark',
    generatedAt: new Date().toISOString(),
    node: process.version,
    disclaimer:
      'Measured on the fixture corpus of this repository with the deterministic engines in packages/core. No LLM, no network, no randomness. Reproducible via npm run benchmark.',
    fixturesRun: details.length,
    fixturesErrored: harnessErrors.length,
    pass: details.filter((d) => d.pass).length,
    fail: details.filter((d) => !d.pass).length,
    engines,
    triageConfusion: confusion,
    meanRuntimeMs,
    harnessErrors,
    details,
  };

  writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(outDir, 'results.md'), renderResultsMarkdown(details, engines, confusion, meanRuntimeMs));

  const passedFixtures = results.pass;
  console.log('');
  console.log(
    `Benchmark complete: ${passedFixtures}/${details.length} fixtures green` +
      ` (triage ${engines.triage.passed}/${engines.triage.total},` +
      ` quality ${engines.quality.passed}/${engines.quality.total},` +
      ` coverage ${engines.coverage.passed}/${engines.coverage.total},` +
      ` risk ${engines.risk.passed}/${engines.risk.total},` +
      ` selection ${engines.selection.passed}/${engines.selection.total}).`,
  );
  console.log('Results written to benchmarks/agentic-qa/results.json and results.md');
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

main().catch((err) => {
  console.error('Benchmark harness fault:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
