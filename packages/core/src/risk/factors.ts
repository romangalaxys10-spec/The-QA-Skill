import type { ChangeArea, ChangedFile, RiskFactorId, RiskInput } from '../types.js';
import type { RiskWeights } from '../config.js';

/**
 * Risk factor signal extraction. Every value is derived from observable input
 * and carries explicit reasons — the engine never produces a number without a
 * "because". Keyword tables below are deliberately transparent (auditable,
 * deterministic) rather than magic.
 */

export const FACTOR_IDS: readonly RiskFactorId[] = [
  'businessCriticality',
  'changeSurface',
  'defectHistory',
  'codeComplexity',
  'integrationDepth',
  'userImpact',
  'securitySensitivity',
  'dataSensitivity',
] as const;

/** Transparent keyword → area classifier. Order matters: first match wins. */
const AREA_PATTERNS: ReadonlyArray<{ area: ChangeArea; patterns: RegExp[] }> = [
  { area: 'auth', patterns: [/auth/i, /login|logout|session|sso|oauth|jwt|token|credential|password/i] },
  { area: 'payment', patterns: [/pay|billing|invoice|checkout|cart|subscription|charge|refund|pricing|stripe|paypal/i] },
  { area: 'db', patterns: [/migrat|schema|model|entity|repositor|orm|sql|query|database|db[/\\]/i] },
  { area: 'api', patterns: [/api[/\\]/, /route|controller|endpoint|graphql|resolvers?|handlers?/i] },
  { area: 'config', patterns: [/config|\.env|settings|tsconfig|webpack|vite|rollup|babel|eslint|tslint|dockerfile|\.ya?ml$/i] },
  { area: 'test', patterns: [/(^|[/\\])(test|tests|spec|__tests__|e2e)[/\\]/i, /\.(test|spec)\.[jt]sx?$/i] },
  { area: 'docs', patterns: [/\.md$/i, /(^|[/\\])docs?[/\\]/i] },
  { area: 'infra', patterns: [/(^|[/\\])\.github[/\\]/, /(^|[/\\])\.gitlab/, /jenkinsfile/i, /(^|[/\\])infrastructure[/\\]/i, /terraform|cloudformation|helm/i] },
  { area: 'ui', patterns: [/component|page|view|screen|widget|layout|css|scss|style|\.tsx$/i] },
];

export function classifyArea(filePath: string): ChangeArea {
  for (const { area, patterns } of AREA_PATTERNS) {
    if (patterns.some((p) => p.test(filePath))) return area;
  }
  return 'unknown';
}

const SECURITY_PATTERNS: RegExp[] = [
  /auth/i, /login|session|sso|oauth|jwt|token|credential|password|permission|rbac|acl/i,
  /secret|vault|crypto|encrypt|hash|salt|csp|csrf|xss|sanitiz/i,
];
const DATA_PATTERNS: RegExp[] = [/migrat|schema/i, /model|entity|orm/i, /database|db[/\\]/i, /backup|restore|seed/i];
const PAYMENT_PATTERNS: RegExp[] = [/pay|billing|invoice|checkout|cart|subscription|charge|refund|pricing/i];
const INTEGRATION_PATTERNS: RegExp[] = [/api[/\\]/, /client|gateway|proxy|webhook|queue|event|broker|grpc|graphql/i];
const USER_FACING_PATTERNS: RegExp[] = [/component|page|view|screen|widget|layout|router|navigation|form|checkout|dashboard/i];

export function matchesAny(path: string, patterns: RegExp[]): RegExp | undefined {
  return patterns.find((p) => p.test(path));
}

export interface FactorComputation {
  id: RiskFactorId;
  value: number;
  reasons: string[];
}

/** businessCriticality: payment/auth/core-domain presence, explicit criticalPaths config. */
export function computeBusinessCriticality(input: RiskInput): FactorComputation {
  const reasons: string[] = [];
  let value = 0.2; // baseline: any change carries some business relevance
  const payment = input.changedFiles.filter((f) => matchesAny(f.path, PAYMENT_PATTERNS));
  if (payment.length > 0) {
    value = Math.max(value, 0.95);
    reasons.push(`payment logic changed (${payment.map((f) => f.path).slice(0, 3).join(', ')})`);
  }
  const auth = input.changedFiles.filter((f) => f.area === 'auth');
  if (auth.length > 0) {
    value = Math.max(value, 0.85);
    reasons.push(`authentication boundary touched (${auth.length} file${auth.length > 1 ? 's' : ''})`);
  }
  if (input.criticalPaths && input.criticalPaths.length > 0) {
    const hitCritical = input.changedFiles.filter((f) => input.criticalPaths?.some((p) => f.path.includes(p)) ?? false);
    if (hitCritical.length > 0) {
      value = Math.max(value, 0.9);
      reasons.push(`files matched configured critical paths (${hitCritical.length})`);
    }
  }
  if (input.changedFiles.some((f) => f.area === 'db')) {
    value = Math.max(value, 0.7);
    reasons.push('data model files changed');
  }
  if (reasons.length === 0) {
    reasons.push('no business-critical markers in change set (baseline criticality)');
  }
  return { id: 'businessCriticality', value, reasons };
}

