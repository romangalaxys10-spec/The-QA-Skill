---
name: qa-test-review
description: Reviews test files with the 17-dimension quality engine and explains every deduction before any test is rewritten. Read-only gatekeeper that separates blocking findings (secrets, tests that cannot fail) from advisory ones.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa review [paths...] --json"
  mcp: null
  agent: ReviewAgent
  core: "analyzeTestFile(filePath, source) -> TestQualityReport"
---

# QA Test Review

## Purpose

Static, explainable review of test code against the 17-dimension quality model. The engine (`analyzeTestFile` in `packages/core/src/quality/score.ts`) scores a test file 0–100 by subtracting weighted deductions, each carrying a dimension, a point value, a reason, and — where the heuristic can pin it — a line number. This skill instructs the agent on how to READ that report and act on it. The engine's label is always `INFERRED`: it is regex-based static analysis that flags only what it can see in the source. A high score is not proof a test works; a low score is a verified list of concrete defects.

## When to activate

- Before approving a newly generated or hand-written test file (`GENERATE`/`VALIDATE` phases).
- When a test suite keeps passing while defects escape — review assertion strength (`assertionStrength` weight 10).
- When a PR touches test files (`routing.testOnly`) or the review question is raised explicitly.
- Before healing: a test that scores badly for `determinism` (sleeps, unseeded random) is a flake candidate — review before treating its failures as flake.
- After a false negative was found in production: review the suite that should have caught it.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `paths` | CLI args / explicit list | no | Absolute or root-relative test files. Omitted → `ReviewAgent` discovers test-shaped files: `*.test.*`, `*.spec.*` at any depth, plus files under `__tests__/`. |
| Test file source | filesystem | yes | Read by the agent; unreadable files are skipped honestly — a file that cannot be read cannot be reviewed. |
| Suite context | optional | no | `suiteHealth(...)` aggregates per-file reports plus weightedCoverage, flakeHealthScore, avgRuntimeMs into a 10-component suite score. |
| `theqa.config.json` | repo root | no | Not consumed by the review engine itself; quality gates live in context (`qualityGates`). |
| Report shape | engine output | — | `TestQualityReport { filePath, score, testCount, deductions[] (dimension, points, reason, line?), strengths[], label: 'INFERRED' }`; deductions arrive sorted by points desc. |

## Preconditions

- The target is a test-shaped file (`isTestShaped`); reviewing product source with this engine is meaningless.
- The file content is read as-is — no build step, no transpile. Heuristics are source-level, so a file the compiler rejects still reviews; a file the build would transform may review differently than it runs.
- Lifecycle: review belongs in `VALIDATE` (after `GENERATE`) or `MEASURE` (auditing an existing suite). It never replaces `EXECUTE` — a perfect static score is not execution evidence (golden rule 4).

## Decision rules

1. IF a report shows a 25-point `security` deduction (hardcoded secret-shaped literal, e.g. `sk_live_…`, `ghp_…`, `AKIA…`, or `password: "…"`), THEN treat as BLOCKING: the secret must be rotated and moved to env/config regardless of any score, and the artifact pipeline will redact it going forward (golden rule 8).
2. IF a report shows a 25-point `assertionStrength` deduction ("no assertions found — test cannot fail for the right reason"), THEN treat as BLOCKING for merge purposes: a test that cannot fail is not a test; it is line count.
3. IF `correctness` deductions mention `.only(` (10 points), THEN block: `test.only` silently disables the rest of the suite; remove it or justify the temporary debug run in the PR description.
4. IF `determinism` deductions cite `waitForTimeout`/`sleep`/`setTimeout ≥ 100ms`, THEN flag as a golden-rule-3 violation: arbitrary sleeps are forbidden as a first fix; require web-first waiting (auto-wait assertions, `expect.poll`, locator retries) instead.
5. IF the score is ≥ 85 with only 4–8 point deductions (e.g. `dataQuality` identity from `Date.now()` suffix, `observability` console.log noise), THEN advise — record the deductions, do not block the change on them.
6. IF `assertionCount < testCount` (8-point deduction: "fewer assertions than test cases"), THEN read the named lines: some paths end unverified; either add assertions or split the case.
7. IF the report lists `isolation` deductions (`beforeAll`-only setup, module-level mutable state), THEN check for ordering dependence: these tests may pass alone and fail in parallel — a triage-time FLAKE source.
8. IF `duplication > 0.3` (10-point deduction, 5-line shingle estimate), THEN recommend extracting shared flows/helpers; duplicated setup diverges silently.
9. IF the file is a UI test (`.tsx?` with `page.`/`screen.`/`render(`) and has CSS/XPath-only selectors with zero role/label queries (8-point `accessibility` deduction), THEN recommend accessible queries — they are more stable AND check the accessibility tree.
10. IF a deduction's `line` field is present, THEN verify the cited line in the source before reporting it as fact; heuristics can misfire, and the agent must not relay a wrong line number as CONFIRMED.
11. IF every reported finding checks out but the score is still low because of many small deductions, THEN summarize by dimension weight order (assertionStrength 10, correctness 10, determinism 9, isolation 8 first) — the heaviest dimensions are the cheapest trust wins.
12. NEVER rewrite a test to pass without understanding its intent: read what the test asserts about the specification before touching it. If the assertion looks wrong, verify against the behavior spec — the test may be the only thing that is right in the room.

