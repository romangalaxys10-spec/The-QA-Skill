---
name: qa-performance
description: Performance testing discipline for the 'performance' layer — k6 scenarios with thresholds-as-tests, honest SLO/budget definitions, and environment truthfulness (CI numbers are INFERRED for production claims). Thresholds live in version control so performance regressions fail the same event pipeline as functional regressions.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  - runners:k6 (K6Runner: `k6 run --summary-export=...`; thresholds and checks → TestEvents)
  - core:evidence/bundle (k6 summary attached; metrics as 'metric'-kind evidence)
  - core:lifecycle (OrchestrationPolicyName 'nightly' is the natural home for load suites)
---

# QA Performance

## Purpose

Turn performance from a pre-release surprise into a continuously enforced budget. The platform's position, implemented in the k6 adapter, is that a threshold IS a test: `p95 < 300ms` fails exactly like a broken assertion and flows through the same event, triage, and gate pipeline. This skill defines how budgets are chosen honestly, how scenarios model realistic traffic, how results are labeled by environment (CI load numbers never get presented as production measurements), and when profiling hands off to humans.

Two honesty rules anchor everything. First, the adapter distinguishes enforced budgets from observations: a metric WITH thresholds emits a `threshold:` event whose status comes from the threshold result; a metric WITHOUT thresholds emits a `metric:` event that always passes — an observation, deliberately marked so reports cannot mistake it for a verified budget. Second, k6 summary exports carry no per-check wall-clock duration, so adapter events use `durationMs: 0` rather than inventing a number.

## When to activate

- A change set plausibly affects latency, throughput, or resource use: data-access layers, hot endpoints, queue consumers, payload-heavy views.
- You are asked to "add load tests", "set performance budgets", or investigate a reported slowdown.
- A nightly run shows threshold failures and someone wants to waive them — activate and apply budget discipline instead.
- Code review touches N+1-prone or payload-bloat-prone patterns and a measurement is the cheapest way to decide.
- A capacity question arrives ("can we take a launch?") and the honest answer starts with a scenario, not a guess.

## Inputs

| Input | Source | Required | Notes |
| --- | --- | --- | --- |
| k6 scripts | `**/*.k6.{js,ts}`, `k6/**`, `perf/**`, `load-tests/**` | yes | Detected by the runner's pattern set |
| Threshold definitions | inside the scripts, version-controlled | yes | Per-metric budgets (see rule 1) |
| Traffic model | product analytics / known usage shape | yes | Documented next to the scenario |
| Environment spec | target host, capacity, data volume | yes | Must state what the environment is and is not |
| k6 summary export | `.theqa/artifacts/k6-summary.json` | on run | The runner reads the FILE, not stdout |
| Historical summaries | artifacts + learning store | no | For trend and regression context |
| Scenario runbook | repo docs | yes | Who starts/stops runs, what to do on red |

## Preconditions

- The k6 binary and the target environment exist; the runner plans `k6 run --summary-export=<artifacts>/k6-summary.json <script>` — the summary file is the report of record.
- Thresholds are already written into the scripts; a scenario without thresholds produces observations, not verdicts, and must be labeled as such.
- The target is a dedicated load environment with realistic seeded data volume; never a shared dev box, never production without the HIGH_RISK protocol.
- The traffic model (arrival rate, ramping stages, user think time) is documented in the repo — an undocumented load shape is an unrepeatable test.
- Budget definitions follow a stated shape, so reviewers can tell an SLO from a guess:

| Metric (k6) | Stat | Budget origin |
| --- | --- | --- |
| `http_req_duration` | p(95) | SLO-derived, or a measured baseline with stated headroom |
| `http_req_failed` | rate | the documented error budget for the flow |
| `http_reqs` | rate | throughput floor implied by the traffic model |
| `data_received` / per-operation | count | payload-bloat guard for the operation |

## Decision rules

