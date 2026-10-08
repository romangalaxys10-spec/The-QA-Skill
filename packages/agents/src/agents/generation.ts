import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@the-qa-skill/core';
import type { ChangeArea, RiskTier, TheQAConfig } from '@the-qa-skill/core';
import { slugify } from './requirements.js';
import type { FeatureSpec, ScaffoldResult, TestCase, TestCaseCategory, TestPlan } from '../types.js';

/**
 * GenerationAgent — THE deterministic test-design pipeline.
 *
 * `plan(spec)` enumerates, per acceptance criterion:
 *   1. one positive case (unit layer; promoted to e2e only when the spec area
 *      is `ui` AND the criterion describes a user flow);
 *   2. one negative case (invalid input per the criterion's verbs);
 *   3. boundary cases from the criterion's nouns (zero/one/max/min/empty/
 *      null/duplicate/missing/expired/malformed — those that make sense, with
 *      a generic empty/maximum pair as the floor; the floor guarantees at
 *      least two boundary cases per criterion, so a 3-criterion spec always
 *      yields ≥ 10 cases);
 * plus spec-level heuristics that fire on documented triggers:
 *   state transitions (state/status/role vocabulary), concurrency (duplicate
 *   submit + idempotency for payment/order/submit/checkout), security
 *   (authn/authz/IDOR/injection — one case per vector when area is
 *   auth/api/payment), accessibility (role/label/contrast/keyboard when area
 *   is ui), time (timezone + expiry for expire/schedule/session/token),
 *   integration (api/webhook/queue), resilience (timeout/retry/malformed
 *   upstream).
 *
 * Priority table: security cases → critical; payment-area specs → critical;
 * negative/boundary/concurrency/integration/resilience → high;
 * positive/state/accessibility/time → medium.
 *
 * Every case carries a rationale; heuristicNotes records exactly which
 * heuristics fired. The plan label is INFERRED by construction.
 *
 * `scaffold(plan, outDir)` emits ONE vitest unit file per feature
 * (`<feature>.generated.test.ts`) of intentionally-skipped `it.skip` cases —
 * honest test debt, each name encoding the Given/When/Then contract — plus a
 * playwright `test.skip` spec when the plan contains e2e-layer cases. It
 * never overwrites an existing file unless `force` is set, and `dryRun`
 * records would-be bytes without touching the disk.
 */

const USER_FLOW_RE = /\b(user|users|flow|journey|screen|page|navigate|click|visit|ui)\b/i;
const STATE_RE = /\b(state|status|role|roles)\b/i;
const CONCURRENCY_RE = /\b(payment|order|orders|submit|submission|checkout)\b/i;
const TIME_RE = /\b(expire[sd]?|expiry|expiration|schedule|scheduled|session|token)\b/i;
const INTEGRATION_KEYWORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bapi\b|\brest\b|\bgraphql\b|\bendpoint\b/i, 'api'],
  [/\bwebhook\b/i, 'webhook'],
  [/\bqueue\b|\bbroker\b|\bmessaging\b|\bevent bus\b/i, 'queue'],
];
const RESILIENCE_RE =
  /\b(timeout|timed?\s?out|retry|retries|retried|upstream|downstream|unavailable|network|disconnect|flaky)\b/i;

interface BoundaryValue {
  label: string;
  whenPhrase: string;
}

/** Noun-driven boundary extraction: first match per rule, capped at 3 per criterion. */
const BOUNDARY_RULES: ReadonlyArray<readonly [RegExp, BoundaryValue]> = [
  [/\b(length|size|count|quantity|amount|limit|minimum|min|at least|at most|zero|none)\b/i, { label: 'zero', whenPhrase: 'input at the zero/minimum boundary' }],
  [/\b(length|size|count|quantity|amount|limit|maximum|max|over|more than|greater than|at most)\b/i, { label: 'maximum', whenPhrase: 'input at the maximum allowed boundary' }],
  [/\bempty\b/i, { label: 'empty', whenPhrase: 'an empty value' }],
  [/\b(null|undefined)\b/i, { label: 'null', whenPhrase: 'a null/undefined value' }],
  [/\b(duplicate|unique|already exists|conflict)\b/i, { label: 'duplicate', whenPhrase: 'a duplicate of an existing value' }],
  [/\b(requires?|required|missing|absent)\b/i, { label: 'missing', whenPhrase: 'a missing required value' }],
  [/\bexpir(ed|y|es|ation)\b/i, { label: 'expired', whenPhrase: 'an expired value' }],
  [/\b(malformed|invalid format|not valid|improperly formatted|parse)\b/i, { label: 'malformed', whenPhrase: 'a malformed value' }],
  [/\b(one|single)\b/i, { label: 'one', whenPhrase: 'exactly one item' }],
];

