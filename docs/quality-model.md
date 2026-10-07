# Quality Model — The-QA-Skill

> Sponsored by xShredo.dev → https://xshredo.com/promo/anytest

**Audience:** contributors and agent authors. This document describes the test-quality
engine in `packages/core/src/quality/` (`dimensions.ts`, `score.ts`) exactly as
implemented: the 17 dimensions, how `analyzeTestFile` computes deductions, the
`suiteHealth` components, the verification-label lifecycle, the mutation-aware framing,
and duplication detection — including what the engine honestly cannot see.

---

## 1. The 17 quality dimensions

`QUALITY_DIMENSIONS` (`quality/dimensions.ts`) is the vocabulary of test quality for the
whole platform. Weights sum to **100** (checked below); `DIMENSION_BY_ID` maps ids for
lookup.

| # | id | Weight | Description (verbatim from source) |
|---|---|---|---|
| 1 | `correctness` | 10 | Test asserts the actual intended behavior (not implementation details). |
| 2 | `determinism` | 9 | No arbitrary sleeps, no reliance on wall-clock or random without seeds. |
| 3 | `isolation` | 8 | Test sets up its own state; no ordering dependencies; parallel-safe. |
| 4 | `assertionStrength` | 10 | Assertions verify outcomes precisely; no tautologies. |
| 5 | `behaviorCoverage` | 7 | Covers observable behavior, not private internals. |
| 6 | `negativeCoverage` | 7 | Covers failure paths: invalid input, denied access, error responses. |
| 7 | `boundaryCoverage` | 6 | Zero/one/max/min/empty/null/duplicate/expired/malformed cases. |
| 8 | `maintainability` | 5 | Reasonable size, clear names, helpers extracted, no copy-paste walls. |
| 9 | `readability` | 4 | Arrange-Act-Assert readable; intent evident from names. |
| 10 | `runtime` | 5 | Efficient: no needless waits; appropriate layer. |
| 11 | `duplication` | 4 | No near-duplicate tests covering identical behavior. |
| 12 | `mockQuality` | 5 | Mocks match real contracts; not over-mocked; restored after test. |
| 13 | `dataQuality` | 5 | Factories/seeds; unique identities; no shared mutable fixtures. |
| 14 | `security` | 5 | No hardcoded secrets; no prod credentials; no sensitive logging. |
| 15 | `accessibility` | 3 | Uses accessible queries (role/label) where UI is involved. |
| 16 | `observability` | 4 | Failures produce useful evidence; no swallowed errors. |
| 17 | `evidenceQuality` | 3 | Failure messages carry context for triage. |

Weight sum: 10+9+8+10+7+7+6+5+4+5+4+5+5+5+3+4+3 = **100**.

The weights are scoring **buckets**, not multipliers of measured quantities: each
deduction names the dimension it costs points from, and a dimension can only lose its
own bucket.

## 2. How `analyzeTestFile` computes deductions

```ts
analyzeTestFile(filePath: string, source: string): TestQualityReport
// TestQualityReport = { filePath, score: 0..100, testCount, deductions[], strengths[], label: 'INFERRED' }
```

