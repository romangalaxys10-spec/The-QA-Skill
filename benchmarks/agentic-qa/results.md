# Agentic-QA benchmark results

> **Honesty statement.** These numbers were measured on the 13 fixture corpora of this
> repository (`fixtures/`) using the deterministic engines in `packages/core/src` — the
> same code the CLI and agents ship. No LLM, no network, no randomness and no wall-clock
> inputs participate in any engine decision; runs are byte-for-byte reproducible via
> `npm run benchmark`. Failing expectations are reported as data below, never smoothed.

## Per-engine summary

| Engine | Checks | Passed | Failed | Pass rate |
| --- | ---: | ---: | ---: | ---: |
| triage | 18 | 18 | 0 | 100% |
| quality | 9 | 9 | 0 | 100% |
| coverage | 1 | 1 | 0 | 100% |
| risk | 1 | 1 | 0 | 100% |
| selection | 0 | 0 | 0 | — |

Mean runtime per fixture: **25.48 ms** (git materialization + engine calls).

Notes on counting: one check = one machine expectation from `EXPECTED.md`.
`payment-regression` is a dual-engine fixture (risk primary + triage side), so its
expectations appear in both the risk and triage rows. `selection` has no fixture in
this corpus yet — the row exists and reads zero until one lands.

## Per-fixture detail

| Fixture | Declared engine | Checks (expected → actual) | Result | Runtime |
| --- | --- | --- | --- | ---: |
| a11y-regression | triage | triage/category: SELECTOR_FAILURE → SELECTOR_FAILURE<br>triage/min-confidence: >= 0.8 → 0.90 | PASS | 59.30 ms |
| api-regression | triage | triage/category: REAL_REGRESSION → REAL_REGRESSION<br>triage/min-confidence: >= 0.9 → 0.92 | PASS | 29.65 ms |
| auth-bug | triage | triage/category: REAL_REGRESSION → REAL_REGRESSION<br>triage/min-confidence: >= 0.9 → 0.92 | PASS | 28.22 ms |
| db-regression | triage | triage/category: TEST_DATA_DEFECT → TEST_DATA_DEFECT<br>triage/min-confidence: >= 0.75 → 0.80 | PASS | 27.70 ms |
| false-negative | quality | quality/quality-score-max: <= 80 → 74<br>quality/deduction-dimension: assertionStrength → negativeCoverage, assertionStrength, boundaryCoverage | PASS | 2.84 ms |
| false-positive | quality | quality/quality-score-max: <= 70 → 67<br>quality/deduction-dimension: assertionStrength → assertionStrength, determinism<br>quality/deduction-dimension: determinism → assertionStrength, determinism | PASS | 1 ms |
| flaky-test | triage | triage/category: FLAKE → FLAKE<br>triage/min-confidence: >= 0.85 → 0.88 | PASS | 27.46 ms |
| missing-coverage | coverage | coverage/gap-area: api → api:app/api/usage.ts | PASS | 25.86 ms |
| payment-regression | risk | risk/risk-tier: critical → critical (score 25.2)<br>triage/category: REAL_REGRESSION → REAL_REGRESSION<br>triage/min-confidence: >= 0.85 → 0.92 | PASS | 37.39 ms |
| race-condition | triage | triage/category: FLAKE → FLAKE<br>triage/min-confidence: >= 0.7 → 0.88 | PASS | 37.16 ms |
| selector-change | triage | triage/category: SELECTOR_FAILURE → SELECTOR_FAILURE<br>triage/min-confidence: >= 0.85 → 0.90 | PASS | 26.39 ms |
| visual-regression | triage | triage/category: REAL_REGRESSION → REAL_REGRESSION<br>triage/min-confidence: >= 0.7 → 0.92 | PASS | 27.49 ms |
| weak-assertion | quality | quality/quality-score-max: <= 75 → 58<br>quality/deduction-dimension: assertionStrength → assertionStrength, negativeCoverage, boundaryCoverage, observability<br>quality/deduction-dimension: negativeCoverage → assertionStrength, negativeCoverage, boundaryCoverage, observability<br>quality/deduction-dimension: boundaryCoverage → assertionStrength, negativeCoverage, boundaryCoverage, observability | PASS | 0.81 ms |

## Known misses

None. Every machine expectation in the corpus was met by the documented engine rules.

## Method

1. `EXPECTED.md` machine fields are parsed (`- engine:`, `- expect_category:`, `- expect_min_confidence:`,
   `- expect_quality_score_max:`, `- expect_deduction_dimensions:`, `- expect_gap_area:`, `- expect_risk_tier:`,
   `- expect_selected_tests_min:`).
2. `commits.json` is materialized into a throwaway real git repository (`git init` + one commit
   per entry with the recorded messages); the diff range `HEAD~1..HEAD` is the change set.
3. Engines run from `packages/core/src`: `classifyFailure` (+`detectSelectorChange`) for triage,
   `analyzeTestFile` for quality, `discover`/`inventoryTests`/`computeCoverage`/`analyzeCoverage`
   for coverage, `analyzeDiff`/`classifyRouting`/`assessRisk` for risk, `selectTests` for selection.
   Triage context follows the runner contract: `coversChangedCode` is true when the failing
   record's runner-reported `changedFiles` (the import-closure evidence recorded at run time)
   intersects the materialized change set; `selectorChangedInDiff` is `detectSelectorChange`
   over the test source against the commit-2 `app/` diff (removed + added lines).
4. Exit code is 0 for measured failures (they are data); only harness faults exit non-zero.