const GENERIC_BOUNDARIES: readonly BoundaryValue[] = [
  { label: 'empty', whenPhrase: 'an empty value' },
  { label: 'maximum', whenPhrase: 'the maximum allowed value' },
];

type DraftCase = Omit<TestCase, 'id'>;

export class GenerationAgent {
  /** The resolved configuration (explicit option or loaded from theqa.config.json). */
  public readonly config: TheQAConfig;

  constructor(
    private readonly root: string,
    opts: { config?: TheQAConfig } = {},
  ) {
    this.config = opts.config ?? loadConfig(root).config;
  }

  /**
   * Design the test plan for a feature spec. Deterministic: identical specs
   * produce identical case ids, order, and counts.
   */
  plan(spec: FeatureSpec): TestPlan {
    const slug = slugify(spec.name, 40);
    const area: ChangeArea = spec.area ?? 'unknown';
    const corpus = [spec.name, spec.description ?? '', ...spec.acceptanceCriteria, ...(spec.businessRules ?? [])].join('\n');
    const criteria = spec.acceptanceCriteria.length > 0 ? spec.acceptanceCriteria : spec.description ? [spec.description] : [];
    const notes: string[] = [];
    const drafts: DraftCase[] = [];

    if (criteria.length === 0) {
      notes.push('no acceptance criteria provided — nothing was designed (honest empty plan)');
    }

    // ---- 1. positive: one happy path per criterion -------------------------
    let promotedToE2E = 0;
    for (const criterion of criteria) {
      const e2e = area === 'ui' && USER_FLOW_RE.test(criterion);
      if (e2e) promotedToE2E += 1;
      drafts.push({
        title: `happy path: ${clip(criterion, 80)}`,
        category: 'positive',
        layer: e2e ? 'e2e' : 'unit',
        given: [
          `the feature "${spec.name}" is implemented per specification`,
          `the preconditions of the criterion hold: "${clip(criterion, 120)}"`,
        ],
        when: 'valid input satisfying the criterion is processed',
        then: `the observed outcome matches the criterion: "${clip(criterion, 120)}"`,
        priority: 'medium',
        rationale: e2e
          ? 'positive heuristic: the criterion describes a ui user flow, so the happy path must be proven end-to-end, not just at unit level'
          : `positive heuristic: every acceptance criterion needs one happy-path case proving the specified outcome${spec.businessRules?.length ? '; pinned to unit layer because business rules are cheapest to verify there' : ''}`,
      });
    }
    notes.push(`positive: ${criteria.length} case(s), one per acceptance criterion`);
    if (promotedToE2E > 0) notes.push(`layer promotion: ${promotedToE2E} positive case(s) promoted to e2e (ui user-flow criteria)`);

    // ---- 2. negative: one invalid-input case per criterion -----------------
    for (const criterion of criteria) {
      drafts.push({
        title: `rejects invalid input: ${clip(criterion, 80)}`,
        category: 'negative',
        layer: 'unit',
        given: ['the system is ready to process input for the criterion'],
        when: 'input that violates the criterion is submitted',
        then: 'the system rejects the input with a validation error and applies no partial effect',
        priority: 'high',
        rationale: `negative heuristic: the criterion's verbs imply a rejection contract — input violating "${clip(criterion, 100)}" must be refused, never silently accepted`,
      });
    }
    if (criteria.length > 0) notes.push(`negative: ${criteria.length} case(s), one invalid-input case per criterion`);

    // ---- 3. boundary: noun-driven values, generic floor --------------------
    let boundaryCount = 0;
    for (const criterion of criteria) {
      for (const value of boundaryValuesFor(criterion)) {
        drafts.push({
          title: `boundary ${value.label}: ${clip(criterion, 80)}`,
          category: 'boundary',
          layer: 'unit',
          given: ['the system is in a valid state for the criterion'],
          when: `${value.whenPhrase} is submitted`,
          then: 'the system behaves per the criterion at the boundary without crashing or corrupting state',
          priority: 'high',
          rationale: `boundary heuristic: "${value.label}" is an edge of the input domain implied by the criterion's nouns; edges are where off-by-one and truncation defects live`,
        });
        boundaryCount += 1;
      }
    }
    if (criteria.length > 0 && boundaryCount < 2) {
      for (const value of GENERIC_BOUNDARIES.slice(0, 2 - boundaryCount)) {
        drafts.push({
          title: `boundary ${value.label}: ${clip(spec.name, 80)}`,
          category: 'boundary',
          layer: 'unit',
          given: ['the system is in a valid state for the feature'],
          when: `${value.whenPhrase} is submitted for the feature's operation`,
          then: 'the system behaves per the specification without crashing or corrupting state',
          priority: 'high',
          rationale: `boundary heuristic (generic floor): "${value.label}" is a universal input-domain edge applied because the criterion nouns suggested no more specific boundary`,
        });
        boundaryCount += 1;
      }
      notes.push('boundary: generic empty/maximum floor applied (criterion nouns suggested no specific boundaries)');
    }
    if (boundaryCount > 0) notes.push(`boundary: ${boundaryCount} case(s) from zero/one/max/min/empty/null/duplicate/missing/expired/malformed values`);

    // ---- 4. state transitions ----------------------------------------------
    if (STATE_RE.test(corpus)) {
      const stateCriteria = criteria.filter((c) => STATE_RE.test(c)).slice(0, 3);
      const targets: string[] = stateCriteria.length > 0 ? stateCriteria : [spec.name];
      for (const target of targets) {
        drafts.push({
          title: `state transitions: ${clip(target, 80)}`,
          category: 'state',
          layer: 'unit',
          given: [`the entity described by "${clip(target, 100)}" exists in its initial documented state`],
          when: 'each documented transition is applied, then an undocumented transition is attempted',
          then: 'documented transitions are accepted and the undocumented transition is rejected with the current state preserved',
          priority: 'medium',
          rationale: 'state heuristic: state/status/role vocabulary detected — every state machine needs an illegal-transition case, not just reachable ones',
        });
      }
      notes.push(`state: fired (state/status/role vocabulary) — ${targets.length} transition case(s)`);
    }

    // ---- 5. concurrency ------------------------------------------------------
    if (CONCURRENCY_RE.test(corpus)) {
      drafts.push({
        title: 'concurrency: duplicate submission racing',
        category: 'concurrency',
        layer: 'integration',
        given: ['two identical requests are prepared for the same operation'],
        when: 'both submissions race concurrently',
        then: 'exactly one side effect occurs and the loser receives an idempotent success or an explicit conflict error',
        priority: 'high',
        rationale: 'concurrency heuristic: payment/order/submit/checkout vocabulary detected — duplicate submits are the classic double-charge defect',
      });
      drafts.push({
        title: 'concurrency: idempotent retry',
        category: 'concurrency',
        layer: 'integration',
        given: ['a request completed successfully with a known idempotency key'],
        when: 'the same request is retried with the same key',
        then: 'the outcome is identical to a single submission and no additional side effect occurs',
        priority: 'high',
        rationale: 'concurrency heuristic: idempotency is the contract that makes safe retries possible for money- and order-shaped operations',
      });
      notes.push('concurrency: fired (payment/order/submit/checkout vocabulary) — duplicate-submit + idempotency cases');
    }

    // ---- 6. security (auth/api/payment areas) -------------------------------
    if (area === 'auth' || area === 'api' || area === 'payment') {
      const vectors: ReadonlyArray<readonly [string, string, string]> = [
        ['authentication', 'a request is made without valid credentials', 'access is denied with an authentication error and no protected data is returned'],
        ['authorization', 'a valid user requests a resource outside their granted permissions', 'access is denied with an authorization error'],
        ['IDOR', 'a valid user references another tenant\'s object id directly', 'the system returns not-found/forbidden — never the other tenant\'s data'],
        ['injection', 'input contains injection payloads (SQL/script/command)', 'the payload is treated as inert data; nothing executes and no internal error text leaks'],
      ];
      for (const [vector, when, then] of vectors) {
        drafts.push({
          title: `security: ${vector} on ${clip(spec.name, 60)}`,
          category: 'security',
          layer: 'security',
          given: [`${spec.name} is reachable through its exposed boundary`],
          when,
          then,
          priority: 'critical',
          rationale: `security heuristic: area "${area}" exposes the ${vector} boundary — one dedicated case per applicable vector (authn/authz/IDOR/injection), because a missing negative test here is a vulnerability, not a gap`,
        });
      }
      notes.push(`security: fired (area ${area}) — authentication/authorization/IDOR/injection vector cases`);
    }

    // ---- 7. accessibility (ui area) ------------------------------------------
    if (area === 'ui') {
      const a11y: ReadonlyArray<readonly [string, string, string]> = [
        ['role', 'the rendered screen is inspected', 'every interactive element exposes an accessible role'],
        ['label', 'the rendered screen is inspected', 'every input control has a programmatic label'],
        ['contrast', 'the rendered screen is inspected', 'text meets WCAG AA contrast ratios in default and focused states'],
        ['keyboard', 'the screen is operated with the keyboard alone', 'every interaction is reachable and operable without a pointer'],
      ];
      for (const [aspect, when, then] of a11y) {
        drafts.push({
          title: `accessibility: ${aspect} on ${clip(spec.name, 60)}`,
          category: 'accessibility',
          layer: 'a11y',
          given: [`${spec.name} renders successfully`],
          when,
          then,
          priority: 'medium',
          rationale: `accessibility heuristic: area "ui" mandates the role/label/contrast/keyboard matrix — accessible semantics are a functional requirement of the interface`,
        });
      }
      notes.push('accessibility: fired (area ui) — role/label/contrast/keyboard cases');
    }

    // ---- 8. time --------------------------------------------------------------
    if (TIME_RE.test(corpus)) {
      drafts.push({
        title: `time: timezone handling in ${clip(spec.name, 60)}`,
        category: 'time',
        layer: 'unit',
        given: ['the operation is performed with inputs constructed in two different timezones'],
        when: 'the same logical instant is submitted from each timezone',
        then: 'timestamps are interpreted in the documented timezone and both submissions agree on the outcome',
        priority: 'medium',
        rationale: 'time heuristic: expiry/schedule/session/token vocabulary detected — timezone misinterpretation is the most common silent time defect',
      });
      drafts.push({
        title: `time: expiry enforcement in ${clip(spec.name, 60)}`,
        category: 'time',
        layer: 'unit',
        given: ['a time-bound resource exists with a known expiry instant'],
        when: 'the resource is used one instant after expiry',
        then: 'the operation is rejected as expired with no partial effect',
        priority: 'medium',
        rationale: 'time heuristic: expiry boundaries must be tested at instant granularity — a day-granular test hides off-by-one-second defects',
      });
      notes.push('time: fired (expire/schedule/session/token vocabulary) — timezone + expiry cases');
    }

    // ---- 9. integration ---------------------------------------------------------
    let integrationCount = 0;
    for (const [pattern, keyword] of INTEGRATION_KEYWORDS) {
      if (integrationCount >= 3) break;
      if (pattern.test(corpus)) {
        drafts.push({
          title: `integration: ${keyword} contract for ${clip(spec.name, 60)}`,
          category: 'integration',
          layer: 'integration',
          given: [`the ${keyword} boundary is available and configured`],
          when: `a valid ${keyword} interaction is exercised end-to-end`,
          then: 'the contract holds (request/response shape and semantics) and failures surface as a typed integration error',
          priority: 'high',
          rationale: `integration heuristic: "${keyword}" vocabulary detected — the boundary contract must be verified against the real shape, not a mock's imagination`,
        });
        integrationCount += 1;
      }
    }
    if (integrationCount > 0) notes.push(`integration: fired (api/webhook/queue vocabulary) — ${integrationCount} contract case(s)`);

    // ---- 10. resilience -----------------------------------------------------------
    if (RESILIENCE_RE.test(corpus) || integrationCount > 0) {
      drafts.push({
        title: `resilience: dependency timeout for ${clip(spec.name, 60)}`,
        category: 'resilience',
        layer: 'integration',
        given: ['a dependency responds slower than the configured deadline'],
        when: 'the deadline elapses',
        then: 'the operation fails fast with a timeout error and leaves no partial state behind',
        priority: 'high',
        rationale: 'resilience heuristic: timeout/retry/upstream vocabulary (or an integration boundary) detected — behavior at the deadline must be specified, never emergent',
      });
      drafts.push({
        title: `resilience: transient failure retry for ${clip(spec.name, 60)}`,
        category: 'resilience',
        layer: 'integration',
        given: ['a dependency fails transiently on the first attempt'],
        when: 'the operation is retried within the retry budget',
        then: 'the retry succeeds exactly once and no duplicate side effect is produced',
        priority: 'high',
        rationale: 'resilience heuristic: retries without idempotent semantics turn transient failures into duplicated data',
      });
      notes.push('resilience: fired — timeout + transient-retry cases');
    }

    // ---- finalize: ids, priorities, summary ---------------------------------------
    const counters = new Map<TestCaseCategory, number>();
    const cases: TestCase[] = drafts.map((d) => {
      const n = (counters.get(d.category) ?? 0) + 1;
      counters.set(d.category, n);
      return { ...d, id: `${slug}-${d.category}-${n}`, priority: priorityFor(d.category, d.priority, area) };
    });

    const byCategory: Record<string, number> = {};
    const byLayer: Record<string, number> = {};
    for (const c of cases) {
      byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
      byLayer[c.layer] = (byLayer[c.layer] ?? 0) + 1;
    }

    return {
      feature: spec.name,
      cases,
      summary: { total: cases.length, byCategory, byLayer },
      heuristicNotes: notes,
      label: 'INFERRED',
    };
  }

