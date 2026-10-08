import type { GoldenRule } from './types.js';

/**
 * The 15 Golden Rules. These are embedded in the orchestrator and mechanically
 * referenced by the healing policy, triage engine, and generation pipeline.
 * Each rule names where it is enforced — a rule without an enforcement point is
 * documentation, not governance.
 */
export const GOLDEN_RULES: readonly GoldenRule[] = [
  { id: 1, rule: 'Never weaken an assertion to make a test pass.', enforcedBy: 'heal/policy.ts — assertion-strength comparator blocks HIGH-tier application' },
  { id: 2, rule: 'Never hide a regression behind retries.', enforcedBy: 'triage/classify.ts — retry-pass with relevant change still classifies REAL_REGRESSION' },
  { id: 3, rule: 'Never use arbitrary sleeps as first fix.', enforcedBy: 'quality/score.ts — determinism dimension penalizes waitForTimeout/sleep' },
  { id: 4, rule: 'Never claim verification without execution evidence.', enforcedBy: 'labels.ts — CONFIRMED requires OBSERVED evidence; release gate blocks on evidenceComplete=false' },
  { id: 5, rule: 'Never generate massive redundant E2E suites.', enforcedBy: 'impact/select.ts — pyramid policy penalizes e2e when lower layers cover the change' },
  { id: 6, rule: 'Never destroy test isolation for speed.', enforcedBy: 'impact/select.ts — selection never merges stateful tests into shared sessions' },
  { id: 7, rule: 'Never auto-delete tests without strong evidence.', enforcedBy: 'heal/policy.ts — deletion proposals are never HIGH tier; duplication engine only recommends' },
  { id: 8, rule: 'Never expose secrets in test artifacts.', enforcedBy: 'data/masking + evidence/bundle.ts — secret patterns scrubbed before artifact write' },
  { id: 9, rule: 'Never perform destructive production actions without authorization.', enforcedBy: 'policies.ts — HIGH_RISK actions require explicit confirmation flag' },
  { id: 10, rule: 'Always distinguish product defects from test defects.', enforcedBy: 'triage/classify.ts — REAL_REGRESSION vs TEST_DEFECT decision table' },
  { id: 11, rule: 'Prefer the smallest test that catches the defect.', enforcedBy: 'impact/select.ts — priority ranking prefers lower-layer coverage' },
  { id: 12, rule: 'Preserve reproducibility.', enforcedBy: 'evidence/bundle.ts — every bundle carries metadata (commit, seed, env) sufficient to re-run' },
  { id: 13, rule: 'Preserve evidence.', enforcedBy: 'evidence/bundle.ts — append-only artifact layout; healing never rewrites history' },
  { id: 14, rule: 'Explain important decisions.', enforcedBy: 'types.ts ExplainableConclusion — every verdict carries evidence, confidence, assumptions' },
  { id: 15, rule: 'Optimize for signal, not test count.', enforcedBy: 'quality/score.ts — duplication dimension; selection minimizes redundant coverage' },
] as const;

export function goldenRuleById(id: number): GoldenRule | undefined {
  return GOLDEN_RULES.find((r) => r.id === id);
}
