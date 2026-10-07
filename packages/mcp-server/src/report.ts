/**
 * Local report assembly for the MCP server: the deterministic release gate
 * (evaluate_release) and the per-audience quality report renderer
 * (generate_quality_report). These are implemented here — deliberately NOT
 * imported from the reporting package — so the MCP server stays a thin,
 * dependency-free surface over core + agents with the documented gate rules
 * copied honestly from the platform spec.
 */
import type {
  CoverageReport, DiscoveryResult, FlakeAssessment, ReleaseGateInput, ReleaseGateResult,
  ReleaseVerdict, SuiteHealthReport, TestQualityReport, TriageResult, VerificationLabel,
} from '@the-qa-skill/core';
import { strongestLabel } from '@the-qa-skill/core';
import { MCP_SERVER_VERSION } from './version.js';
import type { ReportAudience } from './tools.js';
import { errorMessage } from './errors.js';

/** Platform quality gates (mirrors theqa.config.json defaults, documented). */
const MIN_WEIGHTED_COVERAGE = 60;
const MAX_UNKNOWN_TRIAGE = 2;

// ---------------------------------------------------------------------------
// Release gate
// ---------------------------------------------------------------------------

/**
 * Deterministic release gate — the documented rules, no ML, no thresholds
 * pulled from thin air:
 *
 *   1. Empty input (no assessments, no counts, no coverage)  → UNKNOWN.
 *   2. failedRealRegressions > 0                             → BLOCKED finding.
 *   3. triageResults with category REAL_REGRESSION and
 *      confidence >= 0.9                                     → BLOCKED finding.
 *   4. openUnknownCategories > 2                             → warning.
 *   5. criticalFlakeCount > 0                                → warning.
 *   6. coverage.weightedCoverage < 60                        → warning.
 *   7. evidenceComplete false                                → warning (downgrades
 *      a PASS to PASS_WITH_WARNINGS).
 *
 * Verdict: BLOCKED when any blocking finding exists; otherwise
 * PASS_WITH_WARNINGS when any warning exists; otherwise PASS.
 * The verification label is the strongest label of the supplied evidence.
 */