  /**
   * Scaffold a plan to disk: one vitest file of intentionally-skipped cases
   * per feature, plus a playwright spec when the plan carries e2e-layer
   * cases. Respects `dryRun` (no writes) and never overwrites existing files
   * unless `force` is set.
   */
  scaffold(
    plan: TestPlan,
    outDir: string,
    opts: { dryRun?: boolean; force?: boolean } = {},
  ): ScaffoldResult[] {
    const dryRun = opts.dryRun ?? false;
    const force = opts.force ?? false;
    const slug = slugify(plan.feature, 40);
    const unitCases = plan.cases.filter((c) => c.layer !== 'e2e');
    const e2eCases = plan.cases.filter((c) => c.layer === 'e2e');
    const results: ScaffoldResult[] = [];

    if (!dryRun) mkdirSync(outDir, { recursive: true });

    const emit = (absolutePath: string, content: string): void => {
      const bytes = Buffer.byteLength(content, 'utf8');
      if (dryRun) {
        results.push({ path: absolutePath, action: 'dry-run', bytes });
        return;
      }
      if (existsSync(absolutePath) && !force) {
        results.push({ path: absolutePath, action: 'skipped', bytes: 0 });
        return;
      }
      writeFileSync(absolutePath, content, 'utf8');
      results.push({ path: absolutePath, action: 'created', bytes });
    };

    emit(join(outDir, `${slug}.generated.test.ts`), renderVitestScaffold(plan, unitCases));
    if (e2eCases.length > 0) {
      emit(join(outDir, `${slug}.generated.spec.ts`), renderPlaywrightScaffold(plan, e2eCases));
    }
    return results;
  }
}

