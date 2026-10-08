---
name: qa-test-generation
description: Designs test cases through the deterministic pipeline — requirements to acceptance criteria to business rules to category enumeration — and scaffolds them as honest, intentionally-skipped test debt without ever overwriting existing files. Activate when a feature or coverage gap needs new tests; never one-shot raw test code, and stop to ask when acceptance criteria are missing.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa generate --spec <file> --json --dry-run"
  mcp: "generate_tests(root?, feature) — planning only, NEVER writes"
  agent: "GenerationAgent.plan(spec) / GenerationAgent.scaffold(plan, outDir, {dryRun?, force?})"
  core: "FeatureSpec → TestPlan (label INFERRED); learning store type 'generation_rejected'"
---

# QA Test Generation

## Purpose

Generation is a DESIGN pipeline, not a code dump. `GenerationAgent.plan(spec)` enumerates cases per acceptance criterion — one positive, one negative, boundary values extracted from the criterion's nouns (zero/one/max/min/empty/null/duplicate/missing/expired/malformed, with a generic empty/maximum floor guaranteeing ≥2 per criterion) — then fires spec-level heuristics on documented triggers: state, concurrency, security, accessibility, time, integration, resilience. Every case carries a Given/When/Then contract, a priority, and a rationale; the plan's label is `INFERRED` because designed cases are reasoning products until executed. `scaffold()` writes `it.skip`/`test.skip` scaffolds — honest, recorded test debt whose names encode the contract — never overwriting existing files unless `force` is set. This skill's rules keep the agent from the two classic failures: one-shotting plausible-looking tests with no criteria behind them, and generating code that is flaky or unreviewable by construction.

## When to activate

- A feature has acceptance criteria (from `qa-requirements`) and needs its planned cases designed.
- Selection/coverage reported a gap: changed files no inventory test covers.
- A scaffold exists as skipped debt and the team is ready to implement bodies (this skill plans; review vets).
- NOT when existing coverage already passes review for the same behavior — extend, don't duplicate (rule 9).
- NOT as a fix path for failing tests: failure analysis belongs to triage/healing with their own evidence bars.
- When a team wants a baseline suite for a legacy area: criteria come first (qa-requirements), scaffolds second.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `--spec <file>` | CLI / spec doc | yes | FeatureSpec: `{ name, description?, acceptanceCriteria: string[], businessRules?: string[], area? }`. `name` + `acceptanceCriteria` are the hard minimum (MCP validates them). |
| Requirements | `.theqa/context.json` / qa-requirements | no | Criteria carry `REQ-*` ids so generated cases cite their requirement lineage. |
| Business rules | spec | no | Pin positive cases to the unit layer ("cheapest to verify there" rationale). |
| `area` | spec / routing | no | Unlocks heuristics: security for `auth`/`api`/`payment`; accessibility for `ui`. |
| Coverage gaps | selection/coverage output | no | The changed files a plan must justify coverage for. |
| Result shapes | agent output | — | `TestPlan { feature, cases: TestCase[], summary { total, byCategory, byLayer }, heuristicNotes[], label: 'INFERRED' }`; `TestCase { id: '<slug>-<category>-<n>', title, category, layer, given[], when, then, priority, rationale }`; `ScaffoldResult { path, action: 'created'\|'skipped'\|'dry-run', bytes }`. |

## Preconditions

- Acceptance criteria EXIST and are verifiable. Zero criteria → the agent returns the honest empty plan ("no acceptance criteria provided — nothing was designed") and this skill STOPS at asking, it does not improvise product intent.
- The pipeline order is mandatory: requirement → acceptance criteria → business rules → category enumeration. Skipping to code is the one-shot anti-pattern this skill exists to prevent.
- Lifecycle: generation lives in `GENERATE` (after PLAN); every scaffold must pass `qa-test-review` (VALIDATE) before it counts as protection.
- The output directory is a generated-tests target (or an explicitly chosen dir); scattering scaffolds into curated suite directories defeats the debt tracking.

## Decision rules

