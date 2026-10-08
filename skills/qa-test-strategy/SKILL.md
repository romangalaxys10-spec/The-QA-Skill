---
name: qa-test-strategy
description: Decides WHICH layers, suites, and heuristics verify a change or feature — pyramid intelligence with recorded demotion reasons, the six routing policies, and the orchestration posture (pr/pre_merge/nightly/release/post_deploy) — instead of defaulting to "run everything" or "add E2E". Activate when planning test breadth for a feature or PR, when CI time must be justified, or when a suite shape no longer matches the product's risks.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa plan · qa coverage"
  mcp: "list_relevant_tests(root?, range?) (policy-aware selection)"
  agent: null
  core: "selectTests(changedFiles, inventory, routing?, {policy, maxPrE2E, alwaysInclude}) / buildRoutingHints / config selection.* + project.criticalFlows"
---

# QA Test Strategy

## Purpose

Strategy is the layer between risk (how dangerous) and selection (which tests): it decides what SHAPE of verification a change deserves. The engine enforces the shape mechanically — pyramid demotion strips E2E that lower layers already cover (reason recorded, never silently deleted), the PR e2e budget (default 25) defers excess, and the six routing hints translate change shapes into suite mandates. This skill instructs the agent on the judgment the engine cannot make: which heuristics must be enumerated for a feature, where each case belongs in the pyramid, and which responsibilities (env matrix, feature flags, multi-tenancy, i18n) a strategy must name even when no engine detects them. Golden rule 5 is the spine: never generate massive redundant E2E suites; golden rule 11 is the counterweight: prefer the smallest test that catches the defect.

## When to activate

- Planning a feature: which layers will verify each acceptance criterion before any code is generated.
- Sizing a PR: translating the risk tier into a policy posture (`pr` vs `pre_merge` vs `release`).
- A routing hint fired (payment/migration/auth/css-only/docs/test-only) and the suite response must be decided.
- E2E suites are slow and growing: apply demotion and budget rules, and audit which E2E earn their cost.
- Coverage review: `qa coverage` gaps mapped to strategy decisions (which layer SHOULD own the missing coverage).
- Suite redesign: when runtime must shrink, demotion + budget rules decide what goes before anything is deleted.
- New team policy ("all PRs run full regression") needs a cost/signal audit: the routing hints quantify what blanket policies waste.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| Risk tier | `qa-risk-analysis` output | yes | critical/high/medium/low sets the posture floor; floors (payment/migration → critical) carry over. |
| Routing | `classifyRouting(files)` + hints | no | Six hints always emitted: css-only-change, payment-change, db-migration, auth-change, docs-only, test-only. |
| Inventory | discovery + selection | yes | Layers present, `avgDurationMs`, `flakeScore` — strategy without inventory is fiction. |
| Policy | caller / CI stage | no | `pr` minimal (budget enforced); `pre_merge` picks up deferrals; `nightly`/`release` expand; `post_deploy` smoke-only. |
| Critical flows | config `project.criticalFlows` | no | Named flows + path patterns; `analyzeCoverage` reports their coverage and the strategy protects them. |
| Quality gates | context `qualityGates` | no | minWeightedCoverage 60, maxCriticalFlakes 0, blockOnRealRegression true, maxUnknownTriage 2 — strategy must be achievable under them. |

## Preconditions

- DISCOVER/MODEL done: strategy is a `PLAN`-phase activity with risk tier and routing in hand.
- The inventory is current — demotion decisions read `covers` maps; stale maps demote the wrong E2E.
- A strategy output names layers, heuristics, and policies; a strategy that cannot name the policy it feeds is a wish, not a plan.
- Strategy changes (budget, layer ownership) land as config/plan updates, not only as chat advice — the orchestrator cannot read the conversation.

## Decision rules