/** Documented priority table: security/payment → critical, else category default. */
function priorityFor(category: TestCaseCategory, defaultPriority: RiskTier, area: ChangeArea): RiskTier {
  if (category === 'security') return 'critical';
  if (area === 'payment') return 'critical';
  return defaultPriority;
}

/** Boundary values implied by a criterion's nouns; generic floor of two. */
function boundaryValuesFor(criterion: string): BoundaryValue[] {
  const values: BoundaryValue[] = [];
  const seen = new Set<string>();
  for (const [pattern, value] of BOUNDARY_RULES) {
    if (values.length >= 3) break;
    if (pattern.test(criterion) && !seen.has(value.label)) {
      seen.add(value.label);
      values.push(value);
    }
  }
  if (values.length < 2) {
    for (const generic of GENERIC_BOUNDARIES) {
      if (values.length >= 2) break;
      if (!seen.has(generic.label)) {
        seen.add(generic.label);
        values.push(generic);
      }
    }
  }
  return values;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Escape a string for a single-quoted TypeScript literal. */
function q(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function renderVitestScaffold(plan: TestPlan, cases: TestCase[]): string {
  const slug = slugify(plan.feature, 40);
  const e2eCases = plan.cases.filter((c) => c.layer === 'e2e');
  const lines: string[] = [];
  lines.push('/**');
  lines.push(` * ${oneLine(plan.feature)} — generated by @the-qa-skill/agents GenerationAgent.`);
  lines.push(` * Deterministic test-design pipeline output (label: ${plan.label}).`);
  lines.push(' *');
  lines.push(' * Every case below is an intentionally SKIPPED scaffold (test debt): the');
  lines.push(' * name encodes the Given/When/Then contract from the plan. Implement the');
  lines.push(' * body, then remove `.skip`. Never weaken assertions to make a scaffold');
  lines.push(' * pass (golden rule 1) and never delete scaffolds without recorded evidence.');
  lines.push(' */');
  lines.push("import { describe, it } from 'vitest';");
  lines.push('');
  lines.push(`describe(${q(plan.feature)}, () => {`);
  for (const c of cases) {
    lines.push(`  it.skip(${q(`${c.category}: ${c.title} [plan: ${c.id}]`)}, () => {`);
    for (const g of c.given) lines.push(`    // Given: ${oneLine(g)}`);
    lines.push(`    // When: ${oneLine(c.when)}`);
    lines.push(`    // Then: ${oneLine(c.then)}`);
    lines.push(`    // Implement from plan case ${c.id} (category: ${c.category}, priority: ${c.priority}).`);
    lines.push(`    // Rationale: ${oneLine(c.rationale)}`);
    lines.push('  });');
    lines.push('');
  }
  if (e2eCases.length > 0) {
    // Cross-reference: the plan is split across the two scaffold files, so the
    // unit file documents where its e2e cases are implemented.
    lines.push('  // e2e plan cases live in the sibling playwright spec:');
    for (const c of e2eCases) {
      lines.push(`  // Implement from plan case ${c.id} (category: ${c.category}, layer: e2e — see ${slug}.generated.spec.ts).`);
      lines.push(`  // Rationale: ${oneLine(c.rationale)}`);
    }
    lines.push('');
  }
  lines.push('});');
  return `${lines.join('\n')}\n`;
}

function renderPlaywrightScaffold(plan: TestPlan, cases: TestCase[]): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(` * ${oneLine(plan.feature)} — e2e scaffolds generated by @the-qa-skill/agents GenerationAgent.`);
  lines.push(' * Intentionally skipped (test debt): implement the Given/When/Then contract,');
  lines.push(' * then remove `.skip`. These run under @playwright/test.');
  lines.push(' */');
  lines.push("import { test } from '@playwright/test';");
  lines.push('');
  lines.push(`test.describe(${q(plan.feature)}, () => {`);
  for (const c of cases) {
    lines.push(`  test.skip(${q(`${c.category}: ${c.title} [plan: ${c.id}]`)}, async ({ page }) => {`);
    for (const g of c.given) lines.push(`    // Given: ${oneLine(g)}`);
    lines.push(`    // When: ${oneLine(c.when)}`);
    lines.push(`    // Then: ${oneLine(c.then)}`);
    lines.push(`    // Implement from plan case ${c.id} (category: ${c.category}, priority: ${c.priority}).`);
    lines.push(`    // Rationale: ${oneLine(c.rationale)}`);
    lines.push('  });');
    lines.push('');
  }
  lines.push('});');
  return `${lines.join('\n')}\n`;
}
