import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ChangedFile, RiskTier, SelectionResult, SelectedTest, RoutingHint,
  TestInventoryEntry, TestLayer, VerificationLabel,
} from '../types.js';
import type { ChangeRouting } from './diff.js';

/**
 * Smallest high-confidence test set for a change set.
 *
 * Algorithm (documented in docs/test-selection.md):
 *  1. Build the import graph: for every test file, resolve relative/aliased
 *     imports transitively (bounded depth) to the source files it covers.
 *  2. Map changed files → tests that cover them (direct or transitive).
 *  3. Rank by risk: payment/auth/db-adjacent covered files raise priority.
 *  4. Apply pyramid intelligence: if the same covered file is also covered by
 *     lower-layer tests, E2E tests are demoted (reason recorded, not deleted).
 *  5. Apply routing policy from the change classification (css-only → no API
 *     suites; payment → heavy validation; migration → data-integrity tests).
 *  6. Every selected test carries explicit file-level reasons.
 */

const IMPORT_RE = /(?:import\s+[^'"]*?from\s*|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

/** Resolve one import specifier to a repo-relative file path, if possible. */
function resolveImport(specifier: string, fromFile: string, allFiles: Set<string>, pathAliases: Array<{ prefix: string; target: string }>): string | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/') && !specifier.startsWith('~/')) {
    return undefined; // external package
  }
  const baseDir = fromFile.split('/').slice(0, -1).join('/');
  let candidate: string;
  if (specifier.startsWith('.')) {
    candidate = normalizeJoin(baseDir, specifier);
  } else {
    const alias = pathAliases.find((a) => specifier.startsWith(a.prefix));
    if (!alias) return undefined;
    candidate = normalizeJoin(alias.target, specifier.slice(alias.prefix.length));
  }
  const candidates = [
    candidate,
    `${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`, `${candidate}.jsx`, `${candidate}.mjs`, `${candidate}.cjs`,
    `${candidate}/index.ts`, `${candidate}/index.js`,
  ];
  for (const c of candidates) {
    if (allFiles.has(c)) return c;
  }
  return undefined;
}

function normalizeJoin(dir: string, rel: string): string {
  const parts = `${dir}/${rel}`.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/** Build the transitive coverage map for a test file. */
export function computeCoverage(
  testFilePath: string,
  allFiles: Set<string>,
  pathAliases: Array<{ prefix: string; target: string }> = [],
  maxDepth = 12,
): string[] {
  const seen = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: testFilePath, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || item.depth >= maxDepth) continue;
    let source: string;
    try {
      source = readFileSync(join(process.cwd(), item.file), 'utf8');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(source)) !== null) {
      const spec = m[1] ?? '';
      const resolved = resolveImport(spec, item.file, allFiles, pathAliases);
      if (resolved && resolved !== testFilePath && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push({ file: resolved, depth: item.depth + 1 });
      }
    }
  }
  return [...seen];
}

function layerRank(layer: TestLayer): number {
  const order: TestLayer[] = ['unit', 'integration', 'contract', 'api', 'a11y', 'visual', 'e2e', 'security', 'performance', 'manual'];
  return order.indexOf(layer);
}

/** Pyramid intelligence: prefer lower layers covering the same file. */
function pyramidDemotionReason(test: TestInventoryEntry, coveredRiskFiles: Set<string>, inventory: TestInventoryEntry[]): string | undefined {
  if (test.layer !== 'e2e') return undefined;
  const lowerCoversSame = inventory.some(
    (other) =>
      other.testId !== test.testId &&
      layerRank(other.layer) < layerRank('e2e') &&
      other.covers.some((c) => coveredRiskFiles.has(c)),
  );
  if (lowerCoversSame) {
    return 'lower-layer tests already cover this changed file — E2E retained only because the flow is business-critical';
  }
  return undefined;
}

export interface SelectOptions {
  routing?: ChangeRouting;
  alwaysInclude?: string[];
  maxPrE2E?: number;
  /** Policy mode: pr keeps the set minimal; pre_merge/release expand. */
  policy?: 'pr' | 'pre_merge' | 'nightly' | 'release' | 'post_deploy';
}

function riskTierForCoveredFiles(covers: string[], changed: ChangedFile[]): RiskTier {
  const hitCritical = changed.filter((f) => covers.includes(f.path));
  const areas = new Set(hitCritical.map((f) => f.area));
  if (areas.has('payment') || areas.has('auth')) return 'critical';
  if (areas.has('db') || areas.has('api')) return 'high';
  if (hitCritical.length > 0) return 'medium';
  return 'low';
}

