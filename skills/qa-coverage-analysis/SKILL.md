---
name: qa-coverage-analysis
description: Computes risk-WEIGHTED coverage — business-area weights decide which uncovered files are gaps worth reporting — and surfaces critical-flow coverage from config. Frames every number as INFERRED inventory analysis: line coverage is not confidence, and the gate at 60% is a warning input, not a quality certificate.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa coverage --json"
  mcp: "generate_quality_report(root?, audience?) — coverage section"
  agent: null
  core: "analyzeCoverage(sourceFiles, inventory, criticalFlows?) -> CoverageReport"
---

# QA Coverage Analysis

## Purpose

Answer the question that matters: of the source files that MATTER (weighted by business-area criticality), how many are reached by at least one test, and which named business flows have no test reaching them at all. The engine (`analyzeCoverage` in `packages/core/src/coverage/analyze.ts`) computes `weightedCoverage` and `fileCoverage` 0–100, lists gaps sorted by risk weight, and evaluates `criticalFlows` from `config.project.criticalFlows`. The report label is `INFERRED` — this is inventory analysis over `covers` maps, not a measurement of what the tests actually verify.

The weighting is the point: a repo at 90% file coverage can hide a completely untested payment module if the tested mass is UI helpers. Risk-weighted coverage makes that hiding impossible — the payment file's absence drags the number down ten times harder than an untested docs script, which does not count at all.

## When to activate

- A release gate needs the coverage input (`weightedCoverage < 60` produces a gate warning).
- After impact analysis reports an empty selection ("no inventory test covers the change set") — that IS a coverage gap.
- Planning test-generation work: gaps sorted by `riskWeight` are the priority queue.
- Periodic suite audits and after large refactors that move code between areas.
- When someone quotes a line-coverage percentage as a safety argument — reframe it with this skill.
- Before defining `criticalFlows` for a new repo: the flow section is only as honest as the patterns are tight.
- Before defining `criticalFlows` for a new repo: the flow section is only as honest as the patterns are tight.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `sourceFiles` | `listFiles` / discovery | yes | Repo-relative source paths; `docs` and `test` areas are excluded from the substantive set. |
| `inventory` | test inventory | yes | `TestInventoryEntry[]` with `covers: string[]` per test; the inverted map file → covering test ids is the coverage substrate. |
| `criticalFlows` | `theqa.config.json` → `project.criticalFlows` | no | `{ name, patterns: string[] }[]`; a flow is covered when ANY source file matching a pattern is covered by any test. |
| Quality gates | `qualityGates.minWeightedCoverage` | no | Default 60 — the gate comparison threshold for warnings. |
| Report shape | engine output | — | `CoverageReport { weightedCoverage, fileCoverage, gaps: CoverageGap[], criticalFlowCoverage: {flow, covered, note}[], label: 'INFERRED' }`; gaps carry `{path, area, riskWeight, coveredBy, reason}`. |

## Preconditions

- The inventory's `covers` maps are real (built via import closure or graph) — garbage covers maps produce confident-looking nonsense.
- Lifecycle: coverage analysis is a `MEASURE`-phase skill; it never substitutes for `EXECUTE` (a 100% covered file with weak assertions is the false-negative fixture scenario).
- Area classification (`classifyArea`) decides weights — a file misclassified as `unknown` silently drops from weight 10 to weight 1; spot-check payment/auth paths.
- Source paths are repo-relative and normalized; mixed separators or leading `./` break the file→covers joins silently.

## Decision rules

1. IF a gap's area is `payment` ("payment logic with zero test reach — highest-priority gap") or `auth` ("authentication code with zero test reach — security-critical gap", riskWeight 10 each), THEN put it at the top of the closing queue — these are the weights the whole model exists to enforce.
2. IF a gap's area is `db` (8, "data-layer code with zero test reach — integrity risk") or `api` (6, "API surface with zero test reach — contract risk"), THEN schedule next: integrity and contract risk outrank UI polish.
3. IF a gap's area is `ui` (4, "UI code with zero test reach — user-facing risk"), THEN close it when the flow is user-visible; note that weight ≥ 4 is exactly the engine's gap-reporting floor.
4. IF an uncovered file's weight is below 4 (`infra` 3, `config` 2, `unknown` 1), THEN the engine does not report it as a gap — mention in the report that infra/config blind spots exist by design and are not license to ignore them, just lower priority.
5. IF `docs`/`test` files appear uncovered, THEN do not count them anywhere: they are excluded from the substantive set (weight 0) — coverage theater over markdown is waste.
6. IF `criticalFlowCoverage` marks a flow uncovered with note "files exist but no test reaches them", THEN treat it as a blocking-shaped finding for release planning: a named critical flow with zero reach is the sharpest signal this report produces.
7. IF a flow's note reads "no source files matched this flow pattern — check config patterns", THEN fix the config, not the tests: the flow is unmeasured, not uncovered — report it as `NOT_VERIFIED` rather than as a gap.
8. IF `weightedCoverage < qualityGates.minWeightedCoverage` (default 60), THEN report the gate warning with the number and the top gaps that would close it fastest (by riskWeight); the gate is a warning input to release evaluation, not a merge veto by itself.
9. IF uncovered code is generated, types-only declarations, or trivially unreachable glue, THEN record an explicit waiver with the reason in the report ("acceptable gap: generated client code") — an accepted gap with a written reason is honest; an unnoticed one is debt. Waivers must be per-file and re-justified when the generator changes.
10. IF a file is covered by exactly one test that itself scores poorly (from `qa review`), THEN annotate the gap entry: technically covered, effectively fragile — coverage counts tests, not trust.
11. IF line coverage and weighted coverage disagree sharply (high lines, low weighted), THEN surface the mutation-aware framing: what matters is where mutants would survive — an uncovered payment branch kills trust faster than 500 uncovered doc-helper lines.

