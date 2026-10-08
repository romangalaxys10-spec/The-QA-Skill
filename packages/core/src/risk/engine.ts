import type { RiskInput, RiskAssessment, RiskTier, VerificationLabel, RiskFactorValue } from '../types.js';
import type { RiskWeights } from '../config.js';
import { computeAllFactors, FACTOR_IDS } from './factors.js';

/**
 * The documented risk algorithm.
 *
 *   Risk = Σ(weight_i × value_i) × 100
 *
 * where value_i ∈ [0,1] is the normalized intensity of factor i, derived from
 * observable signals with recorded reasons. Default weights:
 *
 *   businessCriticality 0.20 · changeSurface 0.15 · userImpact 0.15 ·
 *   defectHistory 0.12 · integrationDepth 0.12 · codeComplexity 0.10 ·
 *   securitySensitivity 0.08 · dataSensitivity 0.08
 *
 * Tiers: ≥80 critical · ≥60 high · ≥35 medium · else low.
 * The label is INFERRED: the score is deterministic given its inputs, but the
 * inputs are heuristics over the repository, not measurements of production.
 */

export const DEFAULT_WEIGHTS: RiskWeights = {
  businessCriticality: 0.2,
  changeSurface: 0.15,
  defectHistory: 0.12,
  codeComplexity: 0.1,
  integrationDepth: 0.12,
  userImpact: 0.15,
  securitySensitivity: 0.08,
  dataSensitivity: 0.08,
};

export interface RiskThresholds {
  critical: number;
  high: number;
  medium: number;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = { critical: 80, high: 60, medium: 35 };

export function tierFor(score: number, thresholds: RiskThresholds = DEFAULT_THRESHOLDS): RiskTier {
  if (score >= thresholds.critical) return 'critical';
  if (score >= thresholds.high) return 'high';
  if (score >= thresholds.medium) return 'medium';
  return 'low';
}

const RECOMMENDED_ACTION: Record<RiskTier, string> = {
  critical: 'Run full regression of affected areas plus targeted E2E of critical flows before merge; require two reviewers.',
  high: 'Run expanded regression of affected areas plus high-value E2E of the changed flows before merge.',
  medium: 'Run relevant regression of affected areas; E2E only for user-facing flows.',
  low: 'Fast PR suite (unit + lint) is sufficient; nightly suite covers the rest.',
};

export function assessRisk(
  input: RiskInput,
  opts: { weights?: RiskWeights; thresholds?: RiskThresholds } = {},
): RiskAssessment {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  // Validate weights sum to ~1; renormalize honestly if not (recorded, not silent).
  const sum = FACTOR_IDS.reduce((acc, id) => acc + (weights[id] ?? 0), 0);
  const norm = sum > 0 ? 1 / sum : 1;

  const factors: RiskFactorValue[] = computeAllFactors(input).map((f) => {
    const w = (weights[f.id] ?? 0) * norm;
    return {
      factor: f.id,
      value: f.value,
      weight: w,
      contribution: w * f.value * 100,
      reasons: f.reasons,
    };
  });

  const score = factors.reduce((acc, f) => acc + f.contribution, 0);
  let tier = tierFor(score, thresholds);

  // Documented tier floors: certain factor intensities impose a minimum tier
  // regardless of the weighted score. Rationale: a pure payment or migration
  // change can be small in lines yet never acceptable to treat as "low" —
  // the spec mandates heavy validation for payment (value ≥0.9) and
  // data-integrity attention for migrations (value ≥0.9); auth boundary
  // changes (value ≥0.8) and security-sensitive code (value ≥0.85) are at
  // least "high".
  const valueByFactor = new Map(factors.map((f) => [f.factor, f.value] as const));
  const business = valueByFactor.get('businessCriticality') ?? 0;
  const data = valueByFactor.get('dataSensitivity') ?? 0;
  const security = valueByFactor.get('securitySensitivity') ?? 0;
  const ORDER: readonly RiskTier[] = ['low', 'medium', 'high', 'critical'];
  const floorTier: RiskTier | undefined =
    business >= 0.9 || data >= 0.9 ? 'critical' :
    business >= 0.8 || security >= 0.85 ? 'high' : undefined;
  if (floorTier && ORDER.indexOf(tier) < ORDER.indexOf(floorTier)) {
    tier = floorTier;
  }

  const topContributors = [...factors].sort((a, b) => b.contribution - a.contribution);

  const explanation = renderExplanation(score, tier, topContributors);

  return {
    score: Math.round(score * 10) / 10,
    tier,
    factors,
    topContributors,
    explanation,
    label: 'INFERRED',
  };
}

/** The human-readable contributor format:
 *   Risk: 91/100
 *   + payment logic changed
 *   + …
 *   → Run full checkout regression before merge.
 */
export function renderExplanation(score: number, tier: RiskTier, contributors: RiskFactorValue[]): string {
  const lines: string[] = [`Risk: ${Math.round(score)}/100 (${tier})`];
  const shown = contributors.filter((c) => c.contribution >= 3).slice(0, 5);
  for (const c of shown) {
    for (const reason of c.reasons.slice(0, 2)) {
      lines.push(`+ ${reason}`);
    }
  }
  lines.push(`→ ${RECOMMENDED_ACTION[tier]}`);
  return lines.join('\n');
}