### The 17 dimensions and their weights

The 17 dimensions and their weights (sum = 100) define what the model values. Deductions subtract from a start of 100; the score is clamped to 0..100.

| Weight | Dimensions |
|---|---|
| 10 | `correctness` (asserts intended behavior, not implementation details), `assertionStrength` (precise outcomes, no tautologies) |
| 9 | `determinism` (no sleeps, no wall-clock/random without seeds) |
| 8 | `isolation` (own state, ordering-free, parallel-safe) |
| 7 | `behaviorCoverage` (observable behavior over private internals), `negativeCoverage` (failure paths) |
| 6 | `boundaryCoverage` (zero/one/max/empty/expired/duplicate…) |
| 5 | `maintainability`, `runtime`, `mockQuality`, `dataQuality`, `security` |
| 4 | `readability`, `duplication`, `observability` |
| 3 | `accessibility`, `evidenceQuality` |

Every deduction carries `points`, a `reason`, and — where the heuristic can pin it — a `line`. A 25-point deduction is the engine's loudest signal (only two exist: hardcoded secrets, and a test with no assertions); 4–12 point deductions are calibration noise you argue about, not gates you fail.

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Skip — review operates on given or test-shaped-discovered files. |
| MODEL | Not applicable. |
| PLAN | If activated from a plan, list which files will be reviewed. |
| GENERATE | Generated tests MUST pass review before being written to the suite. |
| VALIDATE | **Primary phase**: run the review, walk deductions, apply rules 1–12. |
| EXECUTE | Review does not execute anything. |
| OBSERVE | Not applicable. |
| TRIAGE | A triaged TEST_DEFECT may trigger a follow-up review of the offending file. |
| HEAL | Never heal a test that has unresolved 25-point findings — heal proposes, review vets. |
| VERIFY | Re-run the review after edits; the score must not drop and blocking findings must be gone. |
| MEASURE | Feed per-file scores into `suiteHealth` (10 weighted components). |
| LEARN | Record repeated findings (e.g. the same file penalized twice for sleeps) as review feedback records. |

## Anti-patterns

- Treating the score as a grade to optimize: deleting tests raises the average and destroys signal (golden rule 15 — optimize for signal, not test count).
- Silencing a `security` finding by "fixing" the regex match (e.g. splitting the secret literal across lines) instead of removing the secret.
- Rewriting a failing test's assertions to match current buggy behavior — that converts a REAL_REGRESSION into a false pass.
- Demanding 100: some deductions trade off (a thorough negative-coverage file is longer; `maintainability` may dip). Weights exist so agents argue about what matters.
- Reviewing only the files that changed when the defect escaped the whole suite — the false negative lives in what was never asserted.
- Quoting line numbers from the report without opening the file (heuristic output is `INFERRED`, not `CONFIRMED`).
- Adding assertions that tautologically restate the computation under test (`expect(x).toBe(x)`-shaped) to silence "fewer assertions than tests".
- Treating `strengths[]` as permission: "no arbitrary sleeps" appearing in strengths does not cancel a 25-point secret finding in the same file.
- Summarizing a review as a bare score in a PR comment — a score without its deductions is not reviewable and not auditable.

## Failure handling

- File unreadable/missing → the agent skips it and says so; do not fabricate a score for a file you could not read (`NOT_RUN` for that file).
- Zero test-shaped files found → report the discovery result honestly and route to `qa doctor`/discovery, not to a fake empty report.
- Engine output disagrees with human reading (false positive heuristic) → keep the deduction but mark it `INFERRED` and state the disconfirming evidence; do not silently drop engine output either.
- Report is stale relative to edits → re-run `analyzeTestFile` on the current content; never annotate old scores onto new code.
- Two engines disagree with each other (review vs triage calling the same test defect-free and defective) → surface both with their evidence; the disagreement itself is a finding for the human, not something to average away.
- A file scores 100 → verify it actually has test cases (`testCount > 0`): an empty file trivially deduces nothing; report `testCount` beside the score always.
- The report was generated against a file whose language the engine's heuristics do not target (non-JS/TS idioms) → say which heuristics may under- or over-fire; the engine's regexes are JS/TS-shaped and honesty about that beats silent confidence.
- A blocking finding is disputed by the author → the dispute is resolved by evidence (rotate the secret, show the assertion), never by re-running the analyzer until the score looks acceptable.

