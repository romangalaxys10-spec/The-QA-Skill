---
name: qa-agent-evaluation
description: Benchmarks the coding agent itself as a QA artifact — a repeatable harness materializes fixture git repos, runs the agent, and grades every claim against EXPECTED.md using metrics computed from artifacts, never from self-reports. Covers bug detection, test correctness, overfitting, repo-modification quality, and honesty of the agent's own claims.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  harness: "scenario → materialize fixtures/<scenario>/commits.json into a fresh git repo → run the agent → grade against fixtures/<scenario>/EXPECTED.md"
  fixtures: "fixtures/ corpus — 13 validated scenarios (12 planted-defect/quality + false-negative); scripts/validate-fixtures.js is the 13/13 gate"
  cli: "qa review / qa triage / qa coverage — engine outputs are the grading instruments"
  core: "LearningStore.append — mutation_survivor | generation_rejected | healing_rejected | review_feedback records with explicit effect"
---

# QA Agent Evaluation

## Purpose

The coding agent is itself a QA instrument, so it gets the same treatment it gives others: a benchmark, a reproducible environment, and grades computed from artifacts. The harness methodology is fixed — scenario, materialize, run, grade, measure — and every metric (detection rate, false positives/negatives, flake rate, modification quality) is computed from captured outputs, never from what the agent says it did. A benchmark that accepts self-reports measures confidence, not capability.

## When to activate

- Before shipping or upgrading the agent (its prompts, tools, or models) — the agent is itself a release.
- After any engine change the agent consumes (triage, healing, selection, quality) — downstream behavior shifts.
- When an agent claims success a human doubts — re-run the relevant fixture scenario and check the artifacts.
- Periodically under `nightly` policy to detect drift caused by model/provider updates (pairs with `qa-llm-testing`).
- When a new fixture scenario is added — extend the corpus first, then re-baseline every agent version on it.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| Scenario fixture | `fixtures/<name>/` | yes | README (scenario), EXPECTED.md (expectations), app/ + tests/ (material), evidence/failures.json, commits.json (2-commit history). |
| commits.json | fixture | yes | Commit 1 = working base state; commit 2 = the change under test (planted defect or quality trap). Materialized byte-exact. |
| EXPECTED.md | fixture | yes | Machine-checkable fields (`engine`, `expect_category`, `expect_min_confidence`, `expect_quality_score_max`, `expect_deduction_dimensions`) + prose notes for humans. |
| Agent under test | harness config | yes | Its commands/prompts/version; runs against the materialized repo in isolation. |
| Mutation set | per scenario | for overfitting checks | Behavior-changing mutations derived from the scenario notes — the agent never sees them. |
| Rerun count N | harness config | for flake checks | Same materialized repo, repeated runs. |
| Corpus version | hash of fixtures/ | yes | Recorded in every result; comparisons across corpus versions are invalid. |

## Preconditions

- The corpus validates clean (`scripts/validate-fixtures.js` → 13/13); a broken fixture invalidates every run built on it.
- The agent under test operates on an isolated materialized copy — never on the platform repo, never on real user repos.
- EXPECTED.md encodes expectations as engine-checkable facts plus prose notes; the harness parses the machine fields, humans read the notes.
- Grading is offline and deterministic: same artifacts → same grades, or the harness itself is broken.
- No HIGH_RISK actions are needed by any scenario — if one seems needed, the fixture design is wrong.

## Decision rules

1. IF grading any agent claim THEN the grade source is the artifact (git diff, test output, evidence bundle, engine report) — self-reported success is NOT_VERIFIED and never counted as success.
2. IF the agent claims it inspected the repo THEN its output must cite files/symbols that exist at the fixture commit; any invented path or symbol fails the run (hallucination, same bar as `qa-llm-testing` grounding).
3. IF grading test generation THEN the produced test must fail on the defect commit AND pass on the base commit — a test that never failed proves nothing; both directions are executed.
4. IF the generated test fails on base or passes on defect THEN generation success is false for that scenario, and the failure mode (over-strict assertion, wrong selector, missing seed data) is recorded, not averaged away.
5. IF checking overfitting THEN apply the mutation set: a test that survives a behavior-changing mutation is a `mutation_survivor` (learning record) and the scenario fails the overfitting check — passing the one known case is not coverage.
6. IF grading repo modification THEN the diff may touch only scenario-scoped files; deleted test files, edited EXPECTED.md, or fixture self-modification fail automatically (golden rule 7 — never auto-delete tests; grading the grader is off-limits).
7. IF the agent's code violates conventions detectable in the fixture repo (style, naming, test layout) THEN repo-modification quality loses points — conventions are read from the materialized repo, not assumed from the platform's own taste.
8. IF measuring bug detection THEN a scenario counts as detected only when the agent's output identifies the planted defect with the right file AND a reproducing test or a triage category that points at it; FN when the defect ships undetected (the `false-negative` fixture is exactly this: the coupon suite stays green while expiry enforcement is gone).
9. IF the agent reports a defect that is not the planted one THEN count it a false positive — FPs are not "extra diligence", they send humans chasing ghosts.
10. IF checking flake THEN re-run the agent's tests N times on the same materialized repo; any nondeterministic pass/fail across runs records flake rate > 0 and fails the scenario's determinism bar (no sleeps, no wall-clock identity — golden rule 3).
11. IF grading healing THEN the proposal must satisfy policy discipline (only HIGH tier with zero violations auto-applies, `.pre-heal.bak` written) and the learning store must contain matching `healing_applied`/`healing_rejected` records.
12. IF a scenario errors or times out THEN record generation success = false with the captured error — the denominator is always all scenarios attempted; dropping crashed scenarios inflates success rates.

