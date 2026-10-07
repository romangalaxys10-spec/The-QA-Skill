---
name: qa-flake-detection
description: Scores tests for flakiness with the documented deterministic formula and converts every verdict into a quarantine or fix decision that is never silent. Mandates fixing nondeterminism — isolation, web-first waits, data uniqueness, clock control — over hiding it with retries.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa flake --json"
  mcp: "analyze_flake(input: FlakeInput)"
  agent: null
  core: "scoreFlake(input) -> FlakeAssessment; suiteFlakeHealth(assessments)"
---

# QA Flake Detection

## Purpose

Quantify how nondeterministic a test is, explain WHY the score moved, and force a decision: quarantine visibly or fix the root cause. The engine (`scoreFlake` in `packages/core/src/flake/score.ts`) is a documented formula — `score = round(40×failRate + 25×retrySignal + 20×intermittency + 15×envSpread)` — with verdict bands `<20 stable · <45 suspect · <70 flaky · ≥70 critical_flaky`. Every assessment carries its reasons; nothing about flake is allowed to be handled quietly, because silent flake handling is how false trust in a suite is manufactured.

The four terms have distinct readings: failRate measures HOW OFTEN it fails; retrySignal measures how often the suite had to paper over it; intermittency (pass/fail direction changes across the ordered window) is the shape that distinguishes nondeterminism from a consistently-broken test; envSpread (60% environments, 40% browsers, each saturating at 3 distinct values) localizes the mechanism — shared state, parallel workers, or a poisoned environment.

## When to activate

- Nightly/broad runs completed and intermittent failures were recorded (per-attempt events from `qa test`).
- A test triaged as `FLAKE` (triage rule 8) needs a score and a quarantine decision.
- A test repeatedly passes only after retries (`retrySignal` > 0) even though it eventually greens.
- Before a release gate: `criticalFlakeCount > 0` produces a gate warning — count them here.
- Periodic suite audit: run the scorer over the inventory's `flakeScore` candidates.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `testId` | inventory | yes | The test being scored. |
| `outcomes` | run history | yes | Chronological, oldest first: `{ status: 'passed'\|'failed', timestamp, environment?, browser? }`. |
| `retryCount` | runner/config history | no | Retries needed across history; feeds `retrySignal = min(1, retryCount/5)`. |
| `environments` | attempt records | no | Distinct environments the test FAILED on; feeds 60% of `envSpread`. |
| `browsers` | attempt records | no | Distinct browsers the test failed on; feeds 40% of `envSpread`. |
| Window size | caller choice | no | More outcomes ⇒ sharper failRate/intermittency; ≥ 5 outcomes upgrades the label to `OBSERVED`. |
| Assessment shape | engine output | — | `FlakeAssessment { testId, score, verdict, reasons[], failRate, label }`; verdicts: `stable \| suspect \| flaky \| critical_flaky`. |

## Preconditions