1. If a metric carries thresholds → its TestEvent status comes from the threshold's `ok` boolean and the event name is `[k6] threshold: <metric>`; if a metric carries NO threshold → `[k6] metric: <metric>` with status passed — an observation, never presented as an enforced budget passing.
2. If a threshold fails (`errorType: 'threshold'`) or a check fails (`errorType: 'check'`) → the failure flows through triage WITHOUT being force-fitted into functional categories; with no matching signature shape it lands as UNKNOWN (0.2) with the k6 summary attached — the correct route to performance review.
3. If a result will be quoted as "how prod will behave" → label it INFERRED: CI/load-lab numbers are OBSERVED for the measured environment only; environment honesty is non-negotiable.
4. If the PR window cannot fit load runs → performance runs on the `nightly` orchestration policy; PR-time runs only smoke thresholds (a tiny, fixed load) if any; never delete the nightly suite to speed PRs.
5. If a threshold was green at base and red now → treat as a performance regression candidate: the budget is in version control, so diff the budget itself first to rule out a silent loosening.
6. If someone wants to change a threshold after a failure → the change is allowed only as a reviewed, rationale-carrying commit in the same PR as the cause; loosening a budget in CI config outside review is forbidden (golden rule 1 in budget form).
7. If the summary file is missing at parse time → readResult returns null → the layer reports NOT_RUN; fabricating numbers from stdout guesses is a lie the platform refuses.
8. If scenario design is requested → choose deliberately: load (expected peak), stress (beyond peak to find the knee), soak (duration to find leaks), spike (sudden burst); a single "max load" script is not a traffic model.
9. If an endpoint's response payload or query count looks bloated in review → measure it: assert request counts and payload sizes as checks in the scenario; N+1 shows up as request-count explosions per page/operation.
10. If a threshold failure needs root-cause work beyond budgets → hand the evidence bundle (summary, scenario, environment metadata) to a developer for profiling; the agent's job is precise reproducibility, not flame graphs.
11. If a soak scenario is scheduled → it gets an explicit duration, resource-leak assertions (memory/fd growth as checks), and a reserved environment; a soak on shared infrastructure measures whoever else is on it.
12. If multiple scenarios target the same service → stagger their schedules and isolate data; concurrent load runs invalidate each other's baselines and manufacture both green and red lies.

Scenario design table (what each type is FOR — pick by question, not habit):

| Type | Question it answers | Shape |
| --- | --- | --- |
| Load | Does the system hold its budgets at expected peak? | staged ramp to the documented peak, hold, ramp down |
| Stress | Where does it break, and how does it fail? | increase beyond peak until budgets or correctness break; record the knee |
| Soak | Do resources leak or degrade over time? | sustained moderate load for an explicit duration with leak checks |
| Spike | Does recovery survive sudden bursts? | short extreme burst, then watch recovery to baseline |

Realistic traffic means real shapes: read/write ratios from analytics, cache-hit assumptions stated, think time between user actions, and data volume at production scale — a traffic model that no user would produce measures nothing a user cares about.

## Workflow (12-phase lifecycle)

1. **DISCOVER** — detect k6 scripts/config by pattern; inventory layer `performance` entries.
2. **MODEL** — identify performance-critical paths in the diff; note data volume and arrival-rate assumptions; record which factors (businessCriticality, userImpact) apply.
3. **PLAN** — pick scenario types and placement (PR smoke vs nightly full); state SLO-derived budgets: p95 latency on `http_req_duration`, error rate on `http_req_failed`, throughput on `http_reqs` where an SLO exists.
4. **GENERATE** — scaffold scenarios with staged arrival rates, checks for per-request correctness (status is 200), and thresholds per metric.
    Scenario type comes from the question table above; the same endpoint can carry a load script and a spike script answering different questions.
