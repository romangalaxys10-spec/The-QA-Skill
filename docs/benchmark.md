# Benchmark

**Audience:** contributors measuring the engines and extending the fixture corpus.
**Source of truth:** `fixtures/` (13-fixture corpus, each with `README.md`, `EXPECTED.md`, `commits.json`, `evidence/failures.json`), `/home/z/my-project/scripts/validate-fixtures.js` (corpus validator), root `package.json` (`"benchmark": "tsx benchmarks/agentic-qa/run.ts"`), `docs/enterprise-qa-gap-analysis.md` §5 (why the corpus exists), `docs/migration-map.md` (agent-evaluation benchmark row).

**Status note:** the fixture corpus and validator are complete and validated (13/13); the harness script `benchmarks/agentic-qa/run.ts` is the registered benchmark entrypoint (`npm run benchmark`) and implements the materialization protocol below. This doc specifies the protocol and grading contract that harness implements — verify a metric against actual `run.ts` output before quoting it anywhere.

## Why a benchmark

The gap analysis (`docs/enterprise-qa-gap-analysis.md`) closes with the same sentence this doc enforces: claims about closing the QA gap are **measured, not asserted**. The corpus is a set of small, deliberately broken applications with planted defects and machine-checkable expected diagnoses, so every engine change can be graded against a stable target instead of a vibe.

## The 13-fixture corpus

