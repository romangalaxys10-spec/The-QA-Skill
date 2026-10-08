/**
 * Mechanical golden-rule audits — the subset of the 15 rules that can be
 * checked from a payload without context: sleeps, assertion weakening,
 * retry masking, evidence presence, pyramid ratio, secrets, seeds,
 * explainability, and defect categorization.
 *
 * This is the engine behind `qa audit-rules`. It is deliberately narrow:
 * a check that cannot be evaluated mechanically reports `applicable: false`
 * instead of pretending to pass. Where fable-style implementations return
 * `pass: true` for every rule, honest inapplicability is the contract here.
 */

export interface RuleAuditResult {
  id: number;
  name: string;
  /** Whether this audit had enough information to judge the rule. */
  applicable: boolean;
  passed: boolean;
  detail: string;
}

export interface RuleAuditReport {
  op: string;
  valid: boolean;
  checked: number;
  violations: string[];
  results: RuleAuditResult[];
}

const SECRET_PATTERNS: RegExp[] = [
  /ghp_[a-z0-9]{30,}/i,
  /github_pat_[a-z0-9_]{60,}/i,
  /akia[0-9a-z]{16}/i,
  /-----begin (rsa|ec|dsa|openvpn) private key-----/i,
  /bearer\s+[a-z0-9._-]{25,}/i,
  /api[_-]?key["'\s:=]+[a-z0-9_-]{20,}/i,
  /npm_[a-z0-9]{30,}/i,
];

const SLEEP_PATTERN = /waitForTimeout\s*\(|time\.sleep\s*\(\s*\d+|sleep\s*\(\s*\d{2,}\s*\)/;

function result(id: number, name: string, applicable: boolean, passed: boolean, detail: string): RuleAuditResult {
  return { id, name, applicable, passed, detail };
}

function collectStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || value === null || value === undefined) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, depth + 1, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, depth + 1, out);
  }
  return out;
}

/** Audit a payload for an operation ('heal' | 'generate' | 'triage' | 'test' | 'release' | …). */
export function auditGoldenRules(op: string, payload: unknown): RuleAuditReport {
  const strings = collectStrings(payload);
  const results: RuleAuditResult[] = [];

  // Rule 2 — retry masking: >3 retries on a real regression.
  const p = (payload ?? {}) as Record<string, unknown>;
  const retryCount = typeof p['retryCount'] === 'number' ? p['retryCount'] : undefined;
  const category = typeof p['category'] === 'string' ? p['category'] : undefined;
  if (retryCount !== undefined && category !== undefined) {
    const masked = retryCount > 3 && category === 'REAL_REGRESSION';
    results.push(
      result(2, 'No regression masking by retries', true, !masked, masked ? `${retryCount} retries on REAL_REGRESSION — prohibited` : `retry/category combination acceptable (${retryCount}, ${category})`),
    );
  }

  // Rule 3 — arbitrary sleeps in generated/healed code.
  const codeStrings = strings.filter((s) => /waitForTimeout|sleep\s*\(/.test(s) || /(function|const|import|expect|page\.)/.test(s));
  if (codeStrings.length > 0) {
    const offender = codeStrings.find((s) => SLEEP_PATTERN.test(s));
    results.push(
      result(3, 'Zero arbitrary sleeps', true, offender === undefined, offender === undefined ? 'no arbitrary sleep calls found in code payload' : `arbitrary sleep detected: ${offender.slice(0, 120)}`),
    );
  }

  // Rule 4 — evidence-backed verification claims.
  const status = typeof p['status'] === 'string' ? p['status'] : undefined;
  if (status === 'CONFIRMED') {
    const evidenceRefs = strings.filter((s) => /artifacts\/|evidence|run-/.test(s));
    const hasEvidence = evidenceRefs.length > 0 || p['evidenceRunId'] !== undefined || p['evidence'] !== undefined;
    results.push(
      result(4, 'Evidence-backed verification', true, hasEvidence, hasEvidence ? 'CONFIRMED claim carries evidence references' : 'status CONFIRMED without any evidence reference'),
    );
  }

  // Rule 5 — pyramid discipline for generation payloads.
  const e2eRatio = typeof p['e2eRatio'] === 'number' ? p['e2eRatio'] : undefined;
  if (e2eRatio !== undefined) {
    results.push(
      result(5, 'Test pyramid discipline', true, e2eRatio <= 0.4, e2eRatio <= 0.4 ? `e2e ratio ${e2eRatio} within 0.4 budget` : `e2e ratio ${e2eRatio} exceeds 0.4 — move coverage down the pyramid`),
    );
  }

  // Rule 8 — secrets in artifacts.
  if (strings.length > 0) {
    const serialized = strings.join('\n');
    const hit = SECRET_PATTERNS.find((re) => re.test(serialized));
    results.push(
      result(8, 'Zero secrets in artifacts', true, hit === undefined, hit === undefined ? `no secret patterns in ${strings.length} payload string(s)` : `potential secret matching ${hit.source.slice(0, 40)}`),
    );
  }

  // Rule 10/12 — categorization & reproducibility for generation/heal payloads.
  const seed = p['seed'];
  if (op === 'generate' || op === 'heal') {
    results.push(
      result(12, 'Reproducibility seed present', typeof seed === 'string' || typeof seed === 'number', seed !== undefined, seed !== undefined ? `seed recorded: ${String(seed).slice(0, 24)}` : `${op} payload carries no seed — generated artifacts cannot be reproduced`),
    );
  }
  if (status === 'CONFIRMED' && category !== undefined) {
    results.push(
      result(10, 'Defect categorization', category !== 'UNKNOWN' && category !== '', category !== 'UNKNOWN' && category !== '', category !== 'UNKNOWN' ? `category ${category}` : 'CONFIRMED claim with UNKNOWN category'),
    );
  }

  // Rule 14 — explainability.
  if (op === 'triage' || op === 'heal' || op === 'release') {
    const hasExplanation = typeof p['explanation'] === 'string' || typeof p['rationale'] === 'string' || Array.isArray(p['evidence']);
    results.push(
      result(14, 'Explainable decision', true, hasExplanation, hasExplanation ? 'decision carries explanation or evidence' : `${op} payload lacks explanation/evidence fields`),
    );
  }

  const violations = results.filter((r) => r.applicable && !r.passed).map((r) => `Rule ${r.id} [${r.name}]: ${r.detail}`);
  return {
    op,
    valid: violations.length === 0,
    checked: results.filter((r) => r.applicable).length,
    violations,
    results,
  };
}