1. IF the spec has no acceptance criteria, THEN STOP and ask — surface what is missing, which decisions hang on it, and do not generate anything; a description alone is downgraded to a single pseudo-criterion only when explicitly declared as such.
2. IF designing, THEN walk the full enumeration per criterion: positive (happy path proving the criterion), negative (invalid input rejected with no partial effect), boundary (noun-driven: zero/one/max/min/empty/null/undefined/duplicate/missing/expired/malformed as they apply; generic empty+maximum floor when nouns suggest none — a 3-criterion spec always yields ≥10 cases).
3. IF the corpus contains state/status/role vocabulary, THEN add state-transition cases including the ILLEGAL transition ("undocumented transition is rejected with the current state preserved") — reachable states alone never catch transition bugs.
4. IF payment/order/submit/checkout vocabulary appears, THEN add concurrency cases: duplicate submission racing ("exactly one side effect occurs and the loser receives an idempotent success or an explicit conflict error") and idempotent retry ("same request, same key → no additional side effect") — the classic double-charge defect class.
5. IF area is `auth`, `api`, or `payment`, THEN add one security case per vector — authentication (no credentials → denied, no data), authorization (outside permissions → denied), IDOR ("references another tenant's object id directly → not-found/forbidden, never the other tenant's data"), injection ("payload treated as inert data; nothing executes, no internal error text leaks") — all priority `critical`.
6. IF expire/schedule/session/token vocabulary appears, THEN add time cases: timezone handling ("same logical instant from two timezones agrees on the outcome") and expiry enforcement ("used one instant AFTER expiry → rejected, no partial effect") — instant granularity, because day-granular tests hide off-by-one-second defects.
7. IF api/webhook/queue vocabulary appears (or integration fired), THEN add resilience cases: dependency timeout ("fails fast, leaves no partial state") and transient-failure retry ("retry succeeds exactly once, no duplicate side effect") — retries without idempotent semantics turn transient failures into duplicated data.
8. IF placing layers, THEN follow the plan's rules: positive → unit, promoted to e2e ONLY when area is `ui` AND the criterion describes a user flow (user/journey/screen/page/navigate/click/visit vocabulary); negative/boundary/state/time → unit; concurrency/integration/resilience → integration; security → security layer; accessibility → a11y layer (role/label/contrast/keyboard matrix when area is `ui`).
9. IF existing coverage already passes review for the behavior a new case would target, THEN extend the existing test file's coverage deliberately or skip the case with the duplication noted — do not generate a parallel suite (golden rule 15; duplication is a scored quality dimension).
10. IF scaffolding, THEN emit one vitest file per feature (`<slug>.generated.test.ts`, `it.skip` cases) plus a playwright spec (`<slug>.generated.spec.ts`, `test.skip`) only when e2e cases exist; an existing file at the target path is SKIPPED (`action: 'skipped'`), never overwritten without explicit `force` — skipped-not-overwritten is the discipline.
11. IF a scaffold was skipped or a plan rejected (criteria absent, duplication found, review failure), THEN record it: learning store `type: 'generation_rejected'` with the reason in `payload` and the consequence in `effect` — rejection without a record repeats itself next session.
12. ALWAYS run `--dry-run` first (CLI flag or `dryRun: true`): bytes are recorded (`action: 'dry-run'`) without touching disk, review happens on the would-be output, and only an explicit second step writes.

### Prohibited in generated code (review-enforced, generation-avoided)

`page.waitForTimeout` and arbitrary sleeps (golden rule 3 — web-first waiting instead); brittle XPath (accessible role/label queries instead); giant page objects; duplicated auth/login flows per test (shared setup helper); hidden global state and test-order dependencies (isolation, golden rule 6); hardcoded prod credentials or secret-shaped literals (25-point review finding — env/config only); data collisions (seeded factories, unique identities); weakened assertions or tautologies (golden rule 1); `.only` (silently disables the rest of the suite); timeout raises to make flaky tests pass.

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Consumed: existing inventory + frameworks bound the scaffold targets. |
| MODEL | Consumed: requirements, criteria, risk tier (critical areas demand the security/concurrency heuristics). |
| PLAN | Consumed: the strategy's layer plan is the quota this pipeline fills. |
| GENERATE | **Owned phase**: plan() enumeration → scaffold() as skipped debt (dry-run first). |
| VALIDATE | **Mandatory gate**: `qa-test-review` on every generated file before it counts. |
| EXECUTE | Scaffolds are `it.skip` — they do NOT run until implemented; say so, never count skips as protection. |
| OBSERVE | Not applicable. |
| TRIAGE | Not applicable. |
| HEAL | Not applicable (healing owns existing tests; generation never "fixes" by regenerating over them). |
| VERIFY | Implemented cases re-enter review + execution; scaffold debt shrinks only via recorded implementation. |
| MEASURE | Plan summary (total, byCategory, byLayer) vs implemented cases = honest debt metric. |
| LEARN | Rejections, skips, and duplicated-plan findings recorded (`generation_rejected`, review feedback). |