| Fixture | Engine | Planted defect (one-liner) | Expected outcome key |
|---|---|---|---|
| `auth-bug` | triage | Session hard cap anchored to issue time rejects live remembered-device sessions | `expect_category: REAL_REGRESSION`, `expect_min_confidence: 0.9` (engine returns 0.92) |
| `api-regression` | triage | Invalid draft orders answered with 200 instead of 400 | `REAL_REGRESSION` ≥ 0.9 |
| `visual-regression` | triage | Hero layout rework breaks visual baselines | `REAL_REGRESSION` ≥ 0.7 (honesty margin below the engine's 0.92 — see EXPECTED notes) |
| `payment-regression` | risk | Retry path double-charges | `REAL_REGRESSION` ≥ 0.85 **and** `expect_risk_tier: critical` |
| `selector-change` | triage | Checkout CTA test id renamed in the UI | `SELECTOR_FAILURE` ≥ 0.85 |
| `a11y-regression` | triage | Icon button loses its accessible name | `SELECTOR_FAILURE` ≥ 0.8 |
| `flaky-test` | triage | Cold-runner per-test timeout on dashboard hydration | `FLAKE` ≥ 0.85 (exercises the rule-7 exception: timeout-shaped retry-pass → FLAKE 0.88) |
| `race-condition` | triage | Concurrent completions stamp duplicate event ids | `FLAKE` ≥ 0.7 |
| `db-regression` | triage | Case-insensitive unique index collides with seeded rows | `TEST_DATA_DEFECT` ≥ 0.75 |
| `false-positive` | quality | A search suite that cannot fail (assertions that always pass) | `expect_quality_score_max: 70` (README target 67/100) |
| `false-negative` | quality | The coupon suite cannot fail, so the bug ships green | `expect_quality_score_max: 80` (README target 71/100) |
| `weak-assertion` | quality | Assertions traded for a green checkmark | `expect_quality_score_max: 75` (README target 62/100) |
| `missing-coverage` | coverage | Usage-metering endpoint ships with zero test reach | `expect_gap_area: api` |

Fixture families: 9 triage, 3 quality, 1 coverage (+1 risk assertion folded into `payment-regression`). The validator's engine vocabulary also includes `selection` — no fixture currently grades the selection engine; adding one is the same process as below.

## Materialization protocol

Every fixture is a self-contained git history in JSON:

- **`commits.json`** — an array of ≥ 2 commits, each `{ message, files: { "<path>": "<full file content>" } }`. The last commit plants the defect; earlier commits establish the working baseline.
- The harness materializes the protocol: create a temp git repo, replay the commits in order (write files, `git add`, `git commit -m <message>`), then **run the engine under test against the change range** `HEAD~1..HEAD` (diff → changed files → `TriageContext`, import-closure coverage, quality static analysis, or risk assessment as the fixture's `engine` demands).
- **`evidence/failures.json`** — the recorded run evidence the triage engine consumes: a `FailedTestRecord[]` (fields `testId`, `name`, `filePath`, `layer`, `attempts` with status/timestamp/environment/error fields, `changedFiles`, `recentRuns`, optional `networkVerified`/`domVerified`). The harness feeds these records plus the materialized diff context to `classifyFailure`/`clusterFailures` — the benchmark measures the engines on recorded evidence, not live browser execution.

## Grading rules (EXPECTED.md machine fields)

`EXPECTED.md` is a `- key: value` list parsed by the validator and the harness:

| Field | Meaning | Enforced by validator? |
|---|---|---|
| `engine` | Which engine grades this fixture: `triage | coverage | quality | selection | risk` | yes — must be in the vocabulary |
| `expect_category` | Required triage category (one of the 12 `FailureCategory` values) | yes |
| `expect_min_confidence` | Floor the engine's confidence must meet (`0.`-style decimal) | yes |
| `expect_gap_area` | Required coverage gap area (one of the 10 `ChangeArea` values) | yes |
| `expect_risk_tier` | Required risk tier (`critical | high | medium | low`) | yes |
| `expect_quality_score_max` | Ceiling the quality score must stay under | consumed by the harness (quality fixtures carry it) |
| `expect_selected_tests_min` | Minimum selected-test count for `selection` fixtures | reserved; no fixture uses it yet |
| `notes` | Free-text reasoning (≥ 40 chars, validator-enforced) — walks the decision rule by rule so expectations are auditable | yes |

A fixture **passes** when the engine's output satisfies every `expect_*` field present for its `engine` (triage: category + min-confidence; quality: score ≤ max; coverage: gap area present in reported gaps; risk: tier floor). A `min_confidence` floor below the engine's documented constant (e.g. visual-regression's 0.7 vs 0.92) is deliberate honesty margin, not sloppiness — the notes explain the gap.

## Per-engine grading detail

| Engine | Invoked with | Output field compared | Pass condition |
|---|---|---|---|
| `triage` | `evidence/failures.json` records + `TriageContext` derived from the materialized diff (import closure for `coversChangedCode`, diff text for `detectSelectorChange`) | `TriageResult.category`, `TriageResult.confidence` | category equals `expect_category` **and** confidence ≥ `expect_min_confidence` |
| `quality` | each fixture test file's source | `TestQualityReport.score` | score ≤ `expect_quality_score_max` |
| `coverage` | source files + test inventory from the materialized repo | `CoverageReport.gaps[].area` (or the reported gap set) | a gap in `expect_gap_area` is reported |
| `risk` | the changed-file set of the planting commit | `RiskAssessment.tier` | tier equals or exceeds `expect_risk_tier` in the engine's `critical > high > medium > low` ordering |
| `selection` | changed files + inventory | `SelectionResult.selected` | ≥ `expect_selected_tests_min` (reserved — no fixture yet) |

Triage fixtures are the ones that exercise **context derivation**, not just the decision table: `auth-bug`'s notes explicitly require the harness to compute `coversChangedCode=true` through the import closure (`tests/auth.spec.ts → tests/helpers/test-app.ts → app/http/auth-middleware.ts → app/lib/session.ts`), and `selector-change`/`a11y-regression` require `selectorChangedInDiff=true` from the diff text. A harness that hard-coded these booleans would inflate triage metrics — grade the derivation too.

## Corpus design principles

1. **One planted defect per fixture.** A fixture grading two things proves nothing when it fails.
2. **Traceable expectations.** Every `notes` field walks the documented decision table rule by rule (which rules matched, which could not), so a mismatch localizes to a specific rule — see `auth-bug`'s notes for the canonical example.
3. **Deterministic evidence.** `failures.json` records fixed attempts (statuses, error text, environments) — no randomness, no wall-clock dependence; reruns must be byte-identical in verdict.
4. **Realistic shapes.** Error strings mirror real runner output (Playwright locator timeouts, Postgres integrity errors, Playwright screenshot-diff messages) so the pattern tables are graded against the shapes they will meet in production.
5. **History matters.** Fixtures deliberately vary `recentRuns` (all-passed vs mixed) and retry patterns, because those flags decide between `REAL_REGRESSION`, `FLAKE`, and `TIMING_FAILURE` in the decision table.

## What a failing fixture means

- **Engine below floor / wrong category** → either an engine regression (a pattern or constant changed) or a decision-table fix that was never reflected in `EXPECTED.md`. Diff the `notes` walk against the failing result; fix the engine when the notes are right, fix the fixture (and say so in `notes`) when the expectation was wrong.
- **Quality fixture scoring too high** → the score engine got more lenient; these three fixtures exist specifically to catch assertion-strength and can't-fail blindness, the classic false-positive/false-negative root causes (`docs/enterprise-qa-gap-analysis.md` rows 7).
- **Harness failure (not engine failure)** → materialization or context-derivation bug; the fixture verdict is invalid, not merely failing.

## Relationship to the agent benchmark

`benchmarks/agentic-qa` is also the registered home of the agent-evaluation benchmark (`docs/migration-map.md`): beyond the engine fixtures graded here, the harness measures agent behaviors — repo-inspection, file-targeting, convention obedience, overfitting, false claims, and failure recovery — against the same materialized fixtures. The engine metrics in this doc are the deterministic floor; agent metrics measure whether a coding agent *uses* the platform honestly on top of it. Keep the two report sections separate and never average them.

## Metric definitions

All metrics are computed **per benchmark run over the corpus**, from harness output only:

- **Detection rate** — fraction of fixtures where the graded engine produced the expected finding (triage category match, gap-area hit, quality-flag trip, risk-tier floor).
- **False-positive (FP) rate** — fraction of fixtures where the engine asserted a *specific wrong* diagnosis (e.g. `REAL_REGRESSION` on `flaky-test`), as opposed to an honest low-confidence/UNKNOWN answer. An `UNKNOWN` with a below-floor confidence is not an FP; it is a miss.
- **False-negative (FN) rate** — fraction of fixtures where the engine failed to produce the expected finding (including UNKNOWN and under-confidence). FN rate = 1 − detection rate for triage; keep the two names because quality/coverage fixtures grade flags, not categories.
- **Triage accuracy** — detection rate restricted to the 9 triage fixtures, with the additional requirement that `confidence ≥ expect_min_confidence`.
- **Risk-tier accuracy** — fraction of risk-graded fixtures whose assessed tier meets `expect_risk_tier`.
- **Quality-flag accuracy** — fraction of quality fixtures whose score lands at or under `expect_quality_score_max` (a *too-generous* score is the failure mode these fixtures exist to catch).
- **Runtime** — wall-clock per engine over the corpus (materialization excluded from engine time, included in the report as its own line).

Report every metric with the corpus size (n=13 or the applicable subset) — a bare percentage without its denominator is not a benchmark number.

## Honesty rules

1. **Numbers only from benchmark output on this repo's fixtures.** No claimed detection/accuracy figure may come from hand-running a single case, from another repository, or from memory of a previous corpus.
2. **No external vendor comparisons.** The corpus grades The-QA-Skill's engines against their own documented expectations; it contains no comparative claims about other products and must never be quoted as one.
3. **Reruns are recorded.** Every benchmark invocation appends its result (date, commit, per-fixture verdicts, metrics) to the run report; a number without its rerun lineage is not quotable. Engines are deterministic, so same-input reruns must agree — disagreement indicates a harness or fixture regression, and the run is invalid.
4. Floors are honesty margins: where `expect_min_confidence` sits below the engine constant, quote **both** numbers or neither.

## How to run

```bash
npm run benchmark        # tsx benchmarks/agentic-qa/run.ts → benchmarks/agentic-qa
node /home/z/my-project/scripts/validate-fixtures.js   # corpus integrity gate (13/13 must pass first)
```

The validator must pass before benchmarking — a corpus with a malformed fixture produces meaningless metrics. The harness report lands under `benchmarks/agentic-qa/` with per-fixture verdicts and the aggregate metrics above.

### Per-fixture verdict shape

The harness reports one verdict per fixture (shape below is the report contract; values are illustrative until `run.ts` lands — then replace with real output):

```
fixture             engine    expected                actual                pass
auth-bug            triage    REAL_REGRESSION ≥ 0.9   REAL_REGRESSION 0.92  ✓
flaky-test          triage    FLAKE ≥ 0.85            FLAKE 0.88            ✓
weak-assertion      quality   score ≤ 75              62                    ✓
missing-coverage    coverage  gap in 'api'            gap in 'api' reported   ✓
```

The `expected` column restates the machine fields verbatim; the `actual` column quotes the engine's own output (category + confidence, score, gap area) so a human can audit any row against `EXPECTED.md` without re-running the harness. Aggregates (detection, FP/FN, accuracies, runtime) are computed from these rows and always carry n.

### Reproducibility

Materialized repos live in temp directories that the harness cleans up; nothing in the corpus mutates `fixtures/` in place. Because engines are deterministic and evidence is fixed, two runs on the same commit must produce identical verdicts — a diff between reruns is itself a finding (report it, don't average it away).

## How to add a fixture

1. Create `fixtures/<name>/` with the five required parts: `README.md` (headline: what breaks and what the engine should say), `EXPECTED.md` (machine fields + ≥ 40-char reasoning `notes`), `commits.json` (≥ 2 commits; final commit plants the defect), `evidence/failures.json` (a valid `FailedTestRecord[]`; attempts need valid statuses from `passed|failed|skipped|timedout|not_run` plus timestamp/environment), and the app/test source files the commits reference.
2. Add `<name>` to the `NAMES` list in `/home/z/my-project/scripts/validate-fixtures.js` (the validator iterates an explicit list, not the directory).
3. Run the validator and the benchmark; the fixture ships only when both pass — an `EXPECTED.md` that the current engine fails is either a real engine bug (file the gap, fix the engine) or a wrong expectation (fix the fixture and say so in `notes`).
4. Keep each fixture minimal: one planted defect, one expected outcome, decisions traceable through the documented decision tables (`docs/failure-triage.md`, `docs/self-healing.md`).

## Known limitations

- **Heuristic engines.** Triage is a regex/flag decision table; it does not execute code or reason semantically. Patterns can be evaded by unusual error phrasing (that is what `UNKNOWN` and the benchmark floors measure).
- **Static analysis scope.** Quality scoring is static (source-level dimension checks); coverage is import-closure based — dynamic routes, reflection, and string-built imports are invisible to it.
- **No browser execution in the harness.** The corpus grades engines against recorded evidence (`failures.json`), not live runs; runner behavior (spawning, parsing, timeouts) is covered by unit tests, not this benchmark.
- **Small corpus.** n=13 gives coarse confidence intervals; percentages move in steps of ~7.7 points. Prefer trend statements over point claims when quoting.
- **Selection engine ungraded.** No fixture exercises test selection yet (`selection` is in the engine vocabulary with zero rows) — the honest current statement is "selection is unit-tested, not benchmarked."

## Verification

- [ ] Corpus table above matches the 13 directories in `fixtures/` and their `README.md` headlines (verified by direct read this session).
- [ ] Every `engine` / `expect_category` / `expect_min_confidence` / `expect_gap_area` / `expect_risk_tier` / `expect_quality_score_max` value quoted matches the corresponding `EXPECTED.md` line exactly.
- [ ] Validator contract matches `/home/z/my-project/scripts/validate-fixtures.js`: 5 required parts, `NAMES` list of 13, ≥ 2 commits with non-empty `files`, attempt statuses from the 5-value vocabulary, engine/category/area/tier vocabularies, confidence decimal regex, notes ≥ 40 chars, collects-all issue reporting, exit 1 on any problem.
- [ ] `npm run benchmark` script string verified in root `package.json` (`tsx benchmarks/agentic-qa/run.ts`).
- [ ] `npm test` (vitest) still passes after any fixture or engine change — fixture expectations and engine constants must not drift apart silently.
- [ ] Any quoted metric in downstream docs carries: corpus size, run date/commit, and per-fixture verdict lineage from a recorded rerun.
- [ ] No external-vendor comparison appears in any benchmark-derived output.
- [ ] This doc's status note is removed or updated once `benchmarks/agentic-qa/run.ts` ships and metrics can be quoted from its output.
