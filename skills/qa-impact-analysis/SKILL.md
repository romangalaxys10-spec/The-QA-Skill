---
name: qa-impact-analysis
description: Maps a git diff range onto the smallest high-confidence test set using transitive import-closure coverage, pyramid demotion, routing policy, and the PR e2e budget — with an explicit WHY attached to every selected test. An empty selection is a coverage gap to generate against, never a reason to skip testing.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa impact --range HEAD~1..HEAD --json"
  mcp: "list_relevant_tests(root?, range?)"
  agent: null
  core: "analyzeDiff + classifyRouting + selectTests + computeCoverage (import closure)"
---

# QA Impact Analysis

## Purpose

Given a change set, decide which tests must run — and be able to say WHY for every single one. `analyzeDiff` turns the git range into structured `ChangedFile`s (numstat/name-status, plus touched symbols from added lines); `classifyRouting` detects change shapes (css-only, payment, migration, auth, docs-only, test-only, boundary signals); `selectTests` maps changed files through the transitive import-closure coverage map of every inventory test and ranks the hits. The result is a `SelectionResult`: selected tests each with `priority` and per-test `reasons`, the unaffected rest, and routing hints. Label: `INFERRED` — selection is reasoning over structure, not proof the tests will catch anything.

## When to activate

- Before any `qa test` execution: selection is the input that makes policies meaningful.
- A PR needs a fast verdict on which suites are relevant (`policy: 'pr'`).
- Pre-merge/release planning: expand the set deliberately (rules below), never accidentally.
- A changed file has no covering test — the empty-selection/coverage-gap decision.
- Reviewing whether CI time is buying signal: selection reasons are the audit trail.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `range` | CLI `--range` / MCP `range` | no | Git diff range, default `HEAD~1..HEAD`; also `main...HEAD` or a sha. |
| `inventory` | test inventory | yes | `TestInventoryEntry[]` with `covers` (import closure or graph), `layer`, `avgDurationMs?`, `flakeScore?`. |
| `routing` | `classifyRouting(files)` | no | Derived from the diff automatically when omitted. |
| `alwaysInclude` | config `selection.alwaysInclude` | no | Path patterns force-included when a test's path or covers match. |
| `maxPrE2E` | config `selection.maxPrE2E` | no | PR e2e budget, default 25; excess e2e deferred with a reason (pr policy only). |
| `policy` | caller | no | `pr` keeps minimal; `pre_merge`/`release` expand. |
| Result shape | engine output | — | `SelectionResult { selected: { test, priority, reasons[] }[], unaffected: TestInventoryEntry[], routing: RoutingHint[], summary, label: 'INFERRED' }`; priority is a RiskTier: `critical \| high \| medium \| low`. |

## Preconditions

- The repo is a git repo and the range resolves (`analyzeDiff` shells out to git).
- The inventory is current: `covers` maps are built from `computeCoverage` (transitive relative/alias imports, bounded depth 12, extensions ts/tsx/js/jsx/mjs/cjs and index resolution) or the quality graph.
- Lifecycle: impact analysis powers `PLAN`; it never executes anything itself.

## Decision rules

1. IF the routing says `cssOnly` (every substantive file is `.css/.scss/.sass/.less/.styl` or `/style/i`), THEN skip API/DB regression suites: visual + component smoke only — "4,000 API tests would be waste, not signal" (routing hint `css-only-change`); non-e2e/visual tests covering the change are deprioritized to `low`.
2. IF `paymentRelated`, THEN heavy validation per routing policy: payment unit + API + contract + high-value E2E; covered payment/auth files push priority to `critical` outright.
3. IF `migrationRelated` (db files present), THEN elevate tests matching `/data|integrity|migrat/i` to `critical` and run the rollback-path verification (routing hint `db-migration`).
4. IF `authRelated`, THEN elevate the authz matrix: session lifecycle and token expiry tests get risk priority raised for any non-unit layer.
5. IF `docsOnly` (no substantive files), THEN no test execution is required — link-check docs if CI has it; IF `testOnly`, THEN run just the affected test files, expecting no product regression.
6. IF a test directly covers changed files, THEN select it with the reason "covers changed file(s): <paths>" — direct coverage is the backbone reason; everything else adjusts it.
7. IF an e2e test covers a changed file that lower-layer tests also cover, THEN keep it but attach the pyramid demotion reason — e2e is retained only because the flow is business-critical (golden rule 5: no massive redundant e2e).
8. IF policy is `pr` and the e2e count exceeds `maxPrE2E` (default 25), THEN defer the excess with the reason "PR policy e2e budget exhausted → deferred to pre-merge suite" — deferred, not dropped.
9. IF a selected test has `flakeScore ≥ 70`, THEN attach "known flaky → run isolated, do not block merge on first failure" — selection surfaces the warning; the flake skill owns the quarantine.
10. IF `alwaysInclude` patterns match a test, THEN select it with reason "matched alwaysInclude pattern from config" — this is how smoke paths survive tiny diffs.
11. IF the selection is EMPTY, THEN the change set is a coverage gap: report "No inventory test covers the change set — coverage gap; generate tests for the affected files" and hand the changed files to generation planning. An empty selection means unknown risk, not zero risk.
12. ALWAYS answer WHY: every group and every test carries its selection reasons; a set you cannot justify test-by-test is not high-confidence, it is habit.

