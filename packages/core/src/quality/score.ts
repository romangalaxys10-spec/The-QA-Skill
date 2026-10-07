import type { QualityDeduction, QualityDimensionId, TestQualityReport, VerificationLabel } from '../types.js';
import { QUALITY_DIMENSIONS } from './dimensions.js';

/**
 * Static, heuristic test-quality analysis — explainable deductions, never a
 * bare number. This is deterministic static analysis (regex-based), honest
 * about its nature: it flags what it can SEE in the source. The label is
 * INFERRED (static heuristics), upgraded nowhere without execution.
 */

interface SourceLine {
  n: number;
  text: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /(api[_-]?key|apikey|secret|password|passwd|token|auth[_-]?token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /(?:sk|pk)_(?:live|test)_[\w]{10,}/i,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
];

function lines(src: string): SourceLine[] {
  return src.split('\n').map((text, i) => ({ n: i + 1, text }));
}

function countTestCases(src: string): number {
  const matches = src.match(/\b(?:test|it|test\.skip|it\.skip|it\.only|test\.only)\s*\(/g);
  return matches ? matches.length : 0;
}

export function analyzeTestFile(filePath: string, source: string): TestQualityReport {
  const deductions: QualityDeduction[] = [];
  const strengths: string[] = [];
  const src = lines(source);
  const testCount = countTestCases(source);

  const deduct = (dimension: QualityDimensionId, points: number, reason: string, line?: number): void => {
    deductions.push({ dimension, points, reason, line });
  };

  // ---- determinism --------------------------------------------------------
  const sleepLines = src.filter((l) => /waitForTimeout\s*\(|\.sleep\s*\(|setTimeout\s*\([^)]*,\s*\d{3,}/.test(l.text));
  if (sleepLines.length > 0) {
    deduct('determinism', Math.min(15, 8 * sleepLines.length),
      `arbitrary sleep(s) found — forbidden as first fix (golden rule 3): ${sleepLines.slice(0, 2).map((l) => `line ${l.n}`).join(', ')}`,
      sleepLines[0]?.n);
  } else {
    strengths.push('no arbitrary sleeps (web-first waiting)');
  }
  if (/Math\.random\(\)/.test(source) && !/(seed|deterministic)/i.test(source)) {
    deduct('determinism', 5, 'unseeded Math.random() — runs are not reproducible');
  }
  if (/Date\.now\(\)|new Date\(\)/.test(source) && !/(fake|mock|freeze|clock|advance)/i.test(source)) {
    deduct('determinism', 4, 'wall-clock time used without a fake/frozen clock');
  }

  // ---- assertion strength -------------------------------------------------
  const tautologies = src.filter((l) => /expect\s*\(\s*(?:true|1|'[^']*')\s*\)/.test(l.text) || /assert\.ok\(\s*\)/.test(l.text));
  if (tautologies.length > 0) {
    deduct('assertionStrength', 12, `tautological assertion(s): expect(true) — verifies nothing`, tautologies[0]?.n);
  }
  const assertionCount = (source.match(/expect\s*\(|assert\.|should\s+\./g) ?? []).length;
  if (testCount > 0 && assertionCount === 0) {
    deduct('assertionStrength', 25, 'no assertions found — test cannot fail for the right reason');
  } else if (testCount > 0 && assertionCount / testCount < 1) {
    deduct('assertionStrength', 8, `fewer assertions (${assertionCount}) than test cases (${testCount}) — some paths end unverified`);
  }
  if (/\.catch\s*\(\s*\)\s*;?$/.test(source) || /catch\s*(?:\(\s*\w*\s*\))?\s*\{\s*\}/.test(source)) {
    deduct('observability', 8, 'swallowed error (empty catch) — failures will be invisible');
  }

  // ---- negative & boundary coverage ---------------------------------------
  const negativeMarkers = (source.match(/\b(?:invalid|error|reject|denied|unauthorized|forbidden|fail|malformed|missing|negative|bad)\b/gi) ?? []).length;
  const boundaryMarkers = (source.match(/\b(?:zero|null|undefined|empty|max|min|maximum|minimum|boundary|expired|duplicate|overflow|limit)\b/gi) ?? []).length;
  if (testCount >= 3 && negativeMarkers === 0) {
    deduct('negativeCoverage', 10, 'no negative-path cases detected in a multi-case file');
  }
  if (testCount >= 3 && boundaryMarkers === 0) {
    deduct('boundaryCoverage', 8, 'no boundary cases (zero/one/max/empty/expired…) detected');
  }

  // ---- isolation ----------------------------------------------------------
  if (/\b(?:beforeAll|before\b)/.test(source) && !/\b(?:beforeEach|setUp)\b/.test(source)) {
    deduct('isolation', 6, 'beforeAll-only setup with no per-test reset — tests may share mutated state');
  }
  if (/this\.shared|moduleLevel Mutable|let\s+\w+\s*=\s*null\s*;?\s*\/\/\s*shared/i.test(source)) {
    deduct('isolation', 6, 'module-level mutable shared state detected');
  }

  // ---- security -----------------------------------------------------------
  const secretLines = src.filter((l) => SECRET_PATTERNS.some((p) => p.test(l.text)));
  if (secretLines.length > 0) {
    deduct('security', 25, `hardcoded secret-shaped literal(s) — golden rule 8 (never expose secrets in artifacts)`, secretLines[0]?.n);
  }
  if (/localhost:\d+|https?:\/\/(?!localhost|127\.0\.0\.1|example\.com|test\.)[\w.-]+/.test(source) && /prod/i.test(source)) {
    deduct('security', 10, 'possible production endpoint referenced in tests');
  }

  // ---- accessibility ------------------------------------------------------
  const uiTest = /\.tsx?$/.test(filePath) && /(page\.|screen\.|render\(|mount\()/.test(source);
  if (uiTest) {
    const byRole = (source.match(/getByRole|findByRole|ByRole|accessibleName/g) ?? []).length;
    const cssOnly = (source.match(/\.locator\(\s*['"][.#]|querySelector|css=/g) ?? []).length;
    if (cssOnly > 0 && byRole === 0) {
      deduct('accessibility', 8, 'CSS/XPath-only selectors in UI test — prefer role/label-based accessible queries');
    } else if (byRole > 0) {
      strengths.push('uses accessible role/label-based queries');
    }
  }

  // ---- maintainability / readability / runtime ----------------------------
  const loc = src.length;
  if (loc > 400) {
    deduct('maintainability', Math.min(15, Math.floor((loc - 400) / 40) + 6), `${loc} lines in a single test file — split by behavior`);
  }
  const giantTests = src.filter((l) => /\b(?:test|it)\s*\(/.test(l.text)).length;
  void giantTests;
  const hardcodedWait = (source.match(/\bwaitForTimeout\b/g) ?? []).length;
  if (hardcodedWait === 0 && testCount > 0 && /e2e|spec/.test(filePath) && !/expect|await/.test(source)) {
    deduct('runtime', 5, 'e2e file with neither assertions nor awaits — likely dead weight');
  }

  // ---- duplication (normalized block shingles) ----------------------------
  const dup = detectDuplication(src);
  if (dup > 0.3) {
    deduct('duplication', 10, `${Math.round(dup * 100)}% duplicated block content — extract shared flows/helpers`);
  }

  // ---- mock quality -------------------------------------------------------
  if (/jest\.mock\(|vi\.mock\(|sinon\./.test(source)) {
    const restore = /afterEach|restore|unstub|resetAllMocks|clearAllMocks/.test(source);
    if (!restore) deduct('mockQuality', 6, 'module mocks without afterEach restore — mocks may leak across tests');
    if ((source.match(/jest\.mock\(|vi\.mock\(/g) ?? []).length > 4) {
      deduct('mockQuality', 5, 'over-mocked file — tests may verify mocks, not behavior');
    }
  }

  // ---- data quality -------------------------------------------------------
  if (/username|email|account/i.test(source) && /\+\s*(Date\.now\(\)|Math\.random)/.test(source)) {
    deduct('dataQuality', 4, 'identity from Date.now()/random suffix — use seeded factories for reproducibility');
  }

  // ---- observability ------------------------------------------------------
  const consoleLogs = (source.match(/console\.(log|debug)/g) ?? []).length;
  if (consoleLogs > 2) deduct('observability', 4, `${consoleLogs} console.log calls — prefer structured reporting/traces`);

  // ---- correctness signal -------------------------------------------------
  if (/\.only\s*\(/.test(source)) {
    deduct('correctness', 10, 'test.only/it.only left in source — silently disables the rest of the suite');
  }
  if (/\.(?:skip|todo)\s*\(/.test(source)) {
    deduct('correctness', 5, 'skipped tests present — record them as test debt with a reason');
  }

  const maxScore = 100;
  const totalDeduction = deductions.reduce((a, d) => a + d.points, 0);
  const score = Math.max(0, Math.min(maxScore, maxScore - totalDeduction));
  const label: VerificationLabel = 'INFERRED';

  return { filePath, score, testCount, deductions: deductions.sort((a, b) => b.points - a.points), strengths, label };
}

/** Cheap duplicate-block estimate: Jaccard over 5-line shingles of stripped code. */
export function detectDuplication(src: SourceLine[]): number {
  const codeLines = src
    .map((l) => l.text.replace(/\/\/.*$/, '').replace(/['"`].*['"`]/g, '""').trim())
    .filter((t) => t.length > 0);
  if (codeLines.length < 10) return 0;
  const shingles = new Map<string, number>();
  for (let i = 0; i + 5 <= codeLines.length; i++) {
    const key = codeLines.slice(i, i + 5).join('|');
    shingles.set(key, (shingles.get(key) ?? 0) + 1);
  }
  let duplicated = 0;
  let total = 0;
  for (const count of shingles.values()) {
    total += count;
    if (count > 1) duplicated += count - 1;
  }
  return total === 0 ? 0 : duplicated / total;
}

/** Suite health: the 10 documented components, 0..100. */
export function suiteHealth(input: {
  testReports: TestQualityReport[];
  weightedCoverage?: number;
  flakeHealthScore?: number;
  avgRuntimeMs?: number;
  a11yCoverage?: number;
  securityTestCount?: number;
  observabilityEvents?: number;
}): import('../types.js').SuiteHealthReport {
  const reports = input.testReports;
  const avgQuality = reports.length > 0 ? reports.reduce((a, r) => a + r.score, 0) / reports.length : 0;

  const components = [
    { component: 'functional coverage', score: clamp(input.weightedCoverage ?? 0), weight: 15, notes: 'risk-weighted coverage of source files' },
    { component: 'risk coverage', score: clamp(input.weightedCoverage !== undefined ? input.weightedCoverage * 0.9 : 0), weight: 10, notes: 'coverage of critical business flows' },
    { component: 'test reliability', score: clamp(avgQuality), weight: 15, notes: `${reports.length} test files analyzed for quality` },
    { component: 'flake health', score: clamp(input.flakeHealthScore ?? 0), weight: 15, notes: 'flaky tests drag suite trust down' },
    { component: 'assertion strength', score: clamp(avgComponent(reports, 'assertionStrength')), weight: 10, notes: 'deductions for tautologies and missing assertions' },
    { component: 'maintainability', score: clamp(avgComponent(reports, 'maintainability')), weight: 10, notes: 'file size, duplication, structure' },
    { component: 'runtime efficiency', score: clamp(input.avgRuntimeMs !== undefined ? (input.avgRuntimeMs < 30_000 ? 90 : input.avgRuntimeMs < 120_000 ? 60 : 30) : 0), weight: 10, notes: 'suite wall-clock efficiency' },
    { component: 'accessibility', score: clamp(input.a11yCoverage ?? avgComponent(reports, 'accessibility')), weight: 5, notes: 'a11y queries and coverage' },
    { component: 'security', score: clamp(input.securityTestCount && input.securityTestCount > 0 ? 85 : avgComponent(reports, 'security')), weight: 5, notes: 'secret hygiene + security test presence' },
    { component: 'observability', score: clamp(input.observabilityEvents && input.observabilityEvents > 0 ? 85 : avgComponent(reports, 'observability')), weight: 5, notes: 'evidence-producing failures' },
  ];

  const totalWeight = components.reduce((a, c) => a + c.weight, 0);
  const score = Math.round(components.reduce((a, c) => a + c.score * c.weight, 0) / totalWeight);
  return { score, components, label: 'INFERRED' };
}

function avgComponent(reports: TestQualityReport[], dimension: QualityDimensionId): number {
  if (reports.length === 0) return 0;
  const penalized = reports.map((r) => {
    const d = r.deductions.filter((x) => x.dimension === dimension).reduce((a, x) => a + x.points, 0);
    return Math.max(0, 100 - d * 2);
  });
  return penalized.reduce((a, b) => a + b, 0) / penalized.length;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