## Anti-patterns

- One-shotting: "here are 30 tests for your feature" produced without criteria, categories, or rationales — unreviewable, untraceable, and usually asserting implementation details.
- Generating directly to disk without dry-run, or overwriting an existing file because the new one "looked better" — `action: 'skipped'` exists precisely for that collision.
- Treating `.skip` scaffolds as test coverage in reports: skipped debt is recorded debt, and calling it protection is a false claim (golden rule 4).
- Happy-path-only plans: negative and boundary cases are the pipeline's floor, not optional garnish.
- Sleeps and waits hardcoded into generated code to "make it stable" — that is flake manufacturing, banned as a first fix.
- Copy-pasted auth/login into every generated test: duplicated setup diverges and the duplication dimension scores it.
- Generating for a behavior an existing reviewed test already covers — parallel suites that drift apart.
- Inventing concrete expected values the criteria never state ("cart total must be 42.00") — expected outcomes come from criteria and code contracts, both cited.
- Designing cases for heuristics the spec cannot support and marking them done: unsupported categories stay in the plan as blocked-on-infrastructure, visibly.

## Failure handling

- No acceptance criteria (rule 1) → the honest empty plan + explicit questions; generation is blocked, not improvised.
- MCP `generate_tests` is PLANNING ONLY (`planningOnly: true`, "nothing was written to disk") — any expectation that the tool writes files is corrected, and writing happens only through the deliberate scaffold step with its own checks.
- Scaffold target exists → `action: 'skipped'`; merge the plan cases into the existing file by hand or rename the feature slug — never `force` without reading what would be lost.
- Criteria conflict with code contracts found during design → stop that criterion, record the contradiction as an open question (qa-requirements rules), design the uncontested criteria only.
- Plan produces a category the repo cannot run (no a11y harness) → the case stays in the plan marked as blocked-on-infrastructure; do not silently drop it or fake it.
- Review rejects a generated file → back to plan with the review deductions attached; regeneration without addressing the deductions is forbidden.
- The spec's `area` is unknown or wrong → confirm before designing: area gates the security and accessibility heuristics, and the wrong area silently deletes (or fabricates) an entire category of cases.
- Scaffold written but the feature slug collides with an unrelated feature's slug → rename the spec (slugify caps at 40 chars, `untitled` is the empty-name fallback) and re-run; do not merge two features' cases into one file.
- Generation asked to run during EXECUTE for a failing suite → refuse the impulse: fixing a failing test is triage + healing territory with its own evidence bar; regeneration is not a repair path.

## Evidence requirements

- TestPlan and its cases: `INFERRED` — designed, not executed; the label travels on the plan object itself.
- `heuristicNotes[]`: `OBSERVED` as the record of which heuristics fired and why (quote them; they are the enumeration audit trail).
- Scaffold outcomes: `OBSERVED` (`created`/`skipped`/`dry-run` with byte counts) — the action enum is the evidence.
- "This plan covers criterion X": `INFERRED` until a mapped, executed test verifies it (`CONFIRMED` only post-run).
- Debt reports: skipped scaffolds listed with their plan-case ids — a debt number without ids is `NOT_VERIFIED`.
- Expected values inside implemented cases: `OBSERVED` only when traced to a criterion or code contract; otherwise the case is not ready for review.
- Category/priority tables in reports ("security → critical, payment-area specs → critical") are the engine's documented table — quote it as such, `OBSERVED` as output, `INFERRED` as fit for this spec.

## Safety constraints