export function computeGate(input: Partial<ReleaseGateInput> | undefined): ReleaseGateResult {
  const riskAssessments = Array.isArray(input?.riskAssessments) ? input.riskAssessments : [];
  const triageResults = Array.isArray(input?.triageResults) ? input.triageResults : [];
  const flakeAssessments = Array.isArray(input?.flakeAssessments) ? input.flakeAssessments : [];
  const coverage = input?.coverage;
  const failedRealRegressions = nonNegativeInt(input?.failedRealRegressions);
  const openUnknownCategories = nonNegativeInt(input?.openUnknownCategories);
  const criticalFlakeCount = nonNegativeInt(input?.criticalFlakeCount);
  const evidenceComplete = input?.evidenceComplete === true;

  const isEmpty =
    riskAssessments.length === 0 &&
    triageResults.length === 0 &&
    flakeAssessments.length === 0 &&
    coverage === undefined &&
    failedRealRegressions === 0 &&
    openUnknownCategories === 0 &&
    criticalFlakeCount === 0;

  if (isEmpty) {
    return {
      verdict: 'UNKNOWN',
      reasons: ['no release-gate input data — nothing to evaluate; the gate never invents a verdict'],
      blockingFindings: [],
      warnings: [],
      label: 'NOT_VERIFIED',
    };
  }

  const blockingFindings: string[] = [];
  if (failedRealRegressions > 0) {
    blockingFindings.push(`${failedRealRegressions} failed REAL_REGRESSION test(s) — rule: real regressions block release`);
  }
  for (const t of triageResults) {
    if (t && t.category === 'REAL_REGRESSION' && typeof t.confidence === 'number' && t.confidence >= 0.9) {
      blockingFindings.push(
        `triage result for "${t.testId}" is REAL_REGRESSION with confidence ${t.confidence} (>= 0.9) — rule: high-confidence regressions block release`,
      );
    }
  }

  const warnings: string[] = [];
  if (openUnknownCategories > MAX_UNKNOWN_TRIAGE) {
    warnings.push(`${openUnknownCategories} triage results are UNKNOWN (limit ${MAX_UNKNOWN_TRIAGE}) — resolve or explain them before release`);
  }
  if (criticalFlakeCount > 0) {
    warnings.push(`${criticalFlakeCount} critical_flaky test(s) — suite signal is not trustworthy until they are fixed or quarantined`);
  }
  if (coverage && typeof coverage.weightedCoverage === 'number' && coverage.weightedCoverage < MIN_WEIGHTED_COVERAGE) {
    warnings.push(`risk-weighted coverage ${coverage.weightedCoverage} is below the ${MIN_WEIGHTED_COVERAGE} minimum`);
  }
  if (!evidenceComplete) {
    warnings.push('evidence incomplete — a PASS would be downgraded to PASS_WITH_WARNINGS until all expected evidence is collected');
  }

  const verdict: ReleaseVerdict =
    blockingFindings.length > 0 ? 'BLOCKED' : warnings.length > 0 ? 'PASS_WITH_WARNINGS' : 'PASS';

  const labels: VerificationLabel[] = [
    ...riskAssessments.map((a) => a?.label),
    ...triageResults.map((t) => t?.label),
    ...flakeAssessments.map((f) => f?.label),
  ].filter((l): l is VerificationLabel => typeof l === 'string');
  const label: VerificationLabel = labels.length > 0 ? strongestLabel(labels) : 'INFERRED';

  const reasons: string[] = [];
  if (verdict === 'BLOCKED') {
    reasons.push(...blockingFindings);
  } else if (verdict === 'PASS_WITH_WARNINGS') {
    reasons.push(...warnings);
  } else {
    reasons.push('all deterministic gate rules passed');
    reasons.push('evidence complete');
  }
  reasons.push(
    `evaluated ${riskAssessments.length} risk assessment(s), ${triageResults.length} triage result(s), ` +
    `${flakeAssessments.length} flake assessment(s)${coverage ? ', coverage report' : ', no coverage report'} ` +
    `for environment "${input?.environment ?? 'unspecified'}"`,
  );

  return { verdict, reasons, blockingFindings, warnings, label };
}

function nonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// Quality report
// ---------------------------------------------------------------------------

/** Data sections the quality report renders; every section is optional. */
export interface ReportData {
  discovery?: DiscoveryResult;
  suiteHealth?: SuiteHealthReport;
  qualityReports?: TestQualityReport[];
  coverage?: CoverageReport;
  flakeAssessments?: FlakeAssessment[];
  triageResults?: TriageResult[];
}

const noData = 'no data';

/**
 * Render the markdown quality report for one audience. Every number comes
 * from the supplied data; sections without data render "no data" — the
 * report never fabricates measurements.
 */
export function renderQualityReport(audience: ReportAudience, data: ReportData): string {
  const out: string[] = [];
  out.push(`# Quality report — ${audience} view`, '');
  out.push(
    `_the-qa-skill-mcp ${MCP_SERVER_VERSION} · generated ${new Date().toISOString()} · ` +
    'every section states its verification label; sections without data say "no data" — nothing is fabricated._',
    '',
  );

  out.push(...inventorySection(data.discovery));
  out.push(...suiteHealthSection(data.suiteHealth, audience));
  out.push(...qualitySection(data.qualityReports, audience));
  out.push(...coverageSection(data.coverage, audience));
  out.push(...flakeSection(data.flakeAssessments, audience));
  out.push(...triageSection(data.triageResults, audience));
  out.push(...audienceSummary(audience, data));

  return out.join('\n');
}