## Evidence requirements

- Every reported deduction: `OBSERVED` only after the agent located the cited line in the actual file; otherwise `INFERRED` (engine output, unverified).
- "This test cannot catch the bug" claims: `INFERRED` unless demonstrated by a mutation/reduction experiment (`CONFIRMED`).
- "No assertions" and secret findings with line numbers you verified: `OBSERVED`.
- Files skipped due to read errors: `NOT_RUN`.
- Strengths cited in the summary carry the same verification bar as deductions: quote them only after reading the code they describe.
- Never emit `CONFIRMED` for static findings — static analysis without execution cannot confirm behavior (golden rule 4).

## Safety constraints

- Safety class: `READ_ONLY` — review reads files and writes nothing (ACTION_POLICIES).
- No `--confirm-risk` applies; there is no high-risk path in this skill.
- Golden rules engaged: 1 (never weaken an assertion to pass), 3 (no sleeps as first fix), 4 (no verification claims without execution evidence), 8 (never expose secrets in artifacts — repeat findings verbatim only to the developer, never into new artifacts/logs), 15 (signal over count).
- Secret literals found in test code are relayed as findings (shape + line), never echoed in full into reports, PR comments, or learning records — the review itself must not become the leak.
- The agent MUST NOT modify test files during review; edits belong to the healing/generation skills with their own policies.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "INFERRED",
  "data": {
    "reports": [
      {
        "filePath": "tests/checkout/pricing.test.ts",
        "score": 71,
        "testCount": 4,
        "deductions": [
          { "dimension": "determinism", "points": 8, "reason": "arbitrary sleep(s) found — forbidden as first fix (golden rule 3): line 42", "line": 42 },
          { "dimension": "negativeCoverage", "points": 10, "reason": "no negative-path cases detected in a multi-case file" }
        ],
        "strengths": ["no arbitrary sleeps (web-first waiting)"]
      }
    ],
    "blocking": ["tests/checkout/pricing.test.ts: hardcoded secret-shaped literal (security, 25)"],
    "advisory": ["determinism 8pts line 42", "negativeCoverage 10pts"]
  }
}
```

`data.reports[]` mirrors `TestQualityReport`; `label` is the aggregate verification label (`INFERRED` unless every deduction was hand-verified — do not upgrade the aggregate casually).

## Examples

### Walkthrough 1 — blocking finding before merge
A PR adds `tests/api/rate-card.test.ts`. Review reports score 40: `security` 25 ("hardcoded secret-shaped literal", line 12 — a literal matching `(sk|pk)_(live|test)_…`), `assertionStrength` 8 ("fewer assertions (2) than test cases (5)"), `correctness` 10 (`test.only` at line 3). The agent opens the file, confirms line 12 (`OBSERVED`), and applies rules 1 and 3: BLOCKED. Output states: secret must be rotated (it entered git history), `.only` removed, and either assertions added or cases split. Advisory items recorded for the follow-up. The PR does not merge on a "fix the score" pass — it merges when the secret is gone and the `.only` is gone.

### Walkthrough 2 — advisory review of a healthy-but-noisy file
`tests/e2e/search.spec.ts` scores 84: `dataQuality` 4 (identity from `Date.now()` suffix), `observability` 4 (3 `console.log` calls), `maintainability` 6 (470 lines). Rules 5 and 11 apply: all advisory. The agent verifies the three cited lines (`OBSERVED`), reports them ranked by dimension weight, recommends seeded factories and structured reporting, and does not block. The test proceeds to execution; the findings are recorded as review feedback so the next generated file in this area starts cleaner. The `strengths[]` list is quoted too — the file uses accessible role-based queries — because a review that only lists what is wrong teaches the team nothing about what to keep doing.

## Verification checklist

- [ ] Every reported deduction was traced to its cited line in the current file content.
- [ ] All 25-point findings (secrets, no-assertions) were classified blocking, not advisory.
- [ ] No test was rewritten or deleted during review (skill stayed READ_ONLY).
- [ ] The aggregate `label` reflects reality: `INFERRED` for unverified heuristic output.
- [ ] Deductions were ranked by dimension weight, not by point size alone.
- [ ] `.only`/`.skip` findings were reported as correctness debt with a reason, not ignored.
- [ ] Skipped-unreadable files are listed as `NOT_RUN`, not silently omitted.
- [ ] Secret literals were described by shape and line, never copied into new artifacts.
- [ ] The 17-dimension weight table was used to order the summary, heaviest dimensions first.
- [ ] `testCount` was reported next to every score, so "100 on an empty file" cannot masquerade as excellence.