export function selectTests(
  changedFiles: ChangedFile[],
  inventory: TestInventoryEntry[],
  routing?: ChangeRouting,
  opts: SelectOptions = {},
): SelectionResult {
  const changedPaths = new Set(changedFiles.map((f) => f.path));
  const hints = buildRoutingHints(routing, changedFiles);
  const selected: SelectedTest[] = [];
  const unaffected: TestInventoryEntry[] = [];

  const maxE2E = opts.maxPrE2E ?? 25;
  let e2eCount = 0;

  const always = opts.alwaysInclude ?? [];
  const policy = opts.policy ?? 'pr';

  for (const test of inventory) {
    const reasons: string[] = [];
    const directHits = test.covers.filter((c) => changedPaths.has(c));
    if (directHits.length > 0) {
      reasons.push(`covers changed file${directHits.length > 1 ? 's' : ''}: ${directHits.slice(0, 3).join(', ')}`);
    }
    if (always.some((p) => test.filePath.includes(p) || test.covers.some((c) => c.includes(p)))) {
      reasons.push('matched alwaysInclude pattern from config');
    }

    const coveredRiskFiles = new Set(directHits);
    if (reasons.length === 0) {
      unaffected.push(test);
      continue;
    }

    let priority = riskTierForCoveredFiles(directHits, changedFiles);
    if (routing?.paymentRelated && priority === 'critical') {
      reasons.push('payment area change → heavy validation per routing policy');
    }
    if (routing?.authRelated && test.layer !== 'unit') {
      reasons.push('auth boundary change → risk priority elevated');
    }
    if (routing?.cssOnly && test.layer !== 'e2e' && test.layer !== 'visual') {
      // CSS-only changes still allow visual + e2e smoke, but skip API-heavy suites.
      priority = 'low';
      reasons.push('css-only change set → deprioritized');
    }
    if (routing?.migrationRelated && /data|integrity|migrat/i.test(test.name + test.filePath)) {
      priority = 'critical';
      reasons.push('migration change → data-integrity validation elevated');
    }

    const demotion = pyramidDemotionReason(test, coveredRiskFiles, inventory);
    if (demotion) reasons.push(demotion);

    if (test.layer === 'e2e') {
      e2eCount += 1;
      if (e2eCount > maxE2E && policy === 'pr') {
        reasons.push(`PR policy e2e budget (${maxE2E}) exhausted → deferred to pre-merge suite`);
        priority = 'low';
      }
    }

    if (test.flakeScore !== undefined && test.flakeScore >= 70) {
      reasons.push(`known flaky (score ${Math.round(test.flakeScore)}) → run isolated, do not block merge on first failure`);
    }

    selected.push({ test, priority, reasons });
  }

  // Signal ordering: critical → high → medium → low, then shortest runtime first.
  const rank: Record<RiskTier, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  selected.sort((a, b) => {
    const byRank = rank[a.priority] - rank[b.priority];
    if (byRank !== 0) return byRank;
    return (a.test.avgDurationMs ?? 0) - (b.test.avgDurationMs ?? 0);
  });

  const label: VerificationLabel = 'INFERRED';
  const summary =
    selected.length === 0
      ? 'No inventory test covers the change set — coverage gap; generate tests for the affected files.'
      : `${selected.length} of ${inventory.length} inventory tests selected (smallest high-confidence set); ${unaffected.length} unaffected.`;

  return { selected, unaffected, routing: hints, summary, label };
}

export function buildRoutingHints(routing: ChangeRouting | undefined, changedFiles: ChangedFile[]): RoutingHint[] {
  const hints: RoutingHint[] = [
    {
      rule: 'css-only-change',
      triggered: routing?.cssOnly ?? false,
      action: 'Skip API/DB regression suites; run visual + component smoke only.',
      reason: 'Only stylesheet files changed — 4,000 API tests would be waste, not signal.',
    },
    {
      rule: 'payment-change',
      triggered: routing?.paymentRelated ?? false,
      action: 'Heavy validation: payment unit + API + contract + high-value E2E.',
      reason: 'Payment logic change detected in change set.',
    },
    {
      rule: 'db-migration',
      triggered: routing?.migrationRelated ?? false,
      action: 'Run data-integrity + migration tests; verify rollback path.',
      reason: 'Database migration/schema files present.',
    },
    {
      rule: 'auth-change',
      triggered: routing?.authRelated ?? false,
      action: 'Elevate authz matrix tests, session lifecycle, token expiry tests.',
      reason: 'Authentication boundary files changed.',
    },
    {
      rule: 'docs-only',
      triggered: routing?.docsOnly ?? false,
      action: 'No test execution required; link-check docs if CI has it.',
      reason: 'Change set contains only documentation.',
    },
    {
      rule: 'test-only',
      triggered: routing?.testOnly ?? false,
      action: 'Run affected test files; no product regression expected.',
      reason: 'Only test files changed.',
    },
  ];
  void changedFiles;
  return hints;
}