function inventorySection(d: DiscoveryResult | undefined): string[] {
  const out = ['## Project & test inventory', ''];
  if (!d) return [...out, noData, ''];
  const cases = d.testFiles.reduce((sum, t) => sum + t.estimatedCases, 0);
  out.push(`- Language: ${d.stack.language}${d.stack.framework ? ` · framework: ${d.stack.framework}` : ''}`);
  out.push(`- Test frameworks: ${d.stack.testFrameworks.length > 0 ? d.stack.testFrameworks.join(', ') : noData}`);
  out.push(`- Test files: ${d.testFiles.length}${cases > 0 ? ` (~${cases} estimated cases)` : ''}`);
  out.push(`- Source files: ${d.sourceFiles.length}`);
  out.push(`- QA config files: ${d.configFiles.length}`);
  if (d.stack.monorepo) out.push('- Monorepo: yes');
  out.push('', `_label: ${d.label}_`, '');
  return out;
}

function suiteHealthSection(sh: SuiteHealthReport | undefined, audience: ReportAudience): string[] {
  const out = ['## Suite health', ''];
  if (!sh) return [...out, noData, ''];
  out.push(`- Score: ${Math.round(sh.score)}/100 (_label: ${sh.label}_)`);
  if (sh.components.length === 0) {
    out.push(`- Components: ${noData}`);
  } else if (audience === 'engineering') {
    out.push('', '| component | score | weight | notes |', '| --- | --- | --- | --- |');
    for (const c of sh.components) out.push(`| ${c.component} | ${Math.round(c.score)} | ${c.weight} | ${c.notes} |`);
  } else if (audience !== 'executive') {
    const worst = [...sh.components].sort((a, b) => a.score - b.score).slice(0, 3);
    for (const c of worst) out.push(`- Weakest component: ${c.component} (${Math.round(c.score)}/100) — ${c.notes}`);
  }
  out.push('');
  return out;
}

function qualitySection(reports: TestQualityReport[] | undefined, audience: ReportAudience): string[] {
  const out = ['## Test quality', ''];
  if (!reports || reports.length === 0) return [...out, noData, ''];
  const limit = audience === 'executive' ? 3 : audience === 'leadership' ? 5 : 10;
  const ranked = [...reports].sort((a, b) => a.score - b.score).slice(0, limit);
  const detail = audience === 'engineering' || audience === 'qa';
  for (const r of ranked) {
    out.push(`- ${r.filePath} — ${r.score}/100 · ${r.testCount} test(s) (_label: ${r.label}_)`);
    if (detail) {
      for (const d of r.deductions.slice(0, 3)) {
        out.push(`  - ${d.dimension}: -${d.points} — ${d.reason}${d.line !== undefined ? ` (line ${d.line})` : ''}`);
      }
    }
  }
  out.push('');
  return out;
}

function coverageSection(cov: CoverageReport | undefined, audience: ReportAudience): string[] {
  const out = ['## Coverage', ''];
  if (!cov) return [...out, noData, ''];
  out.push(`- Risk-weighted coverage: ${cov.weightedCoverage}/100 (platform minimum: ${MIN_WEIGHTED_COVERAGE})`);
  out.push(`- Raw file coverage: ${cov.fileCoverage}%`);
  out.push(`- Coverage gaps: ${cov.gaps.length}`);
  if (audience !== 'executive') {
    for (const g of cov.gaps.slice(0, 10)) out.push(`  - ${g.path} (${g.area}) — ${g.reason}`);
  }
  out.push('', `_label: ${cov.label}_`, '');
  return out;
}

function flakeSection(assessments: FlakeAssessment[] | undefined, audience: ReportAudience): string[] {
  const out = ['## Flake intelligence', ''];
  if (!assessments || assessments.length === 0) return [...out, noData, ''];
  const critical = assessments.filter((a) => a.verdict === 'critical_flaky').length;
  const flaky = assessments.filter((a) => a.verdict === 'flaky').length;
  out.push(`- Assessed tests: ${assessments.length} · critical_flaky: ${critical} · flaky: ${flaky}`);
  const interesting = assessments.filter((a) => a.verdict === 'flaky' || a.verdict === 'critical_flaky');
  const limit = audience === 'executive' ? 3 : 10;
  for (const a of interesting.slice(0, limit)) {
    out.push(`  - ${a.testId} — score ${a.score}/100 (${a.verdict}, fail rate ${(a.failRate * 100).toFixed(0)}%)`);
  }
  out.push('');
  return out;
}