The engine is **static regex analysis over the source text**. It counts test cases with
`/\b(?:test|it|test\.skip|it\.skip|it\.only|test\.only)\s*\(/g`, scans line-by-line for
known defect shapes, and pushes `QualityDeduction {dimension, points, reason, line?}`
entries. `score = clamp(100 − Σ points)` (clamped to 0..100); deductions are returned
sorted by points, descending; recognized good patterns are recorded in `strengths[]`
(e.g. "no arbitrary sleeps (web-first waiting)", "uses accessible role/label-based
queries").

Deduction table (every rule as coded):

| Dimension | Trigger | Points | Notes |
|---|---|---|---|
| `determinism` | `waitForTimeout(`, `.sleep(`, or `setTimeout(…, ≥3 digits)` found on N lines | `min(15, 8×N)` | Golden rule 3 — arbitrary sleeps are forbidden as a first fix |
| `determinism` | `Math.random()` present and no `seed`/`deterministic` token | 5 | Unseeded randomness breaks reproducibility |
| `determinism` | `Date.now()`/`new Date()` present and no `fake/mock/freeze/clock/advance` token | 4 | Wall-clock dependence |
| `assertionStrength` | Tautology: `expect(true)`, `expect(1)`, `expect('<literal>')`, `assert.ok()` | 12 | Verifies nothing |
| `assertionStrength` | ≥1 test case but 0 assertions | 25 | Test cannot fail for the right reason |
| `assertionStrength` | assertions < test cases (counting `expect(`/`assert.`/`should .`) | 8 | Some paths end unverified |
| `observability` | Empty catch: `.catch(();)` shape or `catch {}` | 8 | Failures will be invisible |
| `negativeCoverage` | ≥3 test cases and zero negative markers (`invalid, error, reject, denied, unauthorized, forbidden, fail, malformed, missing, negative, bad`) | 10 | |
| `boundaryCoverage` | ≥3 test cases and zero boundary markers (`zero, null, undefined, empty, max, min, maximum, minimum, boundary, expired, duplicate, overflow, limit`) | 8 | |
| `isolation` | `beforeAll`/`before` without any `beforeEach`/`setUp` | 6 | Shared mutated state risk |
| `isolation` | Module-level mutable shared state markers | 6 | |
| `security` | Secret-shaped literals (5 `SECRET_PATTERNS`, incl. `sk|pk_(live|test)_…`, `ghp_…`, `AKIA…`, PEM keys) | 25 | Golden rule 8 |
| `security` | Non-localhost URL present together with `prod` in source | 10 | Possible production endpoint |
| `accessibility` | UI test (`page.`/`screen.`/`render(`/`mount(`) with CSS/XPath-only selectors and zero role-based queries | 8 | |
| `maintainability` | File longer than 400 lines | `min(15, floor((loc−400)/40) + 6)` | Split by behavior |
| `runtime` | e2e/spec file with no `waitForTimeout` and neither `expect` nor `await` | 5 | Likely dead weight |
| `duplication` | `detectDuplication(src) > 0.3` (see §6) | 10 | Reason carries the measured percentage |
| `mockQuality` | `jest.mock`/`vi.mock`/`sinon.` present with no `afterEach`/`restore`/`unstub`/`resetAllMocks`/`clearAllMocks` | 6 | Mocks may leak across tests |
| `mockQuality` | More than 4 `jest.mock(`/`vi.mock(` calls | 5 | Over-mocked file |
| `dataQuality` | Identity built from `Date.now()`/`Math.random` suffix for user-ish fields | 4 | Use seeded factories |
| `observability` | More than 2 `console.log`/`console.debug` calls | 4 | Prefer structured reporting/traces |
| `correctness` | `.only(` present | 10 | Silently disables the rest of the suite |
| `correctness` | `.skip(`/`.todo(` present | 5 | Record as test debt with a reason |

### What static analysis can and cannot see

**Can see (literally in the file):** sleeps, unseeded randomness, wall-clock use,
tautologies shaped like `expect(true)`, absence of assertions, empty catches, secret
literals, `.only`/`.skip` debt, CSS-only selectors, missing mock restoration, shingle
duplication within the file.

**Cannot see:** whether an assertion is *semantically* meaningful (a wrong expectation
that still compares real values passes the regex checks); cross-file duplication
(duplication is intra-file only); whether mocks match real contracts; runtime behavior,
ordering effects, or flakiness (that is the flake engine's job, from execution records);
framework-specific semantics beyond the generic shapes above; anything in fixtures,
helpers, or configuration files not passed as `source`.

Because of this, the report's `label` is **`INFERRED` — and the module doc states it is
"upgraded nowhere without execution."** Nothing in the platform promotes a
`TestQualityReport` to `OBSERVED` from static analysis alone.

## 3. `suiteHealth` — the 10 components

```ts
suiteHealth(input: {
  testReports: TestQualityReport[];
  weightedCoverage?: number;
  flakeHealthScore?: number;
  avgRuntimeMs?: number;
  a11yCoverage?: number;
  securityTestCount?: number;
  observabilityEvents?: number;
}): SuiteHealthReport   // { score: 0..100, components: [{component, score, weight, notes}], label: 'INFERRED' }
```

Score = `Σ(component.score × component.weight) / Σ weights`, rounded. Component weights
sum to **100**:

| Component | Weight | Score source |
|---|---|---|
| functional coverage | 15 | `weightedCoverage` (0 when absent) |
| risk coverage | 10 | `weightedCoverage × 0.9` (critical-flow coverage discount) |
| test reliability | 15 | mean of `TestQualityReport.score` over the analyzed files |
| flake health | 15 | `flakeHealthScore` (from the flake engine's `suiteFlakeHealth`) |
| assertion strength | 10 | `avgComponent(reports, 'assertionStrength')` |
| maintainability | 10 | `avgComponent(reports, 'maintainability')` |
| runtime efficiency | 10 | `avgRuntimeMs < 30_000 → 90`; `< 120_000 → 60`; else `30`; 0 when absent |
| accessibility | 5 | `a11yCoverage` if provided, else the a11y component average |
| security | 5 | `85` when `securityTestCount > 0`, else the security component average |
| observability | 5 | `85` when `observabilityEvents > 0`, else the observability component average |

`avgComponent(reports, dim)` starts each file at 100 and subtracts **2 points per
deduction point** recorded for that dimension (`max(0, 100 − 2×points)`), then averages.
The label is `'INFERRED'` — a composite of static signals, not an execution measurement.

## 4. The verification-label lifecycle

`packages/core/src/labels.ts` defines the strength order used everywhere:

```
NOT_VERIFIED (0) < NOT_RUN (1) < INFERRED (2) < OBSERVED (3) < CONFIRMED (4)
```

| Label | Meaning (verbatim) | Where it is assigned |
|---|---|---|
| `NOT_VERIFIED` | No evidence collected — treat as unproven | Gate with no inputs; pipeline products that never got produced; gate verdict `UNKNOWN` |
| `NOT_RUN` | Planned but not executed | Dry-run executions; work blocked/skipped before running |
| `INFERRED` | Derived from evidence by reasoning, not directly observed | `RiskAssessment` (deterministic given heuristic inputs), `SelectionResult`, `TestQualityReport`, `SuiteHealthReport`, `TestPlan`, triage results with `confidence < 0.8` |
| `OBSERVED` | Directly measured during execution | Triage results with `confidence ≥ 0.8`; gate when `evidenceComplete` and verdict is known; pipeline aggregate when events exist |
| `CONFIRMED` | Observed and independently re-verified | Requires `canConfirm(evidence)` — at least one evidence item of `OBSERVED` strength or better |

How a claim moves:

- `NOT_VERIFIED → NOT_RUN`: a plan exists (work was planned) but nothing executed —
  e.g. the orchestrator sets `NOT_RUN` for dry-run pipelines.
- `NOT_RUN / NOT_VERIFIED → INFERRED`: a deterministic engine reasoned over inputs
  (risk, selection, quality, design). This is the *default engine label*, chosen
  deliberately: engines are deterministic given their inputs, but the inputs are
  heuristics, not production measurements.
- `INFERRED → OBSERVED`: direct measurement — a triage classification reaches
  confidence ≥ 0.8 on observed attempts; the gate sees `evidenceComplete = true`.
- `OBSERVED → CONFIRMED`: independent re-verification — `canConfirm()` requires
  OBSERVED-quality evidence (e.g. reproduced on retry), per golden rule 4 ("never claim
  verification without execution evidence").

When a claim may **not** move:

- Static analysis never upgrades a `TestQualityReport` or `SuiteHealthReport` — there is
  no execution to observe.
- An `UNKNOWN` gate verdict stays `NOT_VERIFIED`: "an unverifiable gate verifies
  nothing."
- `strongestLabel` is for *aggregates* (the pipeline takes the strongest honest label
  across products); `weakestLabel` is for *composite claims* — a chain is as weak as its
  weakest link. Neither function invents strength: both only select among labels that
  were legitimately produced.
- Dry-run execution cannot produce `OBSERVED` — the orchestrator aggregates `NOT_RUN`
  for it.

## 5. Mutation-aware framing

Line coverage is not confidence. `analyzeCoverage` (core `coverage/analyze.ts`) computes
**risk-weighted coverage**: source files are weighted by area (`payment` 10, `auth` 10,
`db` 8, `api` 6, `ui` 4, `infra` 3, `config` 2, `unknown` 1, `test`/`docs` 0) and the
score is the covered fraction of *weight*, not of lines. An 82% line score can coexist
with a 44% weighted score when the covered mass is UI helpers and the uncovered mass is
`src/auth/session.ts`. The mutation-aware question the platform asks is not "did the
lines run" but "**would a broken session cap produce a red test**" — i.e. would a
behavior-changing mutant survive the suite.

Where mutation support plugs in (and does not, yet):

1. **There is no mutation-execution engine in the packages.** No package spawns mutant
   binaries. Claiming otherwise would be false.
2. **The learning loop already carries the record type.** `LearningRecordType` includes
   `'mutation_survivor'` (`core/types.ts`), alongside `failure`, `healing_applied`,
   `healing_rejected`, `generation_rejected`, `review_feedback`, `flake_observed`,
   `data_collision`. A mutation harness can append survivor records today; consumers
   query them like any other record.
3. **The benchmark harness uses mutation sets.** `benchmarks/agentic-qa` scenarios carry
   behavior-changing mutations derived from scenario notes (the agent under test never
   sees them). A generated test that still passes under the mutation is recorded as a
   `mutation_survivor` and the scenario fails the overfitting check. This is also the
   one documented place a quality claim can reach `CONFIRMED`: base and defect outputs
   both executed and differ.
4. **Deduction quality gates on it.** The `assertionStrength` deductions (§2) are the
   static proxy for mutation sensitivity: tautologies and missing assertions are exactly
   the shapes under which mutants survive.

## 6. Test duplication detection

```ts
detectDuplication(src: SourceLine[]): number   // 0..1 ratio
```

Implemented in `quality/score.ts`, header: *"Cheap duplicate-block estimate: Jaccard
over 5-line shingles of stripped code."*

1. Strip each line: remove `//` comments, replace string/template literals with `""`,
   trim; drop empty lines. Files with fewer than 10 remaining code lines score 0.
2. Build 5-line **shingles**: for each window `i`, the key is lines `i..i+4` joined with
   `|`; count occurrences in a `Map<string, number>`.
3. `total = Σ count` over all shingles; `duplicated = Σ (count − 1)` for shingles seen
   more than once; ratio = `duplicated / total` (0 when `total` is 0).

A ratio above **0.3** triggers a single `duplication` deduction of 10 points whose
reason carries the measured percentage (`${Math.round(dup * 100)}% duplicated block
content — extract shared flows/helpers`). Honest scope: this detects repeated 5-line
blocks *within one file*; it does not compare two files, and short shared setup under
5 lines is invisible.

## 7. Honest limitations

- **Regex static analysis, stated as such.** Every deduction names its line and reason;
  the engine never returns a bare number. But it flags what it can SEE — the §2
  can/cannot list is the contract.
- **`evidenceQuality` and `behaviorCoverage` have no direct deduction rules.** They
  exist in the dimension table (and in `SuiteHealthReport` vocabulary) but
  `analyzeTestFile` currently emits no deduction keyed to them; their weight is
  effectively unspent by the static engine. This is a deliberate honesty point: the
  engine does not fake coverage of dimensions it cannot measure.
- **Boundary/negative coverage is marker-based.** A test file exercising real boundary
  cases without the English markers (`zero`, `empty`, `expired`, …) will be flagged as
  lacking them; the deduction reason says "detected", not "missing in reality".
- **Duplication is intra-file.** Copy-pasted tests across files are not caught.
- **Suite health inherits static analysis limits**, and its runtime-efficiency and
  flake-health components are only as good as the inputs provided (0 when absent —
  absence drags the composite down rather than being silently skipped).
- **Labels do not upgrade by wishful thinking.** Without execution, `INFERRED` is final
  for quality products; `CONFIRMED` requires independently re-verified observation
  (`canConfirm`), and the benchmark's mutation check is the documented path for
  overfitting detection.

## Verification

- [ ] `QUALITY_DIMENSIONS` has 17 entries and the weights in §1 sum to 100 (count them in `dimensions.ts`).
- [ ] Each deduction rule in §2 matches a code block in `quality/score.ts` (points: sleep `min(15, 8×N)`, no-assertions 25, secrets 25, tautologies 12, `.only` 10, …); score = `100 − Σ points` clamped; deductions sorted by points descending; `label: 'INFERRED'`.
- [ ] `suiteHealth` has exactly the 10 components/weights of §3 summing to 100; `avgComponent` computes `max(0, 100 − 2×points)`; runtime bands are 30_000/120_000 → 90/60/30.
- [ ] `labels.ts`: strength order and `canConfirm` (requires an evidence item with label ≥ OBSERVED); `strongestLabel`/`weakestLabel` semantics.
- [ ] `triage/classify.ts` line: `const label = confidence >= 0.8 ? 'OBSERVED' : 'INFERRED'`.
- [ ] `coverage/analyze.ts`: `AREA_WEIGHT` payment 10 / auth 10 / db 8 / api 6 / ui 4 / infra 3 / config 2 / unknown 1 / test 0 / docs 0.
- [ ] `LearningRecordType` includes `'mutation_survivor'`; no package contains a mutation-execution engine (grep `mutation` in `packages/*/src` → only the type and comments).
- [ ] `detectDuplication`: 5-line shingles, strips comments and string literals, returns `duplicated/total`, 0 under 10 code lines; the `duplication` deduction fires only above 0.3.
- [ ] The sponsor line appears in the header blockquote of this document only.