5. **VALIDATE** — quality pass: thresholds present and justified; no `console`-only scenarios; checks assert request-level correctness, not just completion.
6. **EXECUTE** — run via the k6 runner against the dedicated load environment; the summary export path is the artifact contract.
7. **OBSERVE** — attach the k6 summary to the evidence bundle; metrics become evidence items of kind `metric`; durationMs on these events is 0 by design — the summary has no per-check wall clock and inventing one would be a lie.
8. **TRIAGE** — threshold/check failures route as UNKNOWN + performance review (rule 2); verify the environment was healthy before blaming code.
    The k6 summary and environment log ride along in the bundle so the reviewer sees the noise floor, not just the breach.
9. **HEAL** — admissible healing is limited to test-side issues (bad scenario, wrong data volume); a failing budget is never "healed" by editing the threshold in place.
10. **VERIFY** — re-run the scenario after a fix on the same environment; a regression closes with an OBSERVED green summary at the SAME budget.
11. **MEASURE** — track p95/error-rate/throughput trends across runs; correlate threshold failures with the change sets that introduced them.
12. **LEARN** — record regression patterns (`failure`) and scenario defects (`flake_observed` for unstable load behavior); feed recurring bloat patterns into review checklists.

## Anti-patterns

- Writing load scripts without thresholds — observations masquerading as coverage; the `metric:` event marker exists precisely so this cannot hide.
- Quoting CI load numbers as production capacity — label INFERRED or say nothing.
- Loosening a threshold to turn a red run green — the budget is the specification; silent loosening is golden-rule-1 violation.
- Running load against shared staging while others work — your results measure their deploys; dedicated environment or no run.
- One "max everything" scenario instead of load/stress/soak/spike design — you learn only that the system breaks somewhere.
- Sleeping instead of staging — arrival-rate stages and realistic think time, not `sleep()` calls inside iteration bodies.
- Retrying a failing load run until one passes — variance is information; cherry-picking the fastest run is fabrication (golden rule 2's spirit).
- Skipping the environment metadata in the bundle — a p95 without its environment spec is unverifiable (golden rule 12).
- Presenting one run's p95 as a trend — a single run is a sample; trends need recorded history on the same environment spec.

## Failure handling

- k6 binary absent or script missing → planned command names the gap; the layer is NOT_RUN, not failed.
- Target unreachable → ENVIRONMENT_FAILURE semantics; fix env before any budget judgment.
- Threshold failure with noisy environment (restarts, other jobs) → re-run once on a verified-quiet environment; if it reproduces, route to performance review with both summaries.
- Check failures with 5xx responses → treat as functional failures discovered under load; route through the normal triage table with the network evidence.
- Summary JSON malformed → parse yields no events and an explicit error; never partially fabricate events.
- Load run coincides with another team's deploy to the shared target → discard the run, record the collision, re-run on a quiet window; a number measured across a deploy is not a measurement.
- Nightly run skipped by infrastructure (agent pool empty, queue overflow) → the layer is NOT_RUN that night and the gap stays visible in the trend; a skipped run is never backfilled from a stale summary or a local guess.

## Evidence requirements

- The k6 summary export is the primary artifact; thresholds map to events; the bundle records scenario name, environment spec, commit, and branch so any number can be re-derived.
- Scenario source is part of the evidence: the exact script (and its versioned thresholds) is referenced, because a budget result without its scenario definition cannot be reproduced.
- Labels: OBSERVED for measured values in the recorded environment; INFERRED whenever a number is extrapolated toward production capacity; CONFIRMED only for a regression closed by a same-budget green re-run; NOT_RUN when the layer never executed; NOT_VERIFIED for claims lacking their summary artifact.
- Budget changes are evidence: the diff that edits a threshold must be reviewable in the same PR as its cause, and the rationale lives in that PR (golden rules 13, 14).
- Trend evidence beats single runs: one green run after a fix, at the same budget, on the same environment — anything weaker stays INFERRED.
- Profiling handoffs are evidence transfers, not verdicts: the bundle names the measured budget, the breach, and the repro command; the developer's profile attaches to the same trail when the cause is found.

## Safety constraints

- `test` (executing load runs against the dedicated environment) → READ_ONLY for tracked sources; artifacts untracked and append-only.
- Load against production or any shared/production-like system → HIGH_RISK (`test.production`/`external.systems`): requires `--confirm-risk`, written authorization, and a blast-radius statement; default answer is NO.
- Soak/stress scenarios on environments with shared storage → treat as HIGH_RISK (they can fill disks and evict data); require `--confirm-risk`.
- Golden rules in force: 1 (thresholds are assertions — never weaken to pass), 2 (no retry-washing of red budgets), 3 (staged load, no sleeps), 4 (no verification claims without the summary artifact), 8 (scrub any credentials from scenario configs and bundles), 9 (no production load without authorization), 12 (environment + scenario metadata preserved), 14 (budget verdicts explained), 15 (signal: few enforced budgets beat many unenforced metrics).

## Output contract

```json
{
  "schemaVersion": "qa.performance.v1",
  "data": {
    "testId": "k6/summary.json::[k6] threshold: http_req_duration",
    "layer": "performance",
    "scenario": { "script": "perf/checkout-load.k6.js", "type": "load", "trafficModel": "staged ramp to documented peak" },
    "environment": { "name": "load-lab-1", "dataVolume": "production-shaped seed", "honesty": "CI numbers ≠ prod" },
    "verdict": "TIMING_CANDIDATE_REVIEW",
    "category": "UNKNOWN",
    "budget": { "metric": "http_req_duration", "stat": "p(95)", "limit": "300ms", "versioned": true },
    "evidence": [
      { "id": "ev-6e7f8a9b", "kind": "metric",
        "location": ".theqa/artifacts/run-2026-01-15/k6-summary.json",
        "summary": "p95 exceeded the versioned 300ms budget on this run; summary attached",
        "collectedAt": "2026-01-15T02:14:00Z", "label": "OBSERVED" }
    ],
    "assumptions": ["environment quiet during run", "seed data volume matched the documented model"]
  },
  "label": "OBSERVED"
}
```

## Examples

**Walkthrough 1 — nightly catches a payload-bloat regression.** A checkout change adds an unmapped join; the nightly load scenario's `http_req_duration` p95 threshold (versioned at 300ms) fails, and the response-size check shows payloads tripling. The event lands as UNKNOWN with the summary attached (rule 2) and routes to performance review. The developer profiles with the bundle in hand, finds the join, fixes it, and the re-run at the SAME budget goes green — CONFIRMED closure. The PR never ran load; nightly did its job.

**Walkthrough 2 — budget proposal done honestly.** A team wants a p95 budget for a new endpoint. There is no SLO yet, so the skill refuses to invent one: the first scenario runs with thresholds commented as "provisional, from one measured baseline" and the metric events carry the `metric:` marker (observations). After three nightly runs establish a stable envelope, a reviewed commit adds the real thresholds with the rationale ("p95 baseline 210–240ms across 3 runs; budget set to 300ms with headroom"). From that commit forward, breaches are failures — enforced, versioned, and honest about where the number came from.

## Verification checklist

- [ ] Every enforced budget is a version-controlled threshold with a documented origin (SLO or measured baseline).
- [ ] No metric without thresholds was reported as an enforced pass (the `metric:` marker is respected).
- [ ] All production-facing claims about numbers are labeled INFERRED; OBSERVED is scoped to the measured environment.
- [ ] Scenario types match the question (load/stress/soak/spike) and the traffic model is documented in-repo.
- [ ] Threshold failures routed as UNKNOWN + performance review — never force-fitted into functional categories.
- [ ] The nightly placement is intact; nothing was deleted to speed PRs.
- [ ] Evidence bundles carry the summary export, environment spec, and commit context.
- [ ] Any threshold change appears as a reviewed diff with rationale in the same PR as its cause.
- [ ] Soak scenarios have explicit durations, leak checks, and reserved environments.
- [ ] Scenarios against one service are scheduled apart and data-isolated.