### Harness metrics (computed from artifacts)

| Metric | Definition | Artifact source |
|---|---|---|
| test correctness | Generated/edited tests fail for the right reason (fail on defect, pass on base) | Test run outputs on both commits |
| bug detection rate | Scenarios where the planted defect is identified with file + reproducing evidence / planted total | Agent diff + triage/test results vs EXPECTED.md |
| FP rate | Reported non-planted defects / reported defects | Agent findings vs fixture ground truth |
| FN rate | Undetected planted defects / planted total | Same, including the false-negative fixture |
| flake rate | Nondeterministic outcomes across N reruns / rerun test count | Repeated run artifacts on the same repo |
| generation success | Scenarios producing a valid, executing, correctly-failing test / scenarios attempted | Harness runs (denominator includes crashes) |
| healing success | Proposals passing policy and verifiably restoring intended behavior / proposals made | heal policy output + post-heal runs |
| coverage gain | Weighted coverage delta attributable to the agent's tests | Coverage reports before/after the run |
| runtime | Wall clock per phase (materialize / run / grade) | Harness timers |
| repo-modification quality | Scope adherence, convention adherence, zero deletions, minimal diff | Git diff analysis + `analyzeTestFile` on modified tests |

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Select the scenario set; validate the corpus (13/13) before anything runs. |
| MODEL | Each scenario is a behavior contract: planted defect, expected engine verdicts (EXPECTED.md), mutation set. |
| PLAN | Order scenarios; allocate reruns and timeouts; pin agent versions; pin the corpus hash. |
| GENERATE | Materialize commits.json into a fresh git repo per run (commit 1 base, commit 2 change); record materialized HEAD hash. |
| VALIDATE | Pre-flight: base commit green, defect commit fails as README describes — otherwise quarantine the fixture; never grade against a broken fixture. |
| EXECUTE | Run the agent under test with the scenario prompt; capture stdout, diffs, exit codes, artifacts. |
| OBSERVE | Collect artifacts: git diff, test results on both commits, triage outputs, evidence bundles, learning records. |
| TRIAGE | Classify harness failures: agent defect, fixture defect, harness defect, environment failure — fixture/harness defects invalidate the run, not the agent. |
| HEAL | Fix fixtures/harness through the same review discipline; never mutate a fixture to make a failing agent look good (golden rule 1 in evaluation form). |
| VERIFY | Re-run failed scenarios once to separate deterministic failures from flaky harness behavior; grade the deterministic result. |
| MEASURE | Compute the metrics table; compare agent versions only on the SAME corpus version and sample counts. |
| LEARN | Append `mutation_survivor` / `generation_rejected` / `healing_rejected` / `review_feedback` records with effect statements and version pins. |

## Anti-patterns

- Grading from the agent's own summary ("I fixed it") — artifacts or it didn't happen.
- Letting the agent see EXPECTED.md or the mutation set during the run — that grades memory, not capability.
- Changing fixtures after seeing agent results — corpus drift makes every prior number meaningless.
- Counting a test that "fails loudly" without checking it fails on the defect commit and passes on base.
- Averaging success rate over a subset after silently excluding crashes and timeouts.
- Treating false positives as harmless thoroughness — they consume exactly the human attention benchmarks exist to protect.
- Reusing one materialized repo across scenarios or runs — state leaks between runs (golden rule 6).
- Comparing agent versions across different corpus versions and calling it progress.
- Reporting one headline number without the per-scenario breakdown that could contradict it.

## Failure handling

- Fixture fails validation → quarantine the scenario, exclude it from the denominator, and say so in the report.
- Agent hangs → timeout, record generation success = false, keep partial artifacts for diagnosis.
- Git materialization fails → harness defect; fix the harness; do not grade a run on a broken environment.
- Flaky harness (same input, different grade) → hunt the harness bug before drawing agent conclusions; grading must be deterministic.
- Engine output missing (agent never ran triage) → the metric is absent (NOT_RUN), not zero — absence and zero are different facts.
- Disputed FP/FN call → the planted-defect definition in README/commits.json is the tiebreaker; EXPECTED.md notes resolve intent questions.
- Corpus updated mid-benchmark → abort, re-baseline, restart; never mix corpus versions in one report.

## Evidence requirements

