import type { IntentKind, IntentPlan, IntentStep } from './types.js';
import { LIFECYCLE_PHASES } from '@the-qa-skill/core';
import type { LifecyclePhase } from '@the-qa-skill/core';

/**
 * Intent routing — the natural-language front door of the orchestrator.
 *
 * Classification is keyword-based and deliberately transparent: the first
 * matching rule wins (documented order below), and the rationale records which
 * keyword table fired. Unknown intents default to `explain`, a read-only
 * pipeline, so a vague request can never trigger execution.
 */

interface KindRule {
  kind: IntentKind;
  pattern: RegExp;
  matched: string;
}

/** Ordered rules — order matters, first match wins. Heal precedes triage so
 * "heal failures" routes to the healing pipeline instead of being captured by
 * the triage "failure" keyword. */
const KIND_RULES: readonly KindRule[] = [
  { kind: 'pr_review', pattern: /\b(?:this\s+)?pr\b|\bpull\s+request\b|\breview\b/i, matched: 'pull-request/review keyword' },
  { kind: 'nightly', pattern: /\bnightly\b/i, matched: 'nightly keyword' },
  { kind: 'release', pattern: /\brelease\b|\bship\b/i, matched: 'release/ship keyword' },
  { kind: 'generate', pattern: /\bgenerate\b|\bscaffold\b/i, matched: 'generate/scaffold keyword' },
  { kind: 'heal', pattern: /\bheal(?:ing|ed)?\b/i, matched: 'heal keyword' },
  { kind: 'triage', pattern: /\btriage\b|\bfailures?\b/i, matched: 'triage/failure keyword' },
  { kind: 'discover', pattern: /\bdiscover(?:y)?\b/i, matched: 'discover keyword' },
];

/** Per-kind step actions. Every kind plans all 12 lifecycle phases — the
 * tracker's precondition chain (EXECUTE requires VALIDATE, TRIAGE requires
 * OBSERVE, ...) makes partial walks impossible, so plans are honest full
 * walks with kind-tailored actions. */