/** changeSurface: breadth of the diff — files touched and total churn. */
export function computeChangeSurface(input: RiskInput): FactorComputation {
  const reasons: string[] = [];
  const fileCount = input.changedFiles.length;
  const churn = (input.addedLines ?? 0) + (input.removedLines ?? 0);
  // Saturating functions: 1 file ≈ 0.15, ≥12 files → 1.0; churn ≥800 lines → 1.0.
  const byFiles = Math.min(1, fileCount / 12);
  const byChurn = Math.min(1, churn / 800);
  const value = fileCount > 0 ? Math.max(byFiles * 0.7 + byChurn * 0.3, 0.1) : 0;
  if (fileCount > 0) reasons.push(`${fileCount} file${fileCount > 1 ? 's' : ''} changed`);
  if (churn > 0) reasons.push(`${churn} lines added/removed`);
  if (fileCount === 0) reasons.push('empty change set');
  return { id: 'changeSurface', value, reasons };
}

/** defectHistory: normalized churn hotspots (files that historically needed fixes). */
export function computeDefectHistory(input: RiskInput): FactorComputation {
  const reasons: string[] = [];
  const history = input.defectHistory ?? {};
  const scores = input.changedFiles.map((f) => history[f.path]).filter((v): v is number => typeof v === 'number');
  const value = scores.length > 0 ? Math.max(...scores) : 0;
  if (scores.length > 0) {
    const hottest = input.changedFiles
      .filter((f) => (history[f.path] ?? 0) === value)
      .slice(0, 2)
      .map((f) => f.path);
    reasons.push(`historically unstable: ${hottest.join(', ')} (churn ${(value * 100).toFixed(0)}/100)`);
  } else {
    reasons.push('no defect history recorded for changed files');
  }
  return { id: 'defectHistory', value, reasons };
}

/** codeComplexity: proxy from churn size and module count — honest, documented approximation. */
export function computeCodeComplexity(input: RiskInput): FactorComputation {
  const reasons: string[] = [];
  const churn = (input.addedLines ?? 0) + (input.removedLines ?? 0);
  const modules = input.modulesTouched ?? input.changedFiles.length;
  const value = Math.min(1, churn / 500) * 0.6 + Math.min(1, modules / 10) * 0.4;
  reasons.push(`${churn} changed lines across ${modules} module${modules === 1 ? '' : 's'}`);
  if (churn > 500) reasons.push('large code churn raises review cost');
  return { id: 'codeComplexity', value, reasons };
}

/** integrationDepth: cross-boundary files (api clients, queues, webhooks, gateways). */
export function computeIntegrationDepth(input: RiskInput): FactorComputation {
  const reasons: string[] = [];
  const hits = input.changedFiles.filter((f) => matchesAny(f.path, INTEGRATION_PATTERNS));
  const value = hits.length > 0 ? Math.min(1, 0.5 + hits.length * 0.15) : 0.1;
  if (hits.length > 0) reasons.push(`integration surfaces touched: ${hits.slice(0, 3).map((f) => f.path).join(', ')}`);
  else reasons.push('no integration surface markers detected');
  if (input.boundarySignals && input.boundarySignals.length > 0) {
    reasons.push(`protected boundaries crossed: ${input.boundarySignals.join(', ')}`);
  }
  return { id: 'integrationDepth', value, reasons };
}

/** userImpact: user-facing surfaces (pages, forms, checkout, dashboards). */
export function computeUserImpact(input: RiskInput): FactorComputation {
  const reasons: string[] = [];
  const hits = input.changedFiles.filter((f) => matchesAny(f.path, USER_FACING_PATTERNS) || f.area === 'ui');
  const value = hits.length > 0 ? Math.min(1, 0.4 + hits.length * 0.12) : 0.15;
  if (hits.length > 0) reasons.push(`user-facing surfaces affected (${hits.length} file${hits.length > 1 ? 's' : ''})`);
  else reasons.push('no user-facing surface detected in change set');
  return { id: 'userImpact', value, reasons };
}

/** securitySensitivity: authn/authz/crypto/secret-adjacent changes. */
export function computeSecuritySensitivity(input: RiskInput): FactorComputation {
  const reasons: string[] = [];
  const hits = input.changedFiles.filter((f) => matchesAny(f.path, SECURITY_PATTERNS));
  const value = hits.length > 0 ? Math.min(1, 0.6 + hits.length * 0.1) : 0.05;
  if (hits.length > 0) reasons.push(`security-sensitive code changed: ${hits.slice(0, 3).map((f) => f.path).join(', ')}`);
  else reasons.push('no security-sensitive markers in change set');
  return { id: 'securitySensitivity', value, reasons };
}

/** dataSensitivity: migrations, schema, persistence-adjacent changes. */
export function computeDataSensitivity(input: RiskInput): FactorComputation {
  const reasons: string[] = [];
  const hits = input.changedFiles.filter((f) => matchesAny(f.path, DATA_PATTERNS));
  const migrations = input.changedFiles.filter((f) => /migrat/i.test(f.path));
  const value = migrations.length > 0 ? 0.95 : hits.length > 0 ? Math.min(1, 0.5 + hits.length * 0.1) : 0.05;
  if (migrations.length > 0) reasons.push(`database migration files present (${migrations.length}) — data-integrity tests required`);
  else if (hits.length > 0) reasons.push(`persistence-adjacent code changed (${hits.length} file${hits.length > 1 ? 's' : ''})`);
  else reasons.push('no data-layer markers in change set');
  return { id: 'dataSensitivity', value, reasons };
}

export function computeAllFactors(input: RiskInput): FactorComputation[] {
  return [
    computeBusinessCriticality(input),
    computeChangeSurface(input),
    computeDefectHistory(input),
    computeCodeComplexity(input),
    computeIntegrationDepth(input),
    computeUserImpact(input),
    computeSecuritySensitivity(input),
    computeDataSensitivity(input),
  ];
}