## Workflow

The lifecycle seat of this skill is MEASURE — it is audit machinery, not a gate bypass:

| Phase | Role of this skill |
|---|---|
| DISCOVER | Source file + inventory collection (`discover`/`listFiles`). |
| MODEL | Area weights per file; critical-flow pattern mapping. |
| PLAN | Gap-closing plan ordered by riskWeight; waiver candidates flagged. |
| GENERATE | Gap list is the generation backlog input (plan cases per gap). |
| VALIDATE | Verify covers maps are current (re-run import closure after refactors). |
| EXECUTE | Not applicable (inventory-based, not run-based). |
| OBSERVE | Not applicable. |
| TRIAGE | A REAL_REGRESSION in an uncovered file is coverage's fault — record the gap retroactively. |
| HEAL | Not applicable. |
| VERIFY | Re-run analysis after generated tests land; the gap list must shrink. |
| MEASURE | **Primary phase**: weightedCoverage, fileCoverage, gaps, criticalFlowCoverage; feeds suite-health components (functional coverage 15, risk coverage 10). |
| LEARN | Waivers and gap-closure outcomes recorded; recurring gap areas become generation priorities. |

### Weight and gap semantics (engine constants)

| Area | riskWeight | Gap reported? | Gap reason string (verbatim from engine) |
|---|---|---|---|
| `payment` | 10 | yes | "payment logic with zero test reach — highest-priority gap" |
| `auth` | 10 | yes | "authentication code with zero test reach — security-critical gap" |
| `db` | 8 | yes | "data-layer code with zero test reach — integrity risk" |
| `api` | 6 | yes | "API surface with zero test reach — contract risk" |
| `ui` | 4 | yes | "UI code with zero test reach — user-facing risk" |
| `infra` | 3 | no (below floor) | — |
| `config` | 2 | no (below floor) | — |
| `unknown` | 1 | no (below floor) | — |
| `test` / `docs` | 0 | excluded entirely | — |

The gap floor is part of the semantics: only weight ≥ 4 areas produce `CoverageGap` entries. `weightedCoverage = coveredWeight / totalWeight × 100` (rounded to 0.1); `fileCoverage` counts files with ≥ 1 covering test over the same substantive set. Gaps are capped at 50 in the report, sorted by riskWeight desc then path — assume truncation when the list hits 50 and say so.

## Anti-patterns

- Reading `weightedCoverage` as a quality score: it measures REACH (some test touches the file), never correctness of what the test asserts.
- Chasing the number with low-value tests (asserting on generated types) instead of closing payment/auth gaps — the weights exist to make that trade visibly bad.
- Treating the 60% gate as a certificate: it is a warning input; PASS_WITH_WARNINGS still ships the warning to humans.
- Ignoring sub-4-weight blind spots because the engine does not list them — unreported is not nonexistent.
- Writing a waiver after the fact to pass a gate without recording why the code is acceptable to leave untested.
- Quoting `fileCoverage` alongside line coverage as if they measured the same thing — file coverage counts files with ≥ 1 covering test; it says nothing about branch behavior.
- Letting a `criticalFlow` stay misconfigured (pattern matching nothing) across reports — an unmeasured flow reported as "covered: false" is data corruption of the decision-making kind.
- Reporting a single number without its twin: weighted and file coverage answer different questions and diverging values are the interesting signal.
- Treating `coveredBy: []` gaps as final truths without checking inventory staleness — a covers map from before a refactor reports gaps that no longer exist.

## Failure handling

- Empty inventory → weightedCoverage 0 with an explicit "no tests inventoried" note; do not present 0% as a measured achievement of an unmeasured suite.
- Empty sourceFiles → refuse to compute (0/0); ask for the discovery run.
- covers maps reference files not in `sourceFiles` → they are ignored by the weighting (no totalWeight contribution); state the count of dangling references so inventory drift is visible.
- Config has no `criticalFlows` → the section is reported empty; recommend defining flows for checkout/auth-style paths rather than leaving the sharpest signal off.
- Gate input missing → the release gate treats absent coverage as no-warning-from-coverage; do NOT interpret absence as a pass — say "not measured".
- Dangling `coveredBy` references (tests covering files outside the source set) → they contribute nothing to either weight; count and report them as inventory drift.
- Critical flow patterns that match hundreds of files → the flow's covered flag becomes weak evidence (any one covered file flips it); tighten patterns or split the flow rather than trusting a broad match.