const STEP_ACTIONS: Record<IntentKind, ReadonlyArray<readonly [LifecyclePhase, string]>> = {
  pr_review: [
    ['DISCOVER', 'discover repository stack and test inventory'],
    ['MODEL', 'build QA context and extract requirements from specs'],
    ['PLAN', 'assess change-set risk and select the smallest high-confidence test set'],
    ['GENERATE', 'check coverage gaps; scaffold tests only when gaps exist'],
    ['VALIDATE', 'validate selection reasons and changed-test quality'],
    ['EXECUTE', 'run the selected suites under the PR policy'],
    ['OBSERVE', 'collect test events and failure evidence bundles'],
    ['TRIAGE', 'classify failures into the 12 documented categories'],
    ['HEAL', 'apply HIGH-tier healing proposals when evidence supports them'],
    ['VERIFY', 'evaluate the release gate from triage and risk evidence'],
    ['MEASURE', 'aggregate quality measurements for the run'],
    ['LEARN', 'record triage lessons in the learning store'],
  ],
  nightly: [
    ['DISCOVER', 'discover repository stack and test inventory'],
    ['MODEL', 'build QA context and extract requirements from specs'],
    ['PLAN', 'assess recent change sets and plan the full regression suite'],
    ['GENERATE', 'check coverage gaps; scaffold tests only when gaps exist'],
    ['VALIDATE', 'validate the full-suite selection and test quality'],
    ['EXECUTE', 'run the full regression suite (nightly budget)'],
    ['OBSERVE', 'collect test events and failure evidence bundles'],
    ['TRIAGE', 'classify failures into the 12 documented categories'],
    ['HEAL', 'apply HIGH-tier healing proposals when evidence supports them'],
    ['VERIFY', 'evaluate the release gate from triage and risk evidence'],
    ['MEASURE', 'aggregate quality measurements for the run'],
    ['LEARN', 'record triage lessons in the learning store'],
  ],
  release: [
    ['DISCOVER', 'discover repository stack and test inventory'],
    ['MODEL', 'build QA context and extract requirements from specs'],
    ['PLAN', 'assess change-set risk and plan the release certification suite'],
    ['GENERATE', 'check coverage gaps; scaffold tests only when gaps exist'],
    ['VALIDATE', 'validate the certification selection and test quality'],
    ['EXECUTE', 'run the release certification suite'],
    ['OBSERVE', 'collect test events and failure evidence bundles'],
    ['TRIAGE', 'classify failures into the 12 documented categories'],
    ['HEAL', 'apply HIGH-tier healing proposals when evidence supports them'],
    ['VERIFY', 'compute the release gate ship/no-ship verdict'],
    ['MEASURE', 'aggregate quality measurements for the release record'],
    ['LEARN', 'record triage lessons in the learning store'],
  ],
  generate: [
    ['DISCOVER', 'discover repository stack and test inventory'],
    ['MODEL', 'extract the specification (requirements) to design tests from'],
    ['PLAN', 'run the deterministic test-design pipeline over the specification'],
    ['GENERATE', 'scaffold skipped vitest/playwright files from the test plan'],
    ['VALIDATE', 'statically validate generated scaffolds (rationale + structure)'],
    ['EXECUTE', 'run the existing suite to prove scaffolds break nothing'],
    ['OBSERVE', 'collect test events and failure evidence bundles'],
    ['TRIAGE', 'classify failures into the 12 documented categories'],
    ['HEAL', 'apply HIGH-tier healing proposals when evidence supports them'],
    ['VERIFY', 'evaluate the release gate from triage and risk evidence'],
    ['MEASURE', 'aggregate quality measurements for the run'],
    ['LEARN', 'record generation outcomes in the learning store'],
  ],
  triage: [
    ['DISCOVER', 'discover repository stack and test inventory'],
    ['MODEL', 'build QA context and load failure history'],
    ['PLAN', 'plan failure reproduction for the recorded failures'],
    ['GENERATE', 'no generation: triage reuses existing tests (gap check only)'],
    ['VALIDATE', 'validate the reproduction selection'],
    ['EXECUTE', 're-run the failing tests to gather fresh attempts'],
    ['OBSERVE', 'collect failure evidence bundles'],
    ['TRIAGE', 'classify failures into the 12 documented categories'],
    ['HEAL', 'apply HIGH-tier healing proposals when evidence supports them'],
    ['VERIFY', 'evaluate the release gate from triage evidence'],
    ['MEASURE', 'aggregate triage statistics for the run'],
    ['LEARN', 'record triage lessons in the learning store'],
  ],
  heal: [
    ['DISCOVER', 'discover repository stack and test inventory'],
    ['MODEL', 'build QA context and load failure history'],
    ['PLAN', 'plan healing for the triaged failures'],
    ['GENERATE', 'no generation: healing patches existing tests (gap check only)'],
    ['VALIDATE', 'validate healing proposals against the golden rules'],
    ['EXECUTE', 're-run healed tests to confirm the repair'],
    ['OBSERVE', 'collect post-healing test events'],
    ['TRIAGE', 'classify failures to produce healing candidates'],
    ['HEAL', 'propose patches; apply only HIGH-tier, zero-violation proposals'],
    ['VERIFY', 'evaluate the release gate from post-healing evidence'],
    ['MEASURE', 'aggregate healing statistics for the run'],
    ['LEARN', 'record healing outcomes in the learning store'],
  ],
  discover: [
    ['DISCOVER', 'discover repository stack and test inventory'],
    ['MODEL', 'build the QA context from discovery output'],
    ['PLAN', 'summarize inventory health and obvious gaps'],
    ['GENERATE', 'no generation for a read-only discovery run (gap check only)'],
    ['VALIDATE', 'validate discovery output completeness'],
    ['EXECUTE', 'read-only intent: plan commands without spawning (dry-run)'],
    ['OBSERVE', 'observe nothing: no execution in a discovery run'],
    ['TRIAGE', 'no failures expected in a discovery run'],
    ['HEAL', 'no healing in a read-only discovery run'],
    ['VERIFY', 'verify discovery output against the context model'],
    ['MEASURE', 'report inventory statistics'],
    ['LEARN', 'no lessons from a read-only discovery run'],
  ],
  explain: [
    ['DISCOVER', 'discover repository stack and test inventory'],
    ['MODEL', 'build the QA context to explain decisions against'],
    ['PLAN', 'assemble the explanation outline'],
    ['GENERATE', 'no generation for a read-only explain run (gap check only)'],
    ['VALIDATE', 'validate the explanation against recorded evidence'],
    ['EXECUTE', 'read-only intent: plan commands without spawning (dry-run)'],
    ['OBSERVE', 'observe nothing: no execution in an explain run'],
    ['TRIAGE', 'no failures expected in an explain run'],
    ['HEAL', 'no healing in a read-only explain run'],
    ['VERIFY', 'verify the explanation cites recorded evidence'],
    ['MEASURE', 'report explanation statistics'],
    ['LEARN', 'no lessons from a read-only explain run'],
  ],
};

/**
 * Classify a free-text intent into one of the eight pipeline kinds and produce
 * the planned step list. Deterministic: identical text always yields an
 * identical plan.
 */
export function routeIntent(intentText: string): IntentPlan {
  const text = intentText.toLowerCase();
  const rule = KIND_RULES.find((r) => r.pattern.test(intentText) || r.pattern.test(text));
  const kind: IntentKind = rule?.kind ?? 'explain';
  const rationale = rule
    ? `matched ${rule.matched} in the intent text → "${kind}" pipeline.`
    : `no known intent keyword matched → defaulting to "explain" (read-only, no execution) for: "${intentText.trim().slice(0, 80)}".`;

  const actions = STEP_ACTIONS[kind];
  const byPhase = new Map<LifecyclePhase, string>();
  for (const [phase, action] of actions) byPhase.set(phase, action);

  const steps: IntentStep[] = LIFECYCLE_PHASES.map((phase) => ({
    phase,
    action: byPhase.get(phase) ?? 'no action planned',
    status: 'planned' as const,
  }));

  return { kind, steps, rationale };
}
