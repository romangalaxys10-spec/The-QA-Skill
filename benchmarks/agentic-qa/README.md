# Agentic-QA benchmark

The measurement harness for The-QA-Skill's deterministic engines. It executes the
real engine code from `packages/core/src` against the fixture corpus in
`fixtures/` and writes honest numbers to this directory:

- `results.json` — full machine-readable detail (per-fixture checks, contexts, confusion counts, runtime).
- `results.md` — the human-readable report with the honesty statement, per-engine summary, per-fixture table and known misses.

## How to run

```sh
npm run benchmark
# equivalently:
node_modules/.bin/tsx benchmarks/agentic-qa/run.ts
```

Requirements: Node ≥ 18, `git` on PATH (fixtures are materialized into real
throwaway git repositories), and the repo's devDependencies installed
(`tsx` is the only runtime need; engines are imported from source, no build step).

Exit code: `0` for a completed measurement run — **a fixture expectation that
fails is reported as data, not a crash**. Only harness faults (git missing,
corpus unreadable, malformed fixture) exit non-zero.

## What each metric means

| Metric | Meaning |
| --- | --- |
| `engines.<name>.total/passed/failed` | Counts of **machine expectations checked** against that engine, across all fixtures. One check = one `expect_*` field from `EXPECTED.md`. |
| `triage.pass` | `classifyFailure` returned `expect_category` **and** confidence ≥ `expect_min_confidence`. |
| Triage FP/FN (`triageConfusion`) | For a category mismatch: the expected category is counted as one false negative, the returned category as one false positive. Exact matches add nothing. |
| `quality.pass` | `analyzeTestFile` (min over the fixture's `tests/*.ts`) scored ≤ `expect_quality_score_max`, and every `expect_deduction_dimensions` entry appears in the union of deduction dimensions. Extra deductions are allowed — they only push the score further under a ceiling. |
| `coverage.pass` | `analyzeCoverage` emitted a gap whose `area` equals `expect_gap_area` (gaps require risk weight ≥ 4, so docs/config/test files never appear). |
| `risk.pass` | `assessRisk` over the materialized `HEAD~1..HEAD` diff produced the tier `expect_risk_tier` (including the documented tier floors — payment/migration can force `critical` regardless of the weighted score). |
| `selection.pass` | `selectTests` (PR policy, routing hints from `classifyRouting`) picked ≥ `expect_selected_tests_min` inventory tests covering the change set. |
| `runtimeMs` | Wall-clock per fixture: `git init` + commit sequence + diff parsing + engine calls. It is an infrastructure number, not an engine-quality number. |

`selection` currently reads zero: no fixture in the corpus declares
`expect_selected_tests_min` yet. The row exists so the first such fixture is
measured the moment it lands.

## Honesty statement

- Measured **only** on the 13 fixture corpora of this repository. Nothing is
  extrapolated to other repos, languages or suites.
- The engines are **deterministic**: no LLM, no network, no randomness, no
  wall-clock inputs participate in any decision. Re-running the harness
  reproduces every engine output byte-for-byte (timestamps in `results.json`
  excepted).
- The engine code under test is imported from `packages/core/src` — the same
  functions the CLI and agents call. The harness never re-implements or
  special-cases an engine.
- Fixture expectations (`EXPECTED.md` machine fields) are treated as the spec;
  the harness never weakens an engine to make a fixture pass. When a fixture
  expectation is genuinely unreachable by the documented engine rules, it is
  reported under **Known misses** in `results.md`.
- Triage context construction follows the runner contract: `coversChangedCode`
  is true when the failing record's runner-reported `changedFiles` (the
  import-closure evidence recorded at run time) intersects the materialized
  change set; `selectorChangedInDiff` is `detectSelectorChange` over the test
  source against the commit-2 `app/` diff (removed **and** added lines).

## Corpus

| Fixture | Engine | What it exercises |
| --- | --- | --- |
| `a11y-regression` | triage | Rule 3 with `selectorChangedInDiff=true` (prop rename; literal appears on both diff sides) → SELECTOR_FAILURE 0.9 |
| `api-regression` | triage | Rule 10, deterministic assertion failure over changed code → REAL_REGRESSION 0.92 |
| `auth-bug` | triage | Rule 10; coversChangedCode via the import closure of the changed session module |
| `db-regression` | triage | Rule 6 data-integrity signature, context-independent → TEST_DATA_DEFECT 0.8 |
| `false-negative` | quality | Assertion-starved happy-path file; ceiling 80 + `assertionStrength` required |
| `false-positive` | quality | Zero assertions + a `setTimeout` warm-up; ceiling 70 + `assertionStrength`,`determinism` |
| `flaky-test` | triage | Rule 7 exception (timeout-shaped, retry-pass, intermittent history) → FLAKE 0.88 |
| `missing-coverage` | coverage | Weighted coverage collapse; the api-area gap must be emitted |
| `payment-regression` | risk (+triage) | Tier floor: payment change → `critical` despite a ~25-line diff; plus rule 10 triage side |
| `race-condition` | triage | Rule 8 flake signature with empty runner change set → FLAKE 0.88 |
| `selector-change` | triage | Rule 3 with the renamed test id present on the removed diff side → SELECTOR_FAILURE 0.9 |
| `visual-regression` | triage | Rule 10 on screenshot-diff signatures → REAL_REGRESSION 0.92 |
| `weak-assertion` | quality | Tautology + happy-path-only file; ceiling 75 + three required dimensions |

## How to extend

1. Create `fixtures/<name>/` with:
   - `commits.json` — array of `{ message, files: { "<rel path>": "<full content>" } }`;
     the last entry is the change set under test.
   - `evidence/failures.json` — `FailedTestRecord[]` (`packages/core/src/types.ts`),
     including full `attempts` (status/errorType/errorMessage/errorStack),
     runner-reported `changedFiles`, `recentRuns`.
   - `app/` and `tests/` trees matching the committed content.
   - `EXPECTED.md` with machine fields (all `- key: value` lines):
     `- engine:` (triage | quality | coverage | risk | selection) plus the
     matching `expect_*` fields:
     | Engine | Fields |
     | --- | --- |
     | triage | `expect_category`, `expect_min_confidence` |
     | quality | `expect_quality_score_max`, `expect_deduction_dimensions` (comma-separated) |
     | coverage | `expect_gap_area` |
     | risk | `expect_risk_tier` |
     | selection | `expect_selected_tests_min` |
     Dual-engine fixtures simply carry both engines' fields (see
     `fixtures/payment-regression`). Add a `notes:` paragraph explaining the
     expected engine walk so the number is auditable.
2. `node scripts/validate-fixtures.js` must pass.
3. `npm run benchmark` — the new fixture appears in `results.md` automatically;
   `scenario.json` is a static index of the corpus (name → declared engine),
   kept for tooling convenience; `run.ts` always derives everything live from
   `EXPECTED.md`, so `EXPECTED.md` stays the single source of truth.
4. If the new fixture fails: fix the harness first, then the fixture; if the
   expectation is genuinely unreachable by the documented engine rules, leave
   it failing and document it under Known misses — do not weaken the engine.

## Layout

```
benchmarks/agentic-qa/
├── run.ts         # the harness (this directory's only logic)
├── scenario.json  # static index of the corpus (name → engine)
├── results.json   # generated — full detail
└── results.md     # generated — human-readable report
```
