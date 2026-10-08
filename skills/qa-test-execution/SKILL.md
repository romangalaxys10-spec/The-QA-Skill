---
name: qa-test-execution
description: Executes test suites under an orchestration policy with strict retry discipline and mandatory evidence collection on every failure. Dry-run first for MCP callers; retries are diagnostics that never hide a regression (golden rule 2).
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa test --policy pr|pre_merge|nightly|release --json"
  mcp: "run_tests(root?, policy?, dryRun) — dryRun defaults TRUE"
  agent: ExecutionAgent
  core: "ACTION_POLICIES (test = READ_ONLY, test.production = HIGH_RISK); writeEvidenceBundle"
---

# QA Test Execution

## Purpose

Run the selected tests through `ExecutionAgent` and produce per-test `TestEvent`s plus evidence bundles for every failure. Execution is the only phase that can upgrade verification labels from `INFERRED` to `OBSERVED`/`CONFIRMED` — nothing in this skill may fabricate or imply a result that a runner did not produce. The `run_tests` MCP tool is OPT-IN: `dryRun` defaults to true, so an agent must explicitly pass `dryRun: false` (or the CLI equivalent) to spawn real processes.

## When to activate

- A selection exists (from `qa impact` / `list_relevant_tests`) and the plan says to execute (`EXECUTE` phase).
- A nightly or release policy run is scheduled and the environment passed `qa doctor`.
- A triage hypothesis needs a clean re-run for confirmation ("restore environment health, re-run, then re-triage").
- Re-verification after a healing apply (`VERIFY` phase) — the healed test must be executed, not assumed fixed.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `policy` | CLI `--policy` / MCP `policy` | no | One of `pr`, `pre_merge`, `nightly`, `release`, `post_deploy`. Default `pr` keeps the set minimal. |
| `dryRun` | MCP `dryRun` | no | **Defaults TRUE.** Plan-only: builds runner commands, spawns nothing, emits zero events. Real execution requires explicit `dryRun: false`. |
| `selection` | `SelectionResult` | no | When present, commands filter to selected files; `null` selection plans for every detected runner with no file filtering. |
| Runner adapter | injected / `DefaultRunnerAdapter` | no | Detects vitest, jest, playwright, cypress, mocha from `package.json` deps (deterministic order); `npx`-based commands. |
| `execution.maxRetries` | `theqa.config.json` | no | Retry budget per test, default 1 (range 0–3). `rerunBudget` default 3 for bug-reproduction reruns. |
| artifactsRoot | `paths.artifacts` | no | Evidence bundles are written under `<artifactsRoot>/run-<date>/<testId>/`. |
| Event shape | engine output | — | `TestEvent { runId, testId, name, status, durationMs, framework, environment, browser?, commit?, branch?, retryIndex, errorMessage? }`; statuses: `passed \| failed \| skipped \| timedout \| not_run`. |

## Preconditions

Execution inherits everything upstream — running tests on bad inputs multiplies the cost of every mistake:

- `qa doctor` health: the environment is reachable; if the framework is missing, tests are `NOT_RUN` — do not invent results.
- `VALIDATE` phase complete (lifecycle guard: `EXECUTE` requires it).
- For anything touching production systems: `test.production` is `HIGH_RISK` and requires `--confirm-risk` (assertAuthorized throws otherwise).
- Timeouts are real: each command runs under a 600000 ms cap; exit code 124 marks a timeout.
- Parsing is best-effort JSON extraction from runner stdout; when the runner's reporter format changes, the agent reports parsing degradation instead of trusting partial output.
- The working tree is expected to be the commit under test: events carry `commit`/`branch` for reproducibility; reporting events for a different commit than the checkout invalidates every downstream verdict.

## Decision rules

1. IF the caller is an MCP agent and did not explicitly set `dryRun: false`, THEN return the plan (commands per detected runner, no execution) — never execute implicitly.
2. IF no test framework is detected in `package.json` (no vitest/jest/playwright/cypress/mocha), THEN report every inventory test as `not_run` with the reason "no runner detected" and route the user to `qa doctor` — an empty pass is a lie, `NOT_RUN` is the honest outcome.
3. IF policy is `pr`, THEN keep the set minimal and high-signal: selection already applied the e2e budget (`maxPrE2E`, default 25) and deferred excess e2e to pre-merge.
4. IF policy is `pre_merge`, THEN run the expanded relevant set (the e2e deferred by the PR budget belongs here).
5. IF policy is `nightly`, THEN run broad suites and expect flake detection to consume the results — every intermittent failure feeds `qa flake`.
6. IF policy is `release`, THEN run the maximal relevant set for the release scope; treat evidence completeness as a gate input (`evidenceComplete`).
7. IF a test fails and the runner supports retries, THEN retry at most `execution.maxRetries` times (default 1), and record every attempt as a separate `TestEvent` with its `retryIndex` — retries are diagnostics, NEVER a filter. A regression that passes on retry is still triaged as REAL_REGRESSION when the test covers changed code (golden rule 2, enforced in triage rule 9).
8. IF a run fails without per-test parser output, THEN expect the synthesized suite-level failure event — the agent never lets a failed run be silent; do not "clean up" that event.
9. IF a test fails, THEN write an evidence bundle for it (`writeEvidenceBundle`) — metadata.json, failure.md, console.log, network.json; secrets are scrubbed before write (golden rule 8).
10. IF the target environment is production or any external third-party system, THEN stop: `test.production`/`external.systems` are HIGH_RISK; request `--confirm-risk` and a human approval step.
11. IF the environment is unhealthy (doctor reports connection failures), THEN do not burn the retry budget diagnosing infrastructure: fail honestly with `ENVIRONMENT_FAILURE`-shaped evidence and re-queue.
12. IF a selected test is known-flaky (`flakeScore >= 70` in the inventory), THEN run it isolated and do not block the merge verdict on its first failure — record it for the flake skill instead.