1. IF lower-layer tests already cover the changed file an E2E covers, THEN the E2E is demoted with the recorded reason "lower-layer tests already cover this changed file — E2E retained only because the flow is business-critical" — retained for critical flows, demoted everywhere else (golden rule 5).
2. IF policy is `pr` and selected E2E count exceeds `maxPrE2E` (default 25, config `selection.maxPrE2E`), THEN defer the excess to pre-merge with the reason "PR policy e2e budget (25) exhausted → deferred to pre-merge suite" — deferred, never deleted.
3. IF `payment-change` fires, THEN the mandate is the hint verbatim: "Heavy validation: payment unit + API + contract + high-value E2E." — all four layers, not one giant browser suite.
4. IF `db-migration` fires, THEN "Run data-integrity + migration tests; verify rollback path." — the rollback test is part of the strategy, not an optional extra.
5. IF `auth-change` fires, THEN "Elevate authz matrix tests, session lifecycle, token expiry tests." — role×resource matrix coverage is a strategy deliverable.
6. IF `css-only-change` fires, THEN "Skip API/DB regression suites; run visual + component smoke only." — and the strategy says what protects the layout: visual layer, not E2E page walks.
7. IF the feature is a pure calculation (pricing tiers, tax math, discount stacking), THEN unit layer owns it entirely: fastest feedback, exhaustive boundaries; E2E for a calculator is cost without unique signal (golden rule 11).
8. IF the feature is a transactional flow (checkout, order submission), THEN the strategy is unit (rules/boundaries) + API (contracts, idempotency) + FEW high-value E2E (the money path, one per critical flow) — the E2E exist to prove integration, not to re-verify arithmetic.
9. IF a criterion describes a UI user flow (generation promotes it: area `ui` + user-flow vocabulary), THEN exactly that criterion's happy path is E2E; its negative/boundary siblings stay unit — promotion is per-case, never per-feature.
10. FOR EVERY planned feature, THEN enumerate the heuristic categories explicitly and record which fired and which were considered-and-rejected: positive (happy path), negative (invalid input), boundary (zero/one/max/min/empty/null/duplicate/missing/expired/malformed), state (transitions incl. illegal ones), concurrency (duplicate submits, idempotency, races), time (timezone, expiry, clock), security (authn/authz/IDOR/injection), integration (contract shape), resilience (timeout/retry/degraded upstream), accessibility (role/label/contrast/keyboard) — an undocumented rejection is how gaps are born.
11. IF the product runs multi-env, multi-flag, multi-tenant, or multi-locale, THEN the strategy names the coverage owner for each: env/browser matrix spread is a flake-score input (env/browser spread 15%), so matrix cases belong where they assert logic (unit/integration) not where they multiply E2E runtime; flag-dependent behavior needs a case per flag state or an explicit "flag X untested, owned by <team>"; tenants are verified by the security layer's IDOR vector (cross-tenant object access); locales by the time/i18n boundary cases on formatting and timezone — none of these are engine-detected, so the strategy doc is their only home.
12. IF a strategy artifact is not wired to execution (no policy, no config, no selection rule references it), THEN it is debt: keep strategy decisions inside the plan/config the orchestrator reads, and treat prose-only strategy docs as candidates for deletion at the next review.

### Layer decision table

| Change/feature shape | Unit | API/Integration | Contract | E2E |
|---|---|---|---|---|
| Pure calculation (pricing, tax) | exhaustive + boundaries | — | — | — |
| Transactional flow (checkout) | rules + boundaries | contracts + idempotency | gateway shape | few high-value (money path) |
| Auth boundary | token/unit rules | session lifecycle | — | login happy path + one elevated-path check |
| Migration/schema | — | data integrity | — | — (rollback is API-level) |
| CSS/visual only | — | — | — | visual smoke only |

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Consumed: inventory shape (which layers exist) bounds every strategy decision. |
| MODEL | Consumed: risk tier + routing are the strategy's raw material. |
| PLAN | **Owned phase**: layer table, heuristic enumeration, policy posture, critical-flow protection. |
| GENERATE | Consumed: the plan hands generation its per-layer case quotas and categories. |
| VALIDATE | Check generated cases land in their planned layers; deviations are justified or reverted. |
| EXECUTE | Consumed: policy (pr/pre_merge/…) governs the run; deferrals are honored, not overridden ad hoc. |
| OBSERVE | Consumed: durations and flake scores are the strategy's feedback loop. |
| TRIAGE | Not applicable. |
| HEAL | Not applicable. |
| VERIFY | Re-check strategy after fixes: a changed flow may need its E2E un-demoted. |
| MEASURE | Consumed: `qa coverage` weighted coverage + critical-flow coverage grade the strategy. |
| LEARN | Record strategy misses (gap escaped to prod, demoted E2E would have caught it) as review feedback. |