function triageSection(results: TriageResult[] | undefined, audience: ReportAudience): string[] {
  const out = ['## Failure triage', ''];
  if (!results || results.length === 0) return [...out, noData, ''];
  const byCategory = new Map<string, number>();
  for (const r of results) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
  out.push(`- Classified failures: ${results.length}`);
  for (const [category, count] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    out.push(`  - ${category}: ${count}`);
  }
  if (audience !== 'executive') {
    for (const r of results.filter((t) => t.category === 'REAL_REGRESSION').slice(0, 5)) {
      out.push(`  - REGRESSION ${r.testId} (confidence ${r.confidence}) → ${r.recommendedAction}`);
    }
  }
  out.push('');
  return out;
}

function audienceSummary(audience: ReportAudience, data: ReportData): string[] {
  const sh = data.suiteHealth;
  const cov = data.coverage;
  switch (audience) {
    case 'engineering':
      return [
        '## Reading this report',
        '',
        '- Every number comes from the deterministic engines in @the-qa-skill/core; each section label states whether the data was observed or inferred.',
        '- Feed the collected evidence to `evaluate_release` for a blocking verdict before merging.',
        '',
      ];
    case 'qa':
      return [
        '## Suggested QA actions',
        '',
        data.qualityReports && data.qualityReports.length > 0
          ? '- Start with the lowest-scoring test files in Test quality; fix deductions at the source.'
          : '- No per-file quality data yet — run the review flow over the inventory to populate it.',
        criticalFlakes(data) > 0
          ? `- ${criticalFlakes(data)} critical_flaky test(s) need fixing or quarantine before suite signal can be trusted.`
          : '- No critical flake data reported.',
        cov && cov.weightedCoverage < MIN_WEIGHTED_COVERAGE
          ? `- Risk-weighted coverage ${cov.weightedCoverage}/100 is below the ${MIN_WEIGHTED_COVERAGE} minimum — close the listed gaps first.`
          : '- Coverage data is absent or above the minimum.',
        '',
      ];
    case 'leadership':
      return [
        '## Summary',
        '',
        `- Suite health: ${sh ? `${Math.round(sh.score)}/100 (${sh.label})` : noData}.`,
        `- Risk-weighted coverage: ${cov ? `${cov.weightedCoverage}/100 (minimum ${MIN_WEIGHTED_COVERAGE})` : noData}.`,
        `- Flaky tests needing attention: ${data.flakeAssessments ? String(data.flakeAssessments.filter((a) => a.verdict === 'flaky' || a.verdict === 'critical_flaky').length) : noData}.`,
        `- Failures awaiting classification: ${data.triageResults ? String(data.triageResults.filter((t) => t.category === 'UNKNOWN').length) : noData}.`,
        '',
      ];
    case 'executive':
      return [
        '## Executive summary',
        '',
        `- Test suite: ${data.discovery ? `${data.discovery.testFiles.length} test file(s) detected; suite health ${sh ? Math.round(sh.score) + '/100' : noData}` : noData}.`,
        `- Coverage: ${cov ? `${cov.weightedCoverage}/100 against a minimum of ${MIN_WEIGHTED_COVERAGE}` : noData}.`,
        `- Known flaky tests: ${data.flakeAssessments ? String(data.flakeAssessments.filter((a) => a.verdict === 'flaky' || a.verdict === 'critical_flaky').length) : noData}.`,
        `- Overall: ${overallStatement(data)}`,
        '',
      ];
  }
}

function criticalFlakes(data: ReportData): number {
  return data.flakeAssessments?.filter((a) => a.verdict === 'critical_flaky').length ?? 0;
}