- Outcomes are chronological and deduplicated per attempt — mixing retries of one run with history skews failRate.
- Lifecycle: flake scoring sits between `OBSERVE` and `TRIAGE` decisions; it refines, never replaces, triage (a timeout-shaped flake must have passed triage rule 7's exception first).
- The test actually ran — you cannot score flakiness from `NOT_RUN` data.

## Decision rules

1. IF `score < 20`, THEN verdict `stable` — no quarantine; record the score and move on.
2. IF `20 ≤ score < 45`, THEN verdict `suspect` — log it in the flake registry, keep running it normally, and set a re-check window; suspects are watched, not quarantined.
3. IF `45 ≤ score < 70`, THEN verdict `flaky` — quarantine visibly: run isolated, exclude from merge-blocking, and open a fix task citing the assessment's reasons. Never remove it silently.
4. IF `score ≥ 70`, THEN verdict `critical_flaky` — quarantine immediately AND treat as a suite-health incident; every critical flake produces a release-gate warning (`criticalFlakeCount`).
5. IF `intermittency > 0.3` (alternating pass/fail direction changes in the outcome sequence), THEN name the pattern in the report — alternation is the classic nondeterminism signature and outranks a high fail-rate-with-consistent-cause reading.
6. IF failures span > 1 environment or browser (envSpread reasons fire), THEN suspect shared-state or environment-dependent behavior first: the test fails everywhere it runs in parallel, not on one box.
7. IF `envSpread < 0.2` with failures present, THEN read the engine reason "failures confined to one env/browser — possibly environment-specific": this may be an environment defect masquerading as flake — route back to triage (`ENVIRONMENT_FAILURE`) before quarantining the test.
8. IF `retryCount ≥ 1`, THEN the retry signal is evidence the suite already papered over nondeterminism — golden rule 2: retries never hide regressions, and they never fix flakes either; fix the mechanism.
9. IF the fix is applied, THEN re-verify: rerun the test over a fresh window and require the score to drop below the quarantine band before lifting isolation; a "fix" that stays ≥ 45 did not fix.
10. IF the same testId accumulates repeated `flake_observed` learning records, THEN escalate the priority — trend reading via the learning store (`store.query({ type: 'flake_observed' })`) turns one-off noise into a demonstrated pattern.

Formula reference (all factors 0..1): `failRate` = failed outcomes / window; `intermittency` = direction changes / (n−1); `envSpread = min(1, envs/3)×0.6 + min(1, browsers/3)×0.4`; `retrySignal = min(1, retryCount/5)`.

### Score bands and the suite aggregate

| Band | Verdict | Action class | Visibility requirement |
|---|---|---|---|
| 0–19 | `stable` | none — keep in normal rotation | score recorded; short windows stay `INFERRED` |
| 20–44 | `suspect` | watch: flake registry entry + re-check window | logged, not quarantined |
| 45–69 | `flaky` | quarantine visibly: isolated runs, non-blocking, fix task citing reasons | registry entry + task + owner mandatory |
| 70–100 | `critical_flaky` | quarantine immediately + suite-health incident | release-gate warning input (`criticalFlakeCount`) |

Suite aggregate (`suiteFlakeHealth`): `score = max(0, 100 − 10 × (critical×12 + flaky×5) / √n)` over the assessed set — useful for trend lines, but the GATE consumes the critical count, not the aggregate.

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Collect candidate tests: triaged FLAKE verdicts, retry-heavy tests, inventory flakeScore ≥ 45. |
| MODEL | Assemble the outcome window from run history per test. |
| PLAN | Decide which candidates get scored now; batch the rest. |
| GENERATE | A fix may require generating a replacement test — route through generation, not ad-hoc edits. |
| VALIDATE | Verify window integrity (chronology, attempt dedup). |
| EXECUTE | Fresh re-runs feed the window; retries recorded per attempt. |
| OBSERVE | Outcome collection: statuses, environments, browsers. |
| TRIAGE | Flake verdicts cross-check triage: rule 8 (FLAKE) vs rule 7 (TIMING) boundaries. |
| HEAL | Flake fixes are structural (isolation/waits/data/clock) — see healing tiers; MEDIUM at best. |
| VERIFY | **Mandatory loop**: re-score after every fix; quarantine lifts only below band. |
| MEASURE | `suiteFlakeHealth` aggregates: `score = 100 − 10×(critical×12 + flaky×5)/√n`; feeds suite health component (weight 15). |
| LEARN | Append `flake_observed` records with score + reasons; trends inform selection warnings (`flakeScore ≥ 70` ⇒ "run isolated, do not block merge on first failure"). |

## Anti-patterns

- Auto-quarantining on first suspicion: a suspect (20–44) is watched, not exiled; quarantine is for flaky+.
- Silent quarantine (skip without a registry entry, task, and owner): invisible tests protect nothing and nobody knows why.
- Raising retries or timeouts as the "fix" — golden rule 3 forbids sleeps; retries hide, timeouts mask. Neither changes the score's root cause.
- Reading a high envSpread score as "unstable test" when it means "parallel workers share state" — the env/browser spread points at the mechanism, not just the magnitude.
- Scoring a window that mixes retried attempts and raw history: one run's 3 attempts are not 3 independent outcomes.
- Declaring victory after a fix without the re-verification loop (rule 9).
- Letting the quarantine become a graveyard: entries without owners and re-check dates are silent skips with extra steps.
- Scoring outcomes gathered under different retry policies as one window — a test with 3 forced retries and one with 0 are not comparable windows; normalize the policy first or score them separately.
- Confusing `suspect` with `flaky` in reports: the band decides the action class; blurring them either over-quarantines healthy tests or under-quarantines real ones.
- Treating `stable` as "proven deterministic": with a short window the label is `INFERRED` (< 5 outcomes); stability claims need observed windows.

## Failure handling

- Empty outcomes → refuse to score (0/0 failRate is meaningless); return an error, not a fake `stable`.
- One outcome only → intermittency is 0 by construction (n−1 = 0); the score rests on failRate/retry/envSpread — say so, and widen the window before acting on the verdict.
- Timestamps missing/out of order → normalize or reject; the alternation metric depends on order.
- Score conflicts with human intuition (e.g. 35 for a test devs swear is flaky) → widen the window; if the score stands, the burden of proof is on the intuition — record both.
- Suite health looks fine but critical > 0 → surface the inconsistency; `suiteFlakeHealth` penalizes by √n, large suites can hide single criticals in the aggregate — the count is the gate input, not the aggregate alone.
- Outcomes collected across different environments without env fields → envSpread collapses toward its floor and the score loses its most actionable component; mark the assessment as degraded and re-collect with env/browser attribution.

## Evidence requirements

- Every verdict: the engine's `reasons[]` must be quoted verbatim in the report (fail fraction, retries, alternation, env/browser spread) — a bare number is not an assessment.
- `OBSERVED` label requires ≥ 5 outcomes in the window; fewer outcomes ⇒ `INFERRED` and the report must say the window is thin.
- Quarantine decisions: `OBSERVED` (score + reasons + registry entry). Quarantine lifts: `OBSERVED` only after a fresh post-fix window.
- Env-specificity claims (rule 7): `INFERRED` until a triage pass or a controlled same-env rerun `CONFIRMED` the environment as the variable.
- Trend claims ("getting worse"): `OBSERVED` only with learning-store records over time; otherwise `INFERRED`.
- "The fix worked" claims: the fresh window IS the evidence — report its size, its score, and the delta against the pre-fix score.
- Re-check due dates on suspect entries: tracked decisions, not vibes — a suspect with three passed re-check windows is a candidate for closure with the windows as evidence.
- Env-mechanism claims ("parallel workers share state"): `INFERRED` until a controlled reproduction (same test, forced single-worker vs parallel) `CONFIRMED` the mechanism.
- Registry entries themselves: append-only, each citing the assessment id and score that caused it (golden rule 13 — quarantine history is evidence).

## Safety constraints

- Safety class: `READ_ONLY` — scoring reads run records; quarantine decisions write only registry/task entries (LOW_RISK_WRITE at most, outside the test files).
- No `--confirm-risk` path exists in scoring itself; any fix that touches test code goes through healing/generation skills with their own classes.
- Quarantine is never expressed as editing the test to `skip` — that is a healing-policy violation (skip/only/todo introduction) and a silent deletion of coverage in disguise.
- Golden rules engaged: 2 (retries never hide regressions — and never hide flakes), 3 (no arbitrary sleeps as first fix), 6 (never destroy isolation for speed — isolation fixes must ADD isolation, not remove parallelism-by-luck), 13 (preserve evidence — registry entries and scores are append-only), 15 (signal over count — one critical flake outweighs many quiet greens).

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "assessments": [
      {
        "testId": "search.spec:infinite-scroll",
        "score": 62,
        "verdict": "flaky",
        "failRate": 0.4,
        "reasons": [
          "6/15 outcomes failed in the window (40%)",
          "required 2 retries historically",
          "alternating pass/fail pattern (intermittent)",
          "failed across 2 environments: ci-eu, ci-us"
        ]
      }
    ],
    "suiteFlakeHealth": { "score": 84, "critical": 0, "flaky": 1 },
    "quarantine": [ { "testId": "search.spec:infinite-scroll", "decision": "quarantine-isolated", "reCheck": "2025-02-07" } ]
  }
}
```

`data.assessments[]` mirrors core `FlakeAssessment`; per-assessment label is `OBSERVED` when the window had ≥ 5 outcomes, else `INFERRED`.

## Examples

### Walkthrough 1 — suspect that becomes flaky
`search.spec:infinite-scroll` has 15 outcomes (6 failed, alternating in the middle), needed 2 retries historically, and failed on both ci-eu and ci-us. Score: `40×0.4 + 25×0.4 + 20×0.53 + 15×(min(1,2/3)×0.6 + 0) ≈ 16 + 10 + 11 + 6 = 43` → with a third environment recorded it crosses to 62 → `flaky`. The agent quarantines visibly (isolated runs, no merge-blocking, registry entry with owner), cites the reasons verbatim, and opens the fix task: replace `waitForTimeout(1500)` with a web-first assertion and give the scroll test unique seeded data. Re-verification after the fix: 20 outcomes, score 12 → `stable` → quarantine lifted with the fresh window as `OBSERVED` evidence.

### Walkthrough 2 — environment-specific, not flaky
`api.spec:creates-session` fails 3/10 times, only in `ci-eu`, one browser. Score: `40×0.3 + 0 + 0.11×20 + 15×(min(1,1/3)×0.6) ≈ 12 + 2 + 3 = 17` → `stable`-band number, but the engine appends "failures confined to one env/browser — possibly environment-specific". Rule 7 applies: the agent does NOT bless the test as stable; it routes the record back to triage, which classifies `ENVIRONMENT_FAILURE` (0.85 — no changed code covered). The ci-eu runner's clock skew is fixed; the failures stop. Had the agent trusted the number alone, a real environment defect would have been registered as "test is fine" — the reasons array is the assessment, the score is just the sort key.

## Verification checklist

- [ ] Every verdict quoted the engine's `reasons[]`, not just the score and band.
- [ ] Quarantine decisions were recorded in the registry with an owner and re-check date — nothing silent.
- [ ] No fix used retries, sleeps, or timeout raises (golden rules 2 and 3).
- [ ] Every quarantine lift was backed by a fresh post-fix window scoring below the band.
- [ ] Windows were chronological and attempt-deduplicated; single-outcome scores were labeled thin.
- [ ] Env-confined failures were routed to triage (rule 7) before any quarantine.
- [ ] Labels follow ≥ 5 outcomes ⇒ OBSERVED else INFERRED.
- [ ] `critical_flaky` counts were surfaced to the release-gate input, not buried in the suite aggregate.
- [ ] Suspect-band entries carried re-check dates and were re-scored when due, not forgotten.
- [ ] Fix tasks cited the assessment (score + reasons) so the fixer knows which mechanism to target.