### Priority and routing mechanics

Base priority comes from the AREAS of the covered changed files: `payment` or `auth` → `critical`; `db` or `api` → `high`; any changed file covered → `medium`; otherwise `low`. Routing then adjusts:

- `paymentRelated` + critical priority → reason "payment area change → heavy validation per routing policy".
- `authRelated` + non-unit layer → reason "auth boundary change → risk priority elevated".
- `cssOnly` + layer not e2e/visual → demoted to `low` with reason (visual + e2e smoke remain eligible).
- `migrationRelated` + test name/path matches `/data|integrity|migrat/i` → elevated to `critical` with the data-integrity reason.
- Known flake (`flakeScore ≥ 70`) → warning reason appended, never silently dropped.

Final ordering: priority rank (critical → high → medium → low), then shortest `avgDurationMs` first — fastest feedback at equal confidence.

The import closure (`computeCoverage`) resolves relative and aliased (`@/`, `~/`) specifiers transitively to a bounded depth of 12 across ts/tsx/js/jsx/mjs/cjs including `index` resolution; external packages are not followed. It is this closure that turns "test imports the module" into "test covers the changed file two hops down".

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | `analyzeDiff`: files, additions/deletions, areas, languages, touched symbols. |
| MODEL | `classifyRouting`: change shape + boundary signals (auth, payment, database, webhook, messaging). |
| PLAN | **Primary phase**: `selectTests` — coverage mapping, priority ranking, budget, warnings. |
| GENERATE | Empty-selection gaps and `unknown`-area gaps feed the generation plan. |
| VALIDATE | Sanity: selected ⊆ inventory; reasons non-empty for every selected test. |
| EXECUTE | Hand `SelectionResult` to `qa test` (pr passes through; pre_merge expands). |
| OBSERVE | Not applicable. |
| TRIAGE | Selection reasons contextualize verdicts: `coversChangedCode` comes from this mapping. |
| HEAL | Not applicable. |
| VERIFY | Re-select after fixes; a fix that changes files re-runs this skill, not memory. |
| MEASURE | Selected/unaffected ratio and budget usage feed suite-efficiency observations. |
| LEARN | Misses (defect escaped a "covered" file) become review/generation feedback records. |

Policy expansion semantics: `pr` is the minimal posture — budget enforced, deferral reasons emitted. `pre_merge` picks up what `pr` deferred; `release` selects the maximal relevant set for the release scope. The policy never changes WHICH tests exist, only which subset is justified to run when.

## Anti-patterns

- Running the full suite "to be safe" on every PR: budget burns out, retries mask real signal, and the reasons that would justify the run don't exist (golden rule 15).
- Treating unaffected tests as verified: `unaffected` means "not selected", not "passes" — no label upgrades come from selection.
- Skipping the coverage-gap report when selection is empty — the most dangerous diff is the one nothing covers.
- Ignoring routing hints because "the suite is small anyway": css-only PRs running payment suites is how nightly runs rot.
- Dropping deferred e2e entirely: budget deferral moves tests to pre_merge, it does not delete them (rule 8).
- Selecting from file-name similarity ("checkout.spec matches checkout.ts") instead of the covers map — the import closure is the evidence; vibes are not.
- Letting boundary signals (webhook, messaging) pass unmentioned: `classifyRouting` surfaces them; the plan must say what was done about each.
- Treating `boundarySignals` as routing verdicts: they are attestations for the plan (auth, payment, database, webhook, messaging present) — ignoring them or over-reacting to them are both failures to reason.
- Expanding to the full suite on every pre_merge because "it's only nightly cost": expansion is a deliberate rule application (policy pre_merge/release), not a default posture.

## Failure handling

- Git range invalid / not a repo → surface the git error verbatim; never select from an empty diff presented as "no changes".
- Import resolution fails for aliased paths → declare the alias config used (`@/`, `~/` prefixes); unresolvable imports reduce coverage honesty — report the reduction rather than a silent underestimate.
- Inventory missing layers (no e2e at all) → the pyramid logic has nothing to demote; state that the suite shape limits the strategy.
- `avgDurationMs` absent → ordering falls back to priority-only; runtime-optimized ordering degrades gracefully.
- Range spans a merge with hundreds of files → scope to the PR's own commits or the routing hints drown; say when a range is too broad to reason about per-test.
- Renamed files (`R` status) → the diff parser normalizes to the NEW path; ensure the inventory's covers maps were rebuilt post-rename or direct-coverage reasons will silently miss.

## Evidence requirements