- Safety class: `LOW_RISK_WRITE` (`ACTION_POLICIES: 'generate'` — "Creates new test files under the generated-tests directory; never overwrites existing files without --force"). Dry-run first keeps even that write optional.
- No `--confirm-risk` path for generation itself; anything touching production (`test.production`, real payment gateways) is HIGH_RISK and out of scope here.
- Golden rules engaged: 1 (never weaken an assertion — scaffold headers state it), 3 (no sleeps), 4 (skipped scaffolds are never claimed as verification), 5 (no massive redundant E2E — one e2e file only when e2e cases exist), 8 (secrets never enter generated code or its rationale strings), 15 (extend, don't duplicate).
- MCP `generate_tests` never writes — the safety posture is in the tool contract, and agents must not route around it by writing files the plan "implied".

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "INFERRED",
  "data": {
    "planningOnly": true,
    "note": "TestPlan is a proposal — nothing was written to disk. Review before applying anything.",
    "feature": { "name": "checkout coupon application", "area": "payment", "acceptanceCriteria": ["applying an expired coupon is rejected with COUPON_EXPIRED and the total is unchanged"] },
    "plan": {
      "feature": "checkout coupon application",
      "summary": { "total": 12, "byCategory": { "positive": 1, "negative": 1, "boundary": 2, "concurrency": 2, "security": 4, "time": 2 }, "byLayer": { "unit": 6, "integration": 2, "security": 4 } },
      "cases": [
        {
          "id": "checkout-coupon-application-boundary-1",
          "title": "boundary expired: applying an expired coupon is rejected with COUPON_EXPIRED…",
          "category": "boundary", "layer": "unit", "priority": "critical",
          "given": ["the system is in a valid state for the criterion"],
          "when": "an expired value is submitted",
          "then": "the system behaves per the criterion at the boundary without crashing or corrupting state",
          "rationale": "boundary heuristic: \"expired\" is an edge of the input domain implied by the criterion's nouns; edges are where off-by-one and truncation defects live"
        }
      ],
      "heuristicNotes": ["positive: 1 case(s), one per acceptance criterion", "concurrency: fired (payment/order/submit/checkout vocabulary) — duplicate-submit + idempotency cases", "security: fired (area payment) — authentication/authorization/IDOR/injection vector cases"],
      "label": "INFERRED"
    },
    "scaffold": [
      { "path": "/work/shop/tests/generated/coupon-application.generated.test.ts", "action": "dry-run", "bytes": 3120 }
    ]
  }
}
```

`data.plan` mirrors `TestPlan`; `data.scaffold[]` mirrors `ScaffoldResult` (`created` | `skipped` | `dry-run`). The MCP handler returns `planningOnly: true` + `note` + `feature` + `plan` — no scaffold key, because the tool never writes.

## Examples

### Walkthrough 1 — payment feature, full pipeline
Spec: `checkout coupon application` (the "checkout" word is what fires the concurrency heuristic), area `payment`, 2 criteria (one `must` from REQ-coupon-application-rules-1). The agent runs the pipeline: 2 positive + 2 negative + 4 boundary (zero/maximum from "amount", expired from "expired", empty from the generic floor) + 2 concurrency (checkout vocabulary) + 4 security (payment area) + 2 time (expiry vocabulary) = 16 cases, all non-e2e (area is payment, not ui — nothing promoted, no playwright spec emitted). Priorities: `priorityFor` pins EVERY case to critical for a payment-area spec — the table is blunt on purpose. Dry-run records `checkout-coupon-application.generated.test.ts` (all 16 cases). Review runs on the dry-run bytes; scaffold writes with `action: 'created'`, debt recorded per case id.

### Walkthrough 2 — refusal and gap-extension
A request arrives: "generate tests for the usage endpoint" with no criteria. Rule 1: the agent returns the honest empty plan ("no acceptance criteria provided — nothing was designed") and asks whether aggregation is per calendar month or rolling 30 days. Separately, selection flagged `app/api/usage.ts` as a coverage gap; once a human answers, the derived criteria from qa-requirements (INFERRED, file-cited) become the spec, and the pipeline designs the plan from those two criteria — positive/negative/boundary-floor each, plus heuristics as the vocabulary triggers. An existing reviewed `usage.test.ts` already covers empty-period behavior — rule 9: the plan EXTENDS it with the missing aggregation cases instead of scaffolding a parallel file, and the duplication note is recorded in heuristicNotes.

## Verification checklist

- [ ] The pipeline order was followed: requirement → criteria → business rules → category enumeration; no one-shot code.
- [ ] Positive, negative, and ≥2 boundary cases exist per criterion (generic floor recorded when nouns suggested none).
- [ ] State, concurrency, security, time, integration, and resilience heuristics were each considered, with fired/rejected recorded in heuristicNotes.
- [ ] Layer placement follows the promotion rules; e2e only for ui user-flow criteria.
- [ ] Dry-run preceded any write; no existing file was overwritten (`skipped` honored) without explicit force.
- [ ] Scaffolds are `it.skip`/`test.skip` debt with Given/When/Then + plan-case ids, and were never counted as passing coverage.
- [ ] The prohibited list (sleeps, XPath, duplicated auth, `.only`, weakened assertions, hardcoded credentials, …) appears nowhere in generated code.
- [ ] Missing acceptance criteria stopped the pipeline with questions, not improvised tests.
- [ ] Existing reviewed coverage was extended, not duplicated.
- [ ] Rejections and skips were recorded to the learning store (`generation_rejected`).