- All metrics: OBSERVED when computed from artifacts captured this run; never upgraded by assertion.
- "Agent inspects before claiming": OBSERVED only when output references verified files/symbols; INFERRED from partial evidence; otherwise NOT_VERIFIED.
- Mutation-survivor findings: CONFIRMED once the mutation is demonstrated behavior-changing (base and defect outputs differ) — the one place CONFIRMED is reachable, because both sides were executed.
- Self-reported agent claims: NOT_VERIFIED by definition.
- Crashed or timed-out scenarios: NOT_RUN with the captured error attached.
- Cross-version comparisons: INFERRED unless corpus hash, sample counts, and rerun counts all match.

## Safety constraints

- Safety class: READ_ONLY toward the platform repo; the agent under test works inside an isolated materialized fixture repo (LOW_RISK_WRITE within it); nothing deploys, nothing external is called.
- HIGH_RISK paths are out of scope in benchmark runs: no `db.migrate`, `test.production`, or `external.systems`; a scenario that seems to need one is a fixture-design error.
- Golden rules engaged: 1 (never weaken assertions — including when grading healing), 2 (retry-pass over changed code still counts as REAL_REGRESSION), 3 (no sleeps — the flake rule), 6 (isolation — fresh repo per run), 7 (no auto-delete — deletions auto-fail), 12/13 (reproducibility + evidence preservation — corpus hash and artifacts), 15 (signal over count — metrics, not test counts).
- Fixture adversarial content (planted defects, fake attacker payloads) is test data; scrub before publishing reports.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "corpus": { "version": "<fixtures-hash>", "scenarios": 13, "validated": 13 },
    "agent": { "id": "qa-agent", "version": "0.1.0", "model": "deterministic" },
    "metrics": {
      "generationSuccess": { "passed": 9, "attempted": 13 },
      "bugDetection": { "detected": 11, "planted": 12, "falsePositives": 1, "falseNegatives": 1 },
      "flakeRate": 0.0,
      "mutationSurvivors": 0,
      "repoModificationQuality": { "scopeViolations": 0, "deletedTests": 0, "conventionDeductions": 2 }
    },
    "scenarioResults": [
      {
        "scenario": "auth-bug",
        "expected": { "engine": "triage", "category": "REAL_REGRESSION", "minConfidence": 0.9 },
        "detected": true,
        "testCorrectness": "fail-on-defect-pass-on-base",
        "label": "OBSERVED"
      }
    ]
  }
}
```

The numbers above illustrate the schema, not benchmark results — real runs carry their own computed values and per-scenario rows for every scenario attempted.

## Examples

### Walkthrough 1 — grading a regression fixture (auth-bug)
The harness materializes the two commits, verifies base-green/defect-red in pre-flight, and runs the agent. The agent produces a fix plus a test. Grading: the diff touches only `app/lib/session.ts` (scope OK); the new test fails on commit 2 and passes on commit 1 (test correctness OK); triage on the original failure with `coversChangedCode` computed from the import closure (`tests/auth.spec.ts` → `tests/helpers/test-app.ts` → `app/http/auth-middleware.ts` → `app/lib/session.ts`) returns REAL_REGRESSION at 0.92 ≥ the EXPECTED.md floor of 0.9. An agent variant that instead "fixed" the test by loosening the 401→200 assertion is graded a failure twice over: test weakened (golden rule 1) and FN on detection — the defect ships. Both grades cite artifacts; neither cites the agent's summary.

### Walkthrough 2 — the false-negative fixture and the mutation check
The `false-negative` fixture pairs a plausible app change (case-insensitive coupon lookup drops the expiry guard) with a suite that cannot fail: one weak `toBeGreaterThan` assertion and two console-only cases. A competent agent run must not celebrate the green suite. Expected behavior: the quality engine flags `assertionStrength` (EXPECTED.md caps `expect_quality_score_max` at 80), the agent adds a real expiry test, and grading verifies fail-on-defect / pass-on-base. The harness then applies the mutation set — restore the expiry guard (behavior-changing). If the agent's new test still passes under the mutation, it is a `mutation_survivor`: the test overfit to the known case and detects nothing. The record lands in the learning store with an explicit effect ("generation rejected for scenario false-negative: mutation survivor"), and the scenario counts as a generation failure regardless of how good the diff looked.

## Verification checklist

- [ ] Corpus validated 13/13 before the run; corpus hash recorded in the result.
- [ ] Every grade traces to a captured artifact, never to the agent's own summary.
- [ ] Generated tests were executed on BOTH commits (fail on defect, pass on base).
- [ ] The mutation set was applied for generation scenarios and `mutation_survivor` outcomes recorded.
- [ ] The denominator of every rate includes crashed and timed-out scenarios.
- [ ] Repo diffs were checked for scope violations, deleted tests, and convention adherence.
- [ ] Flake checks reran tests N times on the same materialized repo.
- [ ] Healing grades verified tier, policy checks, backup file, and learning records.
- [ ] No scenario saw EXPECTED.md or the mutation set during its run.
- [ ] Cross-version comparison used identical corpus hash, sample counts, and rerun counts.
