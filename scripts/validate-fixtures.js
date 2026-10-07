#!/usr/bin/env node
/**
 * Fixture corpus validator for The-QA-Skill.
 *
 * Verifies that every fixture under fixtures/ is structurally complete and
 * that its EXPECTED.md machine fields are well-formed against the documented
 * engine vocabulary. This is a *structure* check only — it does not run the
 * engines and produces no quality metrics (that is benchmarks/agentic-qa's
 * job, via `npm run benchmark`).
 *
 * Usage: node scripts/validate-fixtures.js
 * Exit codes: 0 = corpus valid; 1 = structural problems found.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'fixtures');

// Documented vocabularies (packages/core/src/types.ts).
const ENGINES = ['triage', 'quality', 'coverage', 'risk', 'selection'];
const FAILURE_CATEGORIES = new Set([
  'REAL_REGRESSION', 'TEST_DEFECT', 'TEST_DATA_DEFECT', 'ENVIRONMENT_FAILURE',
  'NETWORK_FAILURE', 'DEPENDENCY_FAILURE', 'FLAKE', 'TIMING_FAILURE',
  'SELECTOR_FAILURE', 'ASSERTION_FAILURE', 'CONFIGURATION_FAILURE', 'UNKNOWN',
]);
const QUALITY_DIMENSIONS = new Set([
  'correctness', 'determinism', 'isolation', 'assertionStrength',
  'behaviorCoverage', 'negativeCoverage', 'boundaryCoverage', 'maintainability',
  'readability', 'runtime', 'duplication', 'mockQuality', 'dataQuality',
  'security', 'accessibility', 'observability', 'evidenceQuality',
]);
const CHANGE_AREAS = new Set(['ui', 'api', 'db', 'auth', 'payment', 'config', 'test', 'docs', 'infra', 'unknown']);
const RISK_TIERS = new Set(['critical', 'high', 'medium', 'low']);
const EXECUTION_STATUSES = new Set(['passed', 'failed', 'skipped', 'timedout', 'not_run']);
const RUN_STATUSES = new Set(['passed', 'failed', 'skipped']);

const problems = [];

function fail(fixture, message) {
  problems.push(`[${fixture}] ${message}`);
}

function expectFields(md) {
  const fields = {};
  for (const line of md.split('\n')) {
    const m = /^-\s*([A-Za-z_]+):\s*(.*?)\s*$/.exec(line);
    if (m) fields[m[1]] = m[2];
  }
  return fields;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function validateAttempt(fixture, recordId, attempt, index) {
  if (!attempt || typeof attempt !== 'object') {
    fail(fixture, `${recordId} attempt[${index}] is not an object`);
    return;
  }
  if (!EXECUTION_STATUSES.has(attempt.status)) {
    fail(fixture, `${recordId} attempt[${index}].status "${attempt.status}" is not an ExecutionStatus`);
  }
  if (typeof attempt.durationMs !== 'number') {
    fail(fixture, `${recordId} attempt[${index}].durationMs must be a number`);
  }
  if (!isNonEmptyString(attempt.timestamp)) {
    fail(fixture, `${recordId} attempt[${index}].timestamp must be a non-empty string`);
  }
  if (!isNonEmptyString(attempt.environment)) {
    fail(fixture, `${recordId} attempt[${index}].environment must be a non-empty string`);
  }
}

function validateFailures(fixture, fixtureDir) {
  const failuresPath = path.join(fixtureDir, 'evidence', 'failures.json');
  if (!fs.existsSync(failuresPath)) {
    fail(fixture, 'missing evidence/failures.json');
    return;
  }
  let records;
  try {
    records = JSON.parse(fs.readFileSync(failuresPath, 'utf8'));
  } catch (err) {
    fail(fixture, `evidence/failures.json is not valid JSON: ${err.message}`);
    return;
  }
  if (!Array.isArray(records) || records.length === 0) {
    fail(fixture, 'evidence/failures.json must be a non-empty array of FailedTestRecord');
    return;
  }
  for (const record of records) {
    const id = record && typeof record.testId === 'string' ? record.testId : '<missing testId>';
    for (const key of ['testId', 'name', 'filePath', 'layer']) {
      if (!isNonEmptyString(record[key])) fail(fixture, `${id} .${key} must be a non-empty string`);
    }
    if (!Array.isArray(record.attempts) || record.attempts.length === 0) {
      fail(fixture, `${id} .attempts must be a non-empty array`);
    } else {
      record.attempts.forEach((attempt, i) => validateAttempt(fixture, id, attempt, i));
    }
    if (!Array.isArray(record.changedFiles) || record.changedFiles.some((f) => !isNonEmptyString(f))) {
      fail(fixture, `${id} .changedFiles must be an array of strings`);
    }
    if (!Array.isArray(record.recentRuns) || record.recentRuns.some((s) => !RUN_STATUSES.has(s))) {
      fail(fixture, `${id} .recentRuns must contain only 'passed' | 'failed' | 'skipped'`);
    }
    // The failing test source should exist in the fixture when it points into tests/.
    if (typeof record.filePath === 'string' && record.filePath.startsWith('tests/')) {
      if (!fs.existsSync(path.join(fixtureDir, record.filePath))) {
        fail(fixture, `${id} .filePath "${record.filePath}" does not exist in the fixture`);
      }
    }
  }
}

function validateCommits(fixture, fixtureDir) {
  const commitsPath = path.join(fixtureDir, 'commits.json');
  if (!fs.existsSync(commitsPath)) {
    fail(fixture, 'missing commits.json');
    return;
  }
  let commits;
  try {
    commits = JSON.parse(fs.readFileSync(commitsPath, 'utf8'));
  } catch (err) {
    fail(fixture, `commits.json is not valid JSON: ${err.message}`);
    return;
  }
  if (!Array.isArray(commits) || commits.length === 0) {
    fail(fixture, 'commits.json must be a non-empty array of { message, files }');
    return;
  }
  commits.forEach((commit, i) => {
    if (!commit || typeof commit !== 'object') {
      fail(fixture, `commits[${i}] is not an object`);
      return;
    }
    if (!isNonEmptyString(commit.message)) fail(fixture, `commits[${i}].message must be a non-empty string`);
    if (!commit.files || typeof commit.files !== 'object' || Array.isArray(commit.files)) {
      fail(fixture, `commits[${i}].files must be an object of path -> content`);
      return;
    }
    const keys = Object.keys(commit.files);
    if (keys.length === 0) fail(fixture, `commits[${i}].files is empty`);
    for (const [relPath, content] of Object.entries(commit.files)) {
      if (typeof content !== 'string') fail(fixture, `commits[${i}].files["${relPath}"] content must be a string`);
    }
  });
}

function validateExpected(fixture, fixtureDir) {
  const expectedPath = path.join(fixtureDir, 'EXPECTED.md');
  if (!fs.existsSync(expectedPath)) {
    fail(fixture, 'missing EXPECTED.md');
    return;
  }
  const fields = expectFields(fs.readFileSync(expectedPath, 'utf8'));
  const engine = fields['engine'];
  if (!ENGINES.includes(engine)) {
    fail(fixture, `EXPECTED.md "- engine:" must be one of ${ENGINES.join(', ')} (got "${engine ?? '(missing)'}")`);
    return;
  }
  const num = (key) => {
    const raw = fields[key];
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) {
      fail(fixture, `EXPECTED.md "${key}" is not a number: ${raw}`);
      return undefined;
    }
    return parsed;
  };

  const hasTriage = fields['expect_category'] !== undefined || fields['expect_min_confidence'] !== undefined;
  const hasQuality = fields['expect_quality_score_max'] !== undefined || fields['expect_deduction_dimensions'] !== undefined;
  const hasCoverage = fields['expect_gap_area'] !== undefined;
  const hasRisk = fields['expect_risk_tier'] !== undefined;
  const hasSelection = fields['expect_selected_tests_min'] !== undefined;
  const anyExpectation = hasTriage || hasQuality || hasCoverage || hasRisk || hasSelection;
  if (!anyExpectation) {
    fail(fixture, 'EXPECTED.md carries no expect_* machine fields');
  }

  if (fields['expect_category'] !== undefined && !FAILURE_CATEGORIES.has(fields['expect_category'])) {
    fail(fixture, `expect_category "${fields['expect_category']}" is not a FailureCategory`);
  }
  const minConfidence = num('expect_min_confidence');
  if (minConfidence !== undefined && (minConfidence < 0 || minConfidence > 1)) {
    fail(fixture, 'expect_min_confidence must be within 0..1');
  }
  if (fields['expect_deduction_dimensions'] !== undefined) {
    const dims = fields['expect_deduction_dimensions'].split(',').map((d) => d.trim()).filter(Boolean);
    if (dims.length === 0) fail(fixture, 'expect_deduction_dimensions is present but empty');
    for (const dim of dims) {
      if (!QUALITY_DIMENSIONS.has(dim)) fail(fixture, `expect_deduction_dimensions entry "${dim}" is not a QualityDimensionId`);
    }
  }
  const scoreMax = num('expect_quality_score_max');
  if (scoreMax !== undefined && (scoreMax < 0 || scoreMax > 100)) {
    fail(fixture, 'expect_quality_score_max must be within 0..100');
  }
  if (fields['expect_gap_area'] !== undefined && !CHANGE_AREAS.has(fields['expect_gap_area'])) {
    fail(fixture, `expect_gap_area "${fields['expect_gap_area']}" is not a ChangeArea`);
  }
  if (fields['expect_risk_tier'] !== undefined && !RISK_TIERS.has(fields['expect_risk_tier'])) {
    fail(fixture, `expect_risk_tier "${fields['expect_risk_tier']}" is not a RiskTier`);
  }
  const selMin = num('expect_selected_tests_min');
  if (selMin !== undefined && (!Number.isInteger(selMin) || selMin < 0)) {
    fail(fixture, 'expect_selected_tests_min must be a non-negative integer');
  }
}

function hasFiles(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some((e) => e.isFile()) || entries.some((e) => e.isDirectory() && hasFiles(path.join(dir, e.name)));
  } catch {
    return false;
  }
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error(`fixtures directory not found: ${ROOT}`);
    process.exit(1);
  }
  const names = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();

  if (names.length === 0) {
    console.error('no fixtures found');
    process.exit(1);
  }

  for (const name of names) {
    const fixtureDir = path.join(ROOT, name);
    if (!fs.existsSync(path.join(fixtureDir, 'app')) || !hasFiles(path.join(fixtureDir, 'app'))) {
      fail(name, 'missing or empty app/ source tree');
    }
    if (!fs.existsSync(path.join(fixtureDir, 'tests')) || !hasFiles(path.join(fixtureDir, 'tests'))) {
      fail(name, 'missing or empty tests/ tree');
    }
    validateCommits(name, fixtureDir);
    validateFailures(name, fixtureDir);
    validateExpected(name, fixtureDir);
    if (!fs.existsSync(path.join(fixtureDir, 'README.md'))) {
      fail(name, 'missing README.md (each fixture documents its scenario)');
    }
  }

  if (problems.length > 0) {
    console.error(`Fixture corpus INVALID — ${problems.length} problem(s) in ${names.length} fixtures:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(`Fixture corpus valid: ${names.length} fixtures checked (${names.join(', ')}).`);
}

main();