- Per-test selection reasons: `OBSERVED` from the covers-map lookup (the engine emits them; quote them verbatim).
- Routing hint booleans (`triggered` true/false): `OBSERVED` from the diff classification.
- Priority tiers: `INFERRED` — area-based ranking is judgment encoded in code, not execution proof.
- Coverage-gap claims (empty selection): `OBSERVED` (the mapping ran and found nothing) — but "nothing covers X" requires the inventory to be current, else `INFERRED` with the staleness caveat.
- `unaffected` lists: `INFERRED`; never cite them as evidence a file works.
- Symbol detection from added lines: best-effort by design — treat symbol-driven conclusions as `INFERRED` supporting context, never sole justification.
- The `summary` string is evidence of the decision itself: quote it ("N of M inventory tests selected (smallest high-confidence set)") rather than paraphrasing into "we ran the important ones".
- Reasons arrays are append-only per selection run: if a re-run produces different reasons for the same test, both runs are shown, not merged.

## Safety constraints

- Safety class: `READ_ONLY` — impact analysis reads diffs and the import graph and selects without running (ACTION_POLICIES: 'impact').
- No `--confirm-risk` path exists in selection; execution and production concerns belong to the execution skill.
- Golden rules engaged: 5 (never generate massive redundant E2E suites — pyramid demotion + budget), 6 (never destroy test isolation for speed — selection never merges stateful tests into shared sessions), 11 (prefer the smallest test that catches the defect — priority ranking favors lower layers), 14 (explainable decisions — reasons on every selection), 15 (signal over test count).

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "INFERRED",
  "data": {
    "range": "HEAD~1..HEAD",
    "changedFiles": [
      { "path": "src/payments/charge.ts", "status": "modified", "additions": 34, "deletions": 6, "area": "payment", "language": "typescript", "symbols": ["chargeCard"] }
    ],
    "routing": [
      { "rule": "payment-change", "triggered": true, "action": "Heavy validation: payment unit + API + contract + high-value E2E.", "reason": "Payment logic change detected in change set." },
      { "rule": "css-only-change", "triggered": false, "action": "Skip API/DB regression suites; run visual + component smoke only.", "reason": "Only stylesheet files changed — 4,000 API tests would be waste, not signal." }
    ],
    "selected": [
      { "test": { "testId": "payments.api.test:create", "filePath": "tests/api/payments.test.ts", "layer": "api", "covers": ["src/payments/charge.ts"] },
        "priority": "critical",
        "reasons": ["covers changed files: src/payments/charge.ts", "payment area change → heavy validation per routing policy"] }
    ],
    "unaffectedCount": 412,
    "summary": "3 of 415 inventory tests selected (smallest high-confidence set); 412 unaffected."
  }
}
```

`data.selected[]` mirrors core `SelectedTest` (test + priority + reasons); `routing` mirrors `RoutingHint[]` — all six hints are always emitted, only `triggered` varies.

## Examples

### Walkthrough 1 — payment diff, budget-aware selection
Range `HEAD~1..HEAD` touches `src/payments/charge.ts` (+34/−6, symbols: `chargeCard`) and one stylesheet. `classifyRouting`: paymentRelated true, boundary signal 'payment'. Selection: 3 tests — `payments.api.test:create` (critical, direct cover + heavy-validation reason), `checkout.e2e.test:purchase` (critical, direct cover + pyramid note that unit tests cover the same file, retained for business-critical flow), `styles.visual.test:tokens` (low, css-adjacent). 412 tests unaffected with reasons. The e2e count is 1 — budget untouched. The report answers WHY per test, the routing hints show payment triggered and css-only false (both substantive files required for cssOnly — a mixed change set is not css-only), and `qa test --policy pr` receives exactly these three plus the alwaysInclude smoke path.

### Walkthrough 2 — empty selection on a new module
Range adds `app/api/usage.ts` with no inventory test reaching it: selection is empty, summary reads "No inventory test covers the change set — coverage gap; generate tests for the affected files." The agent applies rule 11: reports the gap as the headline (unknown risk, not zero risk), hands `app/api/usage.ts` to generation planning with the changed symbols, and flags the release-gate implication (coverage input will show the gap; weighted coverage drops by the file's weight). The PR does not proceed on "no tests failed" — nothing ran that could fail. A follow-up generates a plan case per acceptance criterion and the next selection run picks the new tests up with fresh covers maps.

## Verification checklist

- [ ] Every selected test carries at least one explicit reason; none were selected by name similarity or habit.
- [ ] All six routing hints were reported with their triggered state, not just the fired ones.
- [ ] css-only, payment, migration, and auth rules changed the set exactly as their actions specify.
- [ ] e2e over the PR budget was deferred with the recorded reason, not dropped.
- [ ] Empty selection was reported as a coverage gap and routed to generation, never to "skip testing".
- [ ] `unaffected` tests were not cited as passing or verified anywhere in the output.
- [ ] The covers maps were current (re-derived after refactors) before selection reasons were trusted.
- [ ] The skill stayed READ_ONLY: no commands were executed, no files written.
- [ ] Expansion decisions (pre_merge/release) were justified by the policy posture, not by anxiety.
- [ ] Every `alwaysInclude` hit was distinguishable in the reasons from direct-coverage hits.