### Policy selection table

| Policy | Selection posture | E2E handling | Retry posture | Typical trigger |
|---|---|---|---|---|
| `pr` | Fast, high-signal, minimal | Budget `maxPrE2E` (default 25); excess deferred to pre_merge with a reason | maxRetries (default 1), recorded per attempt | Every push/PR |
| `pre_merge` | Expanded relevant set | The e2e deferred by the PR budget runs here | Same discipline | Pre-merge gate |
| `nightly` | Broad suites | Full e2e as scheduled | Failures feed `qa flake` windows | Scheduled nightly |
| `release` | Maximal relevant for release scope | Full business-critical flows | Evidence completeness is a gate input | Release candidate |
| `post_deploy` | Post-deploy smoke/verification | Per plan | Production rules apply (`test.production` HIGH_RISK) | After deploy |

Note honestly: today the runner passes the policy into `buildArgs` as the documented hook point; `pr` passes through untouched and other policies currently share the same command shape. No fake flags are appended — the policy is real in selection and honest at the runner seam.

## Workflow

The 12-phase lifecycle mapping for execution (primary phase: EXECUTE — the only phase that can move `INFERRED` claims to `OBSERVED`):

| Phase | Role of this skill |
|---|---|
| DISCOVER | Framework detection (vitest/jest/playwright/cypress/mocha) is the discovery input here. |
| MODEL | Not applicable. |
| PLAN | Dry-run IS the plan artifact: exact commands, no side effects. |
| GENERATE | Not applicable. |
| VALIDATE | Confirm environment + selection before spawning. |
| EXECUTE | **Primary phase**: spawn commands (600 s cap each), parse stdout into `TestEvent`s. |
| OBSERVE | Events re-stamped with runId/environment/framework; stderr tail (2000 chars) backs missing error messages. |
| TRIAGE | Failed events + evidence bundles are the triage input. |
| HEAL | Healed tests must be re-executed here (VERIFY support). |
| VERIFY | Re-run the specific tests that were healed or previously failed. |
| MEASURE | Durations feed `avgRuntimeMs` (runtime efficiency component). |
| LEARN | Failed outcomes append `failure` records; retry patterns feed flake signals. |

## Anti-patterns

- Passing `dryRun: true` results off as a run ("planned 200 tests, all green" — nothing ran; that is `NOT_RUN`, not `passed`).
- Raising `maxRetries` to make a flaky suite green: retries hide regressions from humans even when triage sees through them (golden rule 2).
- Suppressing the synthesized suite-level failure because the parser produced nothing readable — a run you cannot parse is still a failed run.
- Running against a stale selection after the diff moved: re-run impact analysis; executing the wrong set wastes the only non-renewable resource (CI time).
- Writing raw console output with secrets into artifacts instead of relying on the scrubbers — never bypass `writeEvidenceBundle`.
- Treating a timeout (exit 124) as a flake without triage: it may be the change slowing the path down.
- Skipping evidence collection for "obviously environmental" failures — triage needs the bundle to prove that claim.
- Re-running a failed command in a loop until it passes, outside the configured retry budget, and reporting only the green attempt — that is retry laundering, the manual version of what golden rule 2 forbids.
- Pointing `artifactsRoot` outside the project: the MCP evidence reader resolves it inside the root and refuses otherwise; keep bundles where the platform can find them.
- Reporting runner wall-clock time as test duration: durations come from parsed events, not from how long `npx` took to boot.

## Failure handling

Every failure path below ends in an honest record — the worst outcome of a failed run is a summary that hides it:

- Command fails to spawn (runner binary missing) → mark affected tests `not_run`, surface the spawn error, route to `qa doctor`.
- Parse produces zero events on a passing run → state parsing was inconclusive; do not fabricate per-test events.
- Timeout (exit 124) → emit `timedout` status event with the command in the narrative; triage classifies it.
- Partial run abort (SIGINT, CI cancel) → report exactly which tests ran and which are `not_run`; no summary guessing.
- Evidence write fails → re-raise; a failure without evidence must be visible, not absorbed.
- Runner exits 0 but parses to zero events → treat as inconclusive (`not_run`-shaped honesty), not as a pass; a green exit with no parseable output is the classic silent-failure shape.
- Selection references tests that no longer exist (inventory drift) → report the stale entries; do not silently drop them from the plan or count them as skipped.