## Evidence requirements

- `weightedCoverage`, `fileCoverage`, gaps, and flow statuses: `INFERRED` (the engine labels the whole report so; static reach analysis).
- "This file is covered" claims: `OBSERVED` only after reading the covering test and confirming it exercises the file's behavior — otherwise it is the inventory's `INFERRED` reach.
- Waivers: `CONFIRMED` only with a recorded human decision; self-granted waivers stay `INFERRED` and flagged as such.
- Gate comparisons: quote both numbers (`weightedCoverage` vs `minWeightedCoverage`) — never paraphrase "below the gate" without them.
- Waived files remain visible in the report with their waiver reason; a waiver hides the file from the GAP list, never from the report.
- Flow notes: reproduce the engine's exact note strings; paraphrasing "no source files matched this flow pattern" into "flow covered" is fabrication.

## Safety constraints

- Safety class: `READ_ONLY` — coverage computes from inventory and writes nothing (ACTION_POLICIES).
- No `--confirm-risk` path exists; any generation work that closes gaps belongs to the generation skill.
- Golden rules engaged: 4 (never claim verification without execution evidence — coverage is not verification), 5 (never generate massive redundant E2E suites to move the number — pyramid policy penalizes it), 14 (explain decisions — every gap carries an area-based reason string), 15 (signal over count — one auth gap outweighs fifty config files).

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "INFERRED",
  "data": {
    "weightedCoverage": 71.4,
    "fileCoverage": 64.2,
    "gaps": [
      { "path": "src/payments/charge.ts", "area": "payment", "riskWeight": 10, "coveredBy": [], "reason": "payment logic with zero test reach — highest-priority gap" },
      { "path": "src/db/migrations/007-audit.ts", "area": "db", "riskWeight": 8, "coveredBy": [], "reason": "data-layer code with zero test reach — integrity risk" }
    ],
    "criticalFlowCoverage": [
      { "flow": "checkout", "covered": true, "note": "covered via 3 matched files" },
      { "flow": "password-reset", "covered": false, "note": "files exist but no test reaches them" }
    ],
    "gate": { "minWeightedCoverage": 60, "warning": false },
    "waivers": [ { "path": "src/generated/client.ts", "reason": "generated code — acceptable gap (recorded)" } ]
  }
}
```

`data` mirrors core `CoverageReport` (rounded to 0.1) plus the gate comparison; gaps are capped at 50, sorted by riskWeight desc then path.

## Examples

### Walkthrough 1 — release-gate check before a payment release
Coverage runs over 214 source files. Weighted coverage lands at 58.6% — below the 60 gate — because `src/payments/refund.ts` (weight 10) and `src/db/settle-batch.ts` (weight 8) have zero test reach. The agent reports the gate warning with both numbers, lists the two gaps with the engine's reason strings, and prices the fix: covering those two files alone lifts weighted coverage past the gate (their weights dominate the denominator contribution). The critical flow `payout` shows "files exist but no test reaches them" — reported as the sharpest finding, above the percentage. A proposed waiver for the generated Stripe client is recorded with its reason and marked `INFERRED` until a human confirms it.

### Walkthrough 2 — line coverage says 82%, weighted says 44%
A team quotes 82% line coverage. Weighted analysis over the same repo: 44.2% — the covered mass is UI helpers (weight 4) and docs-adjacent scripts, while `src/auth/session.ts` (10) and `src/api/orders.ts` (6) are reached by nothing. The agent reframes per rule 11: line coverage measures executed statements, weighted coverage measures whether the files where surviving mutants would cost money are even touched; the mutation-aware question is not "did the lines run" but "would a broken session cap produce a red test". Generation work is planned against the riskWeight-sorted gap list: session cap tests first, orders API contract tests second. The 82% number is recorded but explicitly not used as a gate argument.

## Verification checklist

- [ ] Gap list was sorted by riskWeight (payment/auth first) and quoted the engine's reason strings.
- [ ] The 60-gate comparison used both numbers, not a paraphrase.
- [ ] Critical-flow notes were reproduced exactly; misconfigured patterns were flagged `NOT_VERIFIED`, not counted as gaps.
- [ ] docs/test files were excluded from all coverage math (weight 0).
- [ ] Every waiver names its file and reason and is marked pending human confirmation unless `CONFIRMED`.
- [ ] No claim was upgraded from INFERRED reach to OBSERVED verification without reading the covering test.
- [ ] Sub-weight-4 blind spots were acknowledged in the report even though the engine omits them.
- [ ] The gap list's 50-item cap was mentioned whenever truncation was possible.
- [ ] Area classifications behind the top gaps were spot-checked (a payment file misread as `unknown` loses 9 weight points).
- [ ] The report stayed READ_ONLY: analysis and recommendations, no generated tests in this skill.