function overallStatement(data: ReportData): string {
  const healthyHealth = data.suiteHealth === undefined || data.suiteHealth.score >= 70;
  const healthyCoverage = data.coverage === undefined || data.coverage.weightedCoverage >= MIN_WEIGHTED_COVERAGE;
  const noCriticalFlakes = criticalFlakes(data) === 0;
  const hasAnyData = data.suiteHealth !== undefined || data.coverage !== undefined || (data.flakeAssessments?.length ?? 0) > 0;
  if (!hasAnyData) return `${noData} — run the platform engines to populate this report.`;
  if (healthyHealth && healthyCoverage && noCriticalFlakes) return 'quality signals are healthy; maintain current practices.';
  return 'quality signals show gaps that need attention before the next release.';
}

/**
 * Best-effort normalizer for ReviewAgent review output: extracts the sections
 * this renderer understands and ignores everything else, so an evolving
 * agents package can never crash (or fabricate data into) the report.
 */
export function normalizeReviewResult(raw: unknown): ReportData {
  const out: ReportData = {};
  if (Array.isArray(raw)) {
    const quality = raw.filter(isQualityReport);
    if (quality.length > 0) out.qualityReports = quality;
    return out;
  }
  if (raw === null || typeof raw !== 'object') return out;
  const rec = raw as Record<string, unknown>;

  const suiteHealth = rec['suiteHealth'];
  if (isRecord(suiteHealth) && typeof suiteHealth['score'] === 'number' && Array.isArray(suiteHealth['components'])) {
    out.suiteHealth = suiteHealth as unknown as SuiteHealthReport;
  }

  const qualityRaw = rec['qualityReports'] ?? rec['reports'] ?? rec['files'];
  if (Array.isArray(qualityRaw)) {
    const quality = qualityRaw.filter(isQualityReport);
    if (quality.length > 0) out.qualityReports = quality;
  }

  const coverage = rec['coverage'];
  if (isRecord(coverage) && typeof coverage['weightedCoverage'] === 'number') {
    out.coverage = coverage as unknown as CoverageReport;
  }

  const flakeRaw = rec['flakeAssessments'] ?? rec['flake'];
  if (Array.isArray(flakeRaw)) {
    const flake = flakeRaw.filter((f) => isRecord(f) && typeof (f as Record<string, unknown>)['verdict'] === 'string');
    if (flake.length > 0) out.flakeAssessments = flake as unknown as FlakeAssessment[];
  }

  const triageRaw = rec['triageResults'] ?? rec['triage'];
  if (Array.isArray(triageRaw)) {
    const triage = triageRaw.filter((t) => isRecord(t) && typeof (t as Record<string, unknown>)['category'] === 'string');
    if (triage.length > 0) out.triageResults = triage as unknown as TriageResult[];
  }

  const discoveryRaw = rec['discovery'];
  if (isDiscovery(discoveryRaw)) {
    out.discovery = discoveryRaw;
  } else if (isRecord(rec['stack'])) {
    out.discovery = {
      root: typeof rec['root'] === 'string' ? rec['root'] : '',
      stack: rec['stack'] as unknown as DiscoveryResult['stack'],
      testFiles: Array.isArray(rec['testFiles']) ? (rec['testFiles'] as DiscoveryResult['testFiles']) : [],
      sourceFiles: Array.isArray(rec['sourceFiles']) ? (rec['sourceFiles'] as string[]) : [],
      configFiles: Array.isArray(rec['configFiles']) ? (rec['configFiles'] as string[]) : [],
      label: 'OBSERVED',
    };
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isQualityReport(value: unknown): value is TestQualityReport {
  return isRecord(value) && typeof value['filePath'] === 'string' && typeof value['score'] === 'number';
}

function isDiscovery(value: unknown): value is DiscoveryResult {
  return isRecord(value) && isRecord(value['stack']) && Array.isArray(value['testFiles']);
}

/** Render one structured error line for report tooling (kept local for tests). */
export function describeReportError(err: unknown): string {
  return `quality report failed: ${errorMessage(err)}`;
}