## Evidence requirements

- Every failed test: evidence bundle at `<artifactsRoot>/run-<date>/<testId>/` with metadata (commit, branch, env, browser, retryIndex — reproducibility per golden rule 12).
- Every passed test: `OBSERVED` via a `TestEvent` from a real parse — never upgraded to `CONFIRMED` without corroboration (e.g. a reproducing assertion on a known defect).
- Dry-run results: `NOT_RUN` for every planned test.
- Retried tests: one event per attempt; the verdict labels attach per attempt so triage can see `passAfterRetry`.
- Missing framework / skipped environment: `NOT_RUN` with the reason in the summary — honesty over optimism.
- The synthesized suite-level failure (no per-test parse available) is itself evidence: it carries the stderr tail so triage has something to read.
- Retry counts and reruns are reported as observed facts from the events; claiming "ran once" when `retryIndex` says otherwise is fabrication.

## Safety constraints

- `test` is `READ_ONLY` in ACTION_POLICIES (executing tests does not modify tracked sources; artifacts go to untracked dirs) — but it is SIDE-EFFECTFUL: it spawns real processes and may hit real services. That is why MCP `dryRun` defaults to true.
- The conservative default in ACTION_POLICIES applies to anything unregistered: unknown actions are classified HIGH_RISK until registered — extension points inherit caution by default.
- `test.production`, `external.systems`, `prod.data.write`: `HIGH_RISK`, require `--confirm-risk` + human approval; `assertAuthorized` throws without the flag.
- Golden rules engaged: 2 (never hide a regression behind retries), 4 (no verification claims without execution evidence), 6 (never destroy test isolation for speed — no shared-session merging), 8 (secret scrubbing on artifact write), 12 (reproducibility metadata in every bundle).
- `--confirm-risk` is required only for HIGH_RISK actions; plain suite execution against test environments is not one.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "policy": "pr",
    "dryRun": false,
    "runId": "run-9f2c1a7b3d",
    "frameworks": ["vitest", "playwright"],
    "events": [
      { "runId": "run-9f2c1a7b3d", "testId": "checkout.spec:submits-order", "name": "submits order", "status": "failed", "durationMs": 4311, "framework": "playwright", "environment": "ci", "commit": "e3a1b2c", "retryIndex": 0, "errorMessage": "TimeoutError: Waiting for locator('[data-testid=submit-order]')" }
    ],
    "summary": { "passed": 41, "failed": 1, "skipped": 2, "timedout": 0, "not_run": 0 },
    "evidenceBundles": [".theqa/artifacts/run-2025-01-30/checkout.spec_submits-order/"]
  }
}
```

`data.events[]` mirrors core `TestEvent`; `label` is `OBSERVED` only when events came from real parsed execution. A dry-run response has the same shape with `dryRun: true`, an empty `events[]`, planned commands, and every inventory test accounted under `not_run`.

## Examples

### Walkthrough 1 — PR run with one failure
`qa test --policy pr` on a repo with vitest + playwright. Selection contains 44 tests (3 e2e kept, budget honored). The agent dry-runs first via MCP (`dryRun` defaults true — the plan shows the two npx commands), then executes with `dryRun: false`. 41 pass; `checkout.spec:submits-order` fails on attempt 1 with a locator timeout, passes on retry (maxRetries 1). Both events are emitted (retryIndex 0 and 1) and an evidence bundle is written. The agent does NOT report "44 passed": the summary shows failed=1, and the retry pattern is handed to `qa triage` — which will classify it REAL_REGRESSION if the test covers changed code (golden rule 2).

### Walkthrough 2 — nightly policy, missing framework
`qa test --policy nightly` runs in a service repo whose `package.json` has no test dependency. Rule 2 applies: the agent returns `not_run` for all 12 inventory tests with reason "no runner detected", points the user at `qa doctor` (which reports the same), and emits label `NOT_RUN`-shaped output — no fabricated pass rate. Separately, a nightly run on the web app executes 812 tests; 3 intermittent failures are recorded with per-attempt events and bundles, queued for `qa flake` scoring the next morning. The nightly evidence set is explicitly marked as the flake-detection window input, so the next morning's scorer sees chronological outcomes per test instead of a mush of retry-collapsed results.

## Verification checklist

- [ ] MCP callers saw the dry-run plan before any explicit `dryRun: false` execution.
- [ ] Policy matched intent: pr minimal / pre_merge expanded / nightly broad / release maximal.
- [ ] Every retry emitted its own event with `retryIndex`; no attempt was discarded.
- [ ] Every failure produced an evidence bundle under `run-<date>/<testId>/`.
- [ ] No production or external-system call happened without `--confirm-risk` + human approval.
- [ ] Missing framework produced `not_run` outcomes and a `qa doctor` pointer, not an empty pass.
- [ ] The summary distinguished passed/failed/skipped/timedout/not_run exactly.
- [ ] Evidence bundles were secret-scrubbed (no raw tokens in console.log/network.json).
- [ ] A green exit with unparseable output was reported as inconclusive, not passed.
- [ ] Known-flaky selected tests ran isolated and their first failure did not produce the merge verdict.
