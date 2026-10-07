import {
  ACTION_POLICIES,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  GOLDEN_RULES,
  LIFECYCLE_PHASES,
  QUALITY_DIMENSIONS,
  VERIFICATION_LABELS,
  describeLabel,
  goldenRuleById,
} from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import { UsageError } from '../args.js';
import { ok, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa explain <topic> — the platform's models explained from the code that
 * implements them. Content is sourced from core constants wherever they exist
 * (GOLDEN_RULES, ACTION_POLICIES, LIFECYCLE_PHASES, VERIFICATION_LABELS,
 * QUALITY_DIMENSIONS, DEFAULT_WEIGHTS/THRESHOLDS); the few constants that are
 * documented but not exported (triage rule order, flake bands, tier floors)
 * are rendered from their documented definitions.
 *
 * Unknown topic → lists the available topics, exit 2.
 */

export const EXPLAIN_TOPICS = ['risk', 'triage', 'healing', 'safety', 'golden-rules', 'lifecycle', 'labels', 'flake', 'quality'] as const;
export type ExplainTopic = (typeof EXPLAIN_TOPICS)[number];

export interface ExplainSection {
  heading: string;
  bullets: string[];
}

export interface ExplainData {
  topic: ExplainTopic;
  title: string;
  summary: string;
  sections: ExplainSection[];
}

/** The 12 triage categories in their documented decision-table order. */
const TRIAGE_RULE_ORDER: ReadonlyArray<{ n: number; category: string; rule: string }> = [
  { n: 1, category: 'DEPENDENCY_FAILURE', rule: 'module-resolution / version-conflict error patterns' },
  { n: 2, category: 'CONFIGURATION_FAILURE', rule: 'syntax/config-load errors that are not selector waits' },
  { n: 3, category: 'SELECTOR_FAILURE', rule: 'locator wait failure; selector literal in the diff raises confidence to 0.9' },
  { n: 4, category: 'ENVIRONMENT_FAILURE', rule: 'infra noise patterns with no changed code covered by the test' },
  { n: 5, category: 'NETWORK_FAILURE', rule: 'network-layer errors with the environment otherwise reachable' },
  { n: 6, category: 'TEST_DATA_DEFECT', rule: 'constraint violations / fixture problems' },
  { n: 7, category: 'TIMING_FAILURE', rule: 'explicit timeout without selector semantics (retry+history can re-route to FLAKE)' },
  { n: 8, category: 'FLAKE', rule: 'retry-pass, no relevant change, intermittent history' },
  { n: 9, category: 'REAL_REGRESSION', rule: 'retry-pass BUT covers changed code — golden rule 2, retries never wash a regression' },
  { n: 10, category: 'REAL_REGRESSION', rule: 'consistent assertion failure over changed code (0.92) — else TEST_DEFECT (0.7)' },
  { n: 11, category: 'ASSERTION_FAILURE', rule: 'assertion-shaped leftovers with mixed signals' },
  { n: 12, category: 'UNKNOWN', rule: 'honest default when nothing matched with confidence' },
];

function explain(topic: ExplainTopic): ExplainData {
  switch (topic) {
    case 'risk': {
      const weights = Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => `${k} ${v}`);
      return {
        topic,
        title: 'risk — the 8-factor weighted engine',
        summary: 'Risk = Σ(weightᵢ × valueᵢ) × 100 with valueᵢ ∈ [0,1]; deterministic, explainable, tier floors included.',
        sections: [
          { heading: 'Weights (DEFAULT_WEIGHTS)', bullets: weights },
          { heading: 'Tiers (DEFAULT_THRESHOLDS)', bullets: [
            `critical ≥ ${DEFAULT_THRESHOLDS.critical}`,
            `high ≥ ${DEFAULT_THRESHOLDS.high}`,
            `medium ≥ ${DEFAULT_THRESHOLDS.medium}`,
            'low — everything below medium',
          ] },
          { heading: 'Tier floors (documented in risk/engine.ts)', bullets: [
            'businessCriticality ≥ 0.9 or dataSensitivity ≥ 0.9 → floor critical (a small payment/migration diff is never "low")',
            'businessCriticality ≥ 0.8 or securitySensitivity ≥ 0.85 → floor high (auth boundaries, security-sensitive code)',
            'floors apply AFTER the weighted score — they raise, never lower',
          ] },
          { heading: 'Honesty', bullets: [
            'label is INFERRED: deterministic given its inputs, but inputs are repository heuristics, not production measurements',
            'weights that do not sum to 1 are renormalized (recorded, never silent)',
          ] },
        ],
      };
    }
    case 'triage': {
      const categories = [...new Set(TRIAGE_RULE_ORDER.map((r) => r.category))];
      return {
        topic,
        title: 'triage — the 12-category decision table',
        summary: 'Deterministic rules ordered by specificity; every verdict records supporting and contradicting signals. UNKNOWN is a real outcome.',
        sections: [
          { heading: 'The 12 categories', bullets: categories },
          { heading: 'Rule order (first match wins)', bullets: TRIAGE_RULE_ORDER.map((r) => `${r.n}. ${r.category} — ${r.rule}`) },
          { heading: 'Golden rules embedded', bullets: [
            'rule 2: a retry-pass does NOT clear a regression when the test covers changed code',
            'rule 10: product defects (REAL_REGRESSION) and test defects (TEST_DEFECT) are separate categories',
          ] },
        ],
      };
    }
    case 'healing': {
      const never = [1, 2, 3, 7].map((id) => {
        const rule = goldenRuleById(id);
        return rule ? `${rule.rule} (enforced by: ${rule.enforcedBy})` : `rule ${id}`;
      });
      return {
        topic,
        title: 'healing — confidence tiers',
        summary: 'HIGH applies automatically with evidence; MEDIUM proposes for review; LOW explains only and never modifies.',
        sections: [
          { heading: 'Tiers', bullets: [
            'HIGH — pure selector repair, new selector OBSERVED in a DOM snapshot, assertions untouched, zero violations',
            'MEDIUM — intent-preserving structural change (locator strategy, data construction); review before applying',
            'LOW — do not modify. Any golden-rule violation lands here; the proposal exists to explain what would be required',
          ] },
          { heading: 'The never-list (from GOLDEN_RULES)', bullets: never },
          { heading: 'Application policy', bullets: [
            'applyProposal: HIGH tier + zero violations only; original preserved as <file>.pre-heal.bak (golden rule 13)',
            'source drift (currentCode no longer present) refuses the patch — never a blind replace',
            'every apply/reject is recorded in the learning store with an explicit effect',
          ] },
        ],
      };
    }
    case 'safety': {
      return {
        topic,
        title: 'safety — the ACTION_POLICIES registry',
        summary: 'Every platform action is classified READ_ONLY / LOW_RISK_WRITE / HIGH_RISK; HIGH_RISK requires an explicit confirmation flag.',
        sections: [
          { heading: 'Registry', bullets: ACTION_POLICIES.map((p) => `${p.action} [${p.safety}]${p.requiresFlag ? ` (requires ${p.requiresFlag})` : ''} — ${p.rationale}`) },
          { heading: 'Defaults', bullets: [
            'unknown read-shaped actions classify READ_ONLY; every other unknown is HIGH_RISK until registered',
            'assertAuthorized throws unless the confirmation flag accompanied the call',
          ] },
        ],
      };
    }
    case 'golden-rules': {
      return {
        topic,
        title: 'golden-rules — the 15 rules',
        summary: 'Each rule names its mechanical enforcement point — a rule without enforcement is documentation, not governance.',
        sections: [
          { heading: 'Rules', bullets: GOLDEN_RULES.map((r) => `${r.id}. ${r.rule} — enforced by ${r.enforcedBy}`) },
        ],
      };
    }
    case 'lifecycle': {
      return {
        topic,
        title: 'lifecycle — the 12 phases',
        summary: 'Every QA task walks DISCOVER → … → LEARN; the tracker refuses phase skipping, so "user asked for tests → write Playwright code" jumps are impossible.',
        sections: [
          { heading: 'Phases', bullets: LIFECYCLE_PHASES.map((p, i) => `${i + 1}. ${p}`) },
          { heading: 'Mandatory guard', bullets: [
            'mandatory phases (DISCOVER, PLAN, EXECUTE, TRIAGE, VERIFY, MEASURE) refuse skip() under every orchestration policy',
            'each phase has documented preconditions — begin() throws LifecycleError naming the unmet phases',
            'a skipped optional phase requires a reason; silent skipping is forbidden',
          ] },
        ],
      };
    }
    case 'labels': {
      return {
        topic,
        title: 'labels — verification strength',
        summary: 'Every claim carries one of five labels; CONFIRMED requires OBSERVED evidence; composite claims are as weak as their weakest link.',
        sections: [
          { heading: 'The five labels (strongest first)', bullets: [...VERIFICATION_LABELS].reverse().map((l) => `${l} — ${describeLabel(l)}`) },
          { heading: 'Combination rules', bullets: [
            'strongestLabel — the best honest label for a claim across evidence',
            'weakestLabel — used for chains: a pipeline is as weak as its weakest link',
            'canConfirm — true only when at least one evidence item is OBSERVED or better',
          ] },
        ],
      };
    }
    case 'flake': {
      return {
        topic,
        title: 'flake — the documented formula',
        summary: 'score = 40×failRate + 25×retrySignal + 20×intermittency + 15×envSpread, with reasons attached to every score.',
        sections: [
          { heading: 'Components', bullets: [
            'failRate — fraction of failed outcomes in the window (0..1)',
            'retrySignal — min(1, retryCount / 5)',
            'intermittency — alternating pass/fail pattern strength (direction changes / opportunities)',
            'envSpread — min(1, distinctFailingEnvs/3)×0.6 + min(1, distinctFailingBrowsers/3)×0.4',
          ] },
          { heading: 'Verdict bands', bullets: [
            '< 20 stable',
            '< 45 suspect',
            '< 70 flaky',
            '≥ 70 critical_flaky',
          ] },
          { heading: 'Honesty', bullets: [
            'label OBSERVED only with ≥ 5 outcomes in the window; fewer outcomes stay INFERRED',
            'failures confined to one env/browser are called out as possibly environment-specific',
          ] },
        ],
      };
    }
    case 'quality': {
      return {
        topic,
        title: 'quality — the 17 dimensions',
        summary: 'Static, explainable deductions (never a bare number); weights sum to 100.',
        sections: [
          { heading: 'Dimensions (weight)', bullets: QUALITY_DIMENSIONS.map((d) => `${d.id} (${d.weight}) — ${d.description}`) },
          { heading: 'Honesty', bullets: [
            'the label stays INFERRED: static analysis flags only what it can see in the source',
            'suite health composes 10 weighted components; unmeasured components score 0 with a note, never skipped silently',
          ] },
        ],
      };
    }
  }
}

async function run(ctx: CommandContext): Promise<CommandResult<ExplainData>> {
  const topic = ctx.positionals[0] as ExplainTopic | undefined;
  if (topic === undefined || !EXPLAIN_TOPICS.includes(topic)) {
    throw new UsageError(
      topic === undefined ? 'explain requires a topic' : `unknown topic "${topic}"`,
      `available topics: ${EXPLAIN_TOPICS.join(', ')}`,
    );
  }
  const data = explain(topic);

  ctx.logger.banner(`explain — ${data.title}`);
  ctx.logger.info(data.summary);
  for (const section of data.sections) {
    ctx.logger.info('');
    ctx.logger.info(`${section.heading}:`);
    for (const bullet of section.bullets) ctx.logger.info(`  · ${bullet}`);
  }

  return ok<ExplainData>(data, 'OBSERVED', EXIT_OK);
}

export const explainCommand: CommandSpec = {
  name: 'explain',
  summary: 'explain the platform models: risk, triage, healing, safety, golden-rules, lifecycle, labels, flake, quality',
  usage: 'qa explain <topic> [--json]',
  positionals: ['<topic>'],
  flags: [],
  run,
};