## Anti-patterns

- "Add an E2E test" as the reflex response to every bug — the pyramid exists so the cheapest layer that can catch a defect owns it (golden rules 5, 11).
- Silent demotion or deletion: the demotion reason string is part of the contract; an E2E removed without a recorded reason is signal destruction.
- Full regression on every PR "to be safe" — budgets and postures exist so cost buys signal where risk lives.
- A strategy document nobody executes: layer matrices in a wiki, `maxPrE2E` untouched at 100, and the orchestrator running whatever it always ran (rule 12 — debt).
- Enumerating only happy paths: the heuristic list in rule 10 is the minimum enumeration bar; "happy/negative/boundary" alone leaves state, concurrency, time, security, and resilience to luck.
- Multi-tenant products with zero cross-tenant access cases, or locales with only `en-US` fixtures — the strategy must NAME these, even when the fix is scheduled later.
- Treating the e2e budget as a target: 25 is a ceiling, not a quota to fill with page-load checks.
- Copying another repo's strategy: layer decisions follow THIS inventory, THESE critical flows, and THIS risk profile.
- Owning the strategy in conversation only: decisions that never reach the plan output or config cannot be audited, and unauditable strategy always drifts back to "run everything".

## Failure handling

- Risk tier missing → derive posture from routing hints alone and say the tier was unavailable; never assume `low`.
- Inventory lacks a layer the strategy needs (no API tests exist) → the strategy states the gap and its generation priority; it does not pretend the layer exists.
- Demotion disputed ("this E2E catches things units can't") → the dispute is resolved by naming the unique signal and the critical-flow designation — which either reinstates the E2E with that reason, or concedes the demotion.
- Budget exceeded and pre_merge cannot absorb the deferral → escalate to the policy owner; do not silently raise `maxPrE2E`.
- Critical flows unconfigured → strategy flags the absence: coverage cannot weight what config does not name.
- Flake-heavy E2E undermining the posture → route to flake skill; strategy adjusts (isolate/quarantine) rather than tolerating red suites that teach people to ignore failures.
- A critical flow has no test at any layer → the strategy says so as a blocking gap in the plan (the coverage gate's `minWeightedCoverage` will surface it too); do not reclassify the flow as "not really critical" to make the report look better.
- Policy requested by CI does not match the tier's posture (pr on a critical-tier change) → the strategy documents the deviation and its owner instead of silently downgrading either side.

## Evidence requirements

- Demotion decisions: `OBSERVED` (the covers-map fact that lower layers cover the file) + the recorded reason string quoted verbatim.
- Policy/budget outcomes: `OBSERVED` from selection output (deferral reasons are engine-emitted).
- Layer placements: `INFERRED` — judgment encoded in this skill's rules until execution proves the placement right.
- Heuristic enumeration: `INFERRED` design reasoning; each rejected category needs its rejection recorded, or it is `NOT_VERIFIED` coverage.
- Critical-flow protection: `INFERRED` until `qa coverage` reports the flow's coverage, `CONFIRMED` only after those cases ran green.
- Env/flag/tenant/i18n responsibilities: always `INFERRED` design claims — no engine detects them; the strategy doc's honesty IS their evidence state.
- Posture strings quoted in reports carry the risk tier citation they were derived from — a posture without its tier citation is `NOT_VERIFIED` reasoning.

## Safety constraints

- Safety class: `READ_ONLY` — planning reads inventory/risk and emits decisions; `ACTION_POLICIES` classifies both 'plan' ("writes only with --out") and 'coverage' as READ_ONLY.
- No `--confirm-risk` path; strategy never triggers execution, deployments, or production contact.
- Golden rules engaged: 5 (no massive redundant E2E — demotion + budget), 6 (isolation — parallel-safe layering, no shared-state shortcuts for speed), 11 (smallest test that catches the defect), 15 (signal over count).
- Posture escalation beyond the tier (rule 10 overrides in risk skill) is a recorded human decision; strategy applies tiers, it does not secretly inflate them.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "INFERRED",
  "data": {
    "policy": "pr",
    "riskTier": "high",
    "posture": "expanded regression of affected areas + high-value E2E of changed flows",
    "layerPlan": [
      { "feature": "checkout coupon application", "layer": "unit", "heuristicCategories": ["positive", "negative", "boundary", "time"], "rationale": "calculation + expiry edges are cheapest to verify at unit layer" },
      { "feature": "checkout coupon application", "layer": "api", "heuristicCategories": ["concurrency", "resilience"], "rationale": "duplicate-submit idempotency and gateway timeout contracts" },
      { "feature": "checkout coupon application", "layer": "e2e", "heuristicCategories": ["positive"], "rationale": "one high-value money-path run; demotion checked against unit covers" }
    ],
    "routing": [
      { "rule": "payment-change", "triggered": true, "action": "Heavy validation: payment unit + API + contract + high-value E2E.", "reason": "Payment logic change detected in change set." },
      { "rule": "css-only-change", "triggered": false, "action": "Skip API/DB regression suites; run visual + component smoke only.", "reason": "Only stylesheet files changed — 4,000 API tests would be waste, not signal." }
    ],
    "budget": { "maxPrE2E": 25, "selectedE2E": 3, "deferred": 0 },
    "responsibilities": [
      { "concern": "multi-tenant isolation", "owner": "security layer IDOR cases", "status": "planned" },
      { "concern": "timezone expiry boundaries", "owner": "unit time cases", "status": "planned" }
    ]
  }
}
```

`data.routing` mirrors core `RoutingHint[]` (all six hints present, `triggered` varies); `budget` reflects selection's `maxPrE2E` mechanics; `label` is `INFERRED` — strategy is a design product until execution confirms it.

## Examples

### Walkthrough 1 — checkout coupon feature, tier high
Risk says high (payment floor). Strategy: unit owns the coupon math (stacking rules, boundary values zero/max/expired — rule 7), API owns duplicate-submit idempotency and gateway-timeout resilience (concurrency + resilience categories), and exactly ONE E2E covers the money path: add coupon → pay → total reflects discount. Pyramid check: the E2E's covered files are unit-covered, so the demotion reason is recorded and the E2E survives only as a business-critical flow (rule 1). The heuristic table shows accessibility considered-and-rejected (no UI surface change) with the rejection recorded. Policy `pr`; budget 3/25.

### Walkthrough 2 — css-only PR on the checkout page
Routing: cssOnly true, everything else false. Strategy applies rule 6: skip API/DB suites, run visual smoke + the component tests covering the touched components; the selection note "css-only change set → deprioritized" is expected output, not a bug. The plan explicitly declines to run the 400-test API suite (hint reason: "4,000 API tests would be waste, not signal") and names what protects the change: visual regression specs on the two affected viewports. Posture recorded for the PR report with the hint table attached.

## Verification checklist

- [ ] Every planned feature has an explicit heuristic enumeration with fired AND rejected categories recorded.
- [ ] Layer placements follow the decision table; per-case E2E promotion only for UI user-flow criteria.
- [ ] E2E demotion decisions carry the recorded reason string; nothing was deleted silently.
- [ ] The e2e budget was reported with selected/deferred counts, and deferrals name their destination policy.
- [ ] All six routing hints appear with their triggered state.
- [ ] Env-matrix, feature-flag, multi-tenant, and i18n responsibilities are named with owners — or their absence is flagged.
- [ ] The posture matches the risk tier (and any recorded override), not anxiety.
- [ ] The strategy artifact is wired to something the orchestrator/CI reads, or is marked as debt (rule 12).
- [ ] Critical flows from config were checked for coverage ownership.
- [ ] Demotion disputes were settled by naming unique signal, not by seniority or volume.
