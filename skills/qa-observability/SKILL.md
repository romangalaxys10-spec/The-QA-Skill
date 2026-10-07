---
name: qa-observability
description: Turns every test execution into structured, scrubbed, append-only evidence — TestEvents for analytics and evidence bundles for failures. Covers what good failure evidence contains, secret scrubbing before artifacts land, retention and privacy discipline, and how observability feeds flake, triage, and learning.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  core: "TestEvent {runId, testId, name, timestamp, status, durationMs, framework, environment, browser?, device?, commit?, branch?, retryIndex, failureCategory?, filePath?, errorType?, errorMessage?, errorStack?}"
  evidence: "writeEvidenceBundle → run-<date>/<testId>/{metadata.json, console.log, network.json, failure.md} (+ screenshot.png/trace.zip when the runner produced them); scrubSecrets before write"
  mcp: "get_failure_evidence (artifactsRoot, datePrefix 'run-<date>', testIdPrefix)"
  downstream: "TestEvent → flake scoring (environment/browser spread), triage (attempts, changedFiles), learning store (failureDensityByPath)"
---

# QA Observability

## Purpose

Every test event is structured data, because everything downstream — dashboards, flake scoring, triage, risk's defect history, the learning loop — reads events, not recollections. Failures additionally produce evidence bundles: an append-only artifact contract (`run-<date>/<testId>/`) that makes a failure reproducible and checkable by a stranger. Two disciplines make it trustworthy: secrets and PII are scrubbed BEFORE artifacts land, and history is never rewritten — yesterday's bundle stays exactly as written (golden rule 13), because evidence you can edit is evidence you cannot trust.

## When to activate

- Configuring a runner adapter or pipeline — capture points, scrubbing, and retention are set up BEFORE the first write.
- After any test run — events are recorded for every status, bundles for failures.
- A triage or flake analysis lacks the evidence it needs — the capture contract was violated; fix it forward.
- Retention policy review — storage vs inspectability tradeoffs with a named owner.
- A secret or PII was found in an artifact — incident handling plus scrubber-pattern update.
- Building dashboards or analytics — verify the event fields feeding them are actually captured.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| Test execution results | runner adapter | yes | Mapped into `TestEvent` per attempt — `retryIndex` distinguishes attempts. |
| Runner identity | adapter | yes | `framework`, `environment`, `browser?`, `device?` — the spread that flake scoring needs. |
| Provenance | git | yes | `commit`, `branch` — honestly undefined outside a git repo; do not fabricate. |
| Console output | runner capture | for failures | Written as `console.log`, scrubbed before write. |
| Network activity | runner capture | for failures | Written as `network.json` (HAR-like), scrubbed before write. |
| Screenshots / traces | runner output | when produced | Copied into the bundle only if the runner actually produced them — never fabricated. |
| Data seed | test data layer | recommended | Bundle metadata carries `seed?` so data-dependent failures reproduce. |
| Artifacts root | config (`paths.artifacts`) | yes | Default layout `<root>/run-<date>/<safeTestId>/`. |

## Preconditions

- The event schema is canonical: status ∈ passed | failed | skipped | timedout | not_run; `retryIndex` counts attempts from 0; timestamps are ISO-8601.
- `testId` is stable across runs — same test, same id — because flake scoring, trends, and `failureDensityByPath` all key on it.
- Secret scrubbers and PII masking are configured before the first artifact write, not retrofitted after the first leak.
- The artifacts directory is append-only by convention: writers create fresh `run-<date>/` directories; nothing mutates in place.

## Decision rules

1. IF a test execution produces a result THEN it becomes a `TestEvent` — structured fields, not a log line; events are the analytics substrate every downstream engine reads.
2. IF status is failed or timedout THEN write an evidence bundle for that testId: metadata.json + console.log + network.json + failure.md, plus screenshot/trace only when the runner actually produced one.
3. IF writing any artifact THEN `scrubSecrets` runs BEFORE the write — it redacts key/value assignment shapes (api_key|secret|password|token|authorization), Bearer tokens, `ghp_` GitHub tokens, `sk_|pk_` live/test keys, `AWS_ACCESS_KEY_ID`, and PEM private-key blocks; scrubbing is not redemption — values that reached git still need rotation.
4. IF captured console/network content contains user-shaped fields THEN `maskObject` runs before write (email/phone/card/ssn/token/secret/password/dob key hints) — privacy discipline is separate from secret scrubbing and both apply.
5. IF a test failed on attempt 1 and passed on retry THEN both attempts are recorded (distinguished by `retryIndex`); the first attempt is what triage reads — retry-pass over changed code classifies REAL_REGRESSION (golden rule 2), so collapsing attempts hides regressions behind green.
6. IF a testId is assigned THEN it must be stable across runs; a renamed test is a new identity — history does not silently merge, and churn fragments every trend that depends on the id.
7. IF metadata is written THEN commit, branch, environment, browser, device, framework, durationMs, retryIndex, and the data seed are recorded — reproducibility (golden rule 12) is judged by whether a stranger can re-run from the bundle alone.
8. IF bundles exist THEN they are append-only: fresh `run-<date>/` directories, never edited, never rewritten (golden rule 13) — corrections are NEW artifacts that reference the old ones.
9. IF retention is configured THEN keep failures and their bundles longer than green runs; green-run events may aggregate to counts while failure bundles stay inspection-ready; retention deletion is a documented, owned policy — destroying verification history (`coverage.delete`-class) is HIGH_RISK.
10. IF events feed downstream engines THEN capture for the consumer: flake scoring needs outcomes with timestamps + environments + browsers; triage needs attempts + changedFiles + recentRuns; risk needs failureDensityByPath — storage without consumers is cost, not observability.
11. IF failureCategory is knowable at capture (hard timeout vs assertion error) THEN set it; otherwise leave it for triage — a guessed category at capture time poisons the triage decision table's ordered rules.
12. IF the same failure signature appears across many testIds THEN that is clusterable signal — capture full `errorType` + `errorMessage` + `errorStack` (the narrative normalizes and keeps the first 12 frames) so signature clustering has material.

### What a good failure narrative contains (failure.md, as rendered)

| Field | Why it is there |
|---|---|
| testId, name, status, framework | Identity — which test, which runner, what happened |
| environment + browser | Where — flake and environment-failure triage start here |
| commit (+ branch) | Provenance — what code was under test |
| timestamp + duration + attempt number | When and how long — attempt = retryIndex + 1 |
| Error section | The scrubbed error message, verbatim |
| Stack (normalized, first 12 lines) | Noise-reduced frames for signature clustering |
| Next step | Pointer to `qa triage` with this bundle |

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Inventory runners and their native outputs (JUnit JSON, Playwright, pytest, k6, ZAP, Appium). |
| MODEL | `TestEvent` is the canonical event shape; the bundle layout is the artifact contract. |
| PLAN | Decide capture points per runner; configure scrubbing, masking, and retention before the first write. |
| GENERATE | — (observability generates nothing; it records what execution produces). |
| VALIDATE | Post-write verification: bundles exist, parse, and contain no secret shapes (spot-check the scrubbers). |
| EXECUTE | Runs emit one event per attempt; adapters map native outputs to the canonical schema. |
| OBSERVE | **Primary phase** — events recorded, bundles written scrubbed-first, metadata complete. |
| TRIAGE | Triage reads attempts + bundles; `failureCategory` is filled by the triage engine, not guessed at capture. |
| HEAL | Healing proposals cite bundle evidence (DOM snapshots, `observedInTarget`); the bundle is the proof. |
| VERIFY | Verify artifacts exist and parse; verify scrubbing on a sample; declare gaps as NOT_RUN. |
| MEASURE | Dashboards: pass rate, duration trend, flake-score trend, failure density by path. |
| LEARN | Learning records + `failureDensityByPath` feed the risk engine's `defectHistory` input. |

## Anti-patterns

- Console-log-only failure reporting — unstructured, unqueryable, and it dies with log rotation.
- Writing artifacts first and scrubbing "later" — later never comes; scrub before write.
- Collapsing retry attempts into one final status — that is how regressions hide behind green retries.
- Mutating yesterday's bundle because the test was "fixed" — history rewrite (golden rule 13).
- testId churn (names embedding timestamps or counters) that fragments every trend.
- Capturing everything (full HARs, screenshots for green tests) with no retention budget — observability that costs more than the product.
- Storing secrets in metadata because "it's internal" — bundles are readable by everyone with repo access.
- Skipping network capture on API failures "because it's big" — network verification (`networkVerified`) is a triage input.
- Treating evidence bundles as backups — they are verification artifacts with a retention policy, not an archive strategy.

## Failure handling

- Bundle write fails (disk, permissions) → record the event with a note that evidence is absent (NOT_RUN for the bundle); never fabricate artifacts after the fact.
- Scrubber misses a novel secret shape → add the pattern to the scrubber list AND rotate the leaked value; document the miss honestly.
- Corrupt or partial bundle → keep it, mark it partial in metadata; a partial bundle beats nothing; never backfill from memory.
- Clock skew across machines → timestamps are ISO-8601 from the runner host; record the host if skew matters for ordering.
- testId collision across suites → the layout sanitizer replaces illegal characters and caps at 80 chars; disambiguate testIds at the source instead of relying on sanitization.
- Artifact store unavailable mid-run → queue events and emit when restored; events truly lost are declared lost (NOT_RUN), never reconstructed.
- PII discovered post-write → treat as a leak: delete per retention policy WITH a record, mask the source, update enforcement points.

## Evidence requirements

- Event fields (status, durationMs, retryIndex, framework, environment): OBSERVED — they are the runner's direct output.
- Bundles: OBSERVED artifacts; a metadata.json with commit + env + seed makes a run reproducible (golden rule 12).
- Scrubbing claims: OBSERVED only with the scrubbed artifact present; "we scrub" without artifacts is NOT_VERIFIED.
- `failureCategory` before triage runs: INFERRED at best — capture-time hints are labels, not verdicts.
- Missing events (runner crashed mid-suite): declared NOT_RUN, with the count of what is missing.
- Analytics built on events: INFERRED until the underlying events are retained and queryable.

## Safety constraints

- Safety class: observation is READ_ONLY; artifact writing is LOW_RISK_WRITE into the artifacts directory; retention deletion and any external sync of artifacts are HIGH_RISK (`coverage.delete` / `external.systems` classes).
- Golden rules engaged: 8 (secrets never in artifacts — scrubbed before write), 12 (reproducibility — metadata sufficient to re-run), 13 (append-only evidence), 14 (explainability — narratives carry next steps, not just errors).
- Privacy: PII is masked before artifacts land; anyone with repo access can read every bundle — write accordingly.
- `--confirm-risk` applies to retention deletions and external artifact sync, never to writing local evidence.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "event": {
      "runId": "run-9f2c1a7b3d",
      "testId": "tests/checkout/cart.spec.ts::adds-item",
      "name": "adds an item to the cart",
      "timestamp": "2026-03-04T09:12:33.104Z",
      "status": "failed",
      "durationMs": 4122,
      "framework": "playwright",
      "environment": "ci",
      "browser": "chromium",
      "commit": "2f1a9c4",
      "branch": "feat/cart",
      "retryIndex": 0,
      "filePath": "tests/checkout/cart.spec.ts",
      "errorType": "TimeoutError"
    },
    "bundle": {
      "path": ".theqa/artifacts/run-2026-03-04/tests_checkout_cart.spec.ts__adds-item/",
      "files": ["metadata.json", "console.log", "network.json", "failure.md"],
      "scrubbed": true
    }
  }
}
```

`event` mirrors the core `TestEvent` contract (fields absent from the source run are honestly omitted, not zero-filled); `bundle.files` lists what was actually written this run.

## Examples

### Walkthrough 1 — first-attempt failure with a green retry
An e2e cart test times out on attempt 1 and passes on attempt 2 after the runner's retry. The adapter emits two events (`retryIndex` 0 and 1) and writes a bundle for the failed attempt: metadata (commit 2f1a9c4, branch feat/cart, chromium, ci, seed), scrubbed console.log, network.json showing the timeout request, and a failure.md with the normalized stack. Triage reads the bundle, computes `coversChangedCode = true` (the cart module is in the diff), and — because the retry passed over changed code — classifies REAL_REGRESSION (golden rule 2). The observability layer made the regression visible; a collapsed single "passed" event would have hidden it entirely.

### Walkthrough 2 — a secret near-miss in console capture
A staged test fixture's token (`ghp_…`-shaped, but a test value) flows into console output during a failed run. The scrubber redacts it before write (`[REDACTED_GITHUB_TOKEN]`), and the post-write verification grep over the bundle finds no token shapes — scrubbing claim OBSERVED. Because the value was a fixture, no rotation is needed; the incident is still recorded as `review_feedback` ("scrubber drill: ghp_ pattern fired correctly"), and the team's drill note restates the real rule: for live secrets, scrubbing never replaces rotation. The bundle itself remains untouched (append-only) — the lesson lives in the learning store, not in a rewritten artifact.

## Verification checklist

- [ ] Every execution emitted a TestEvent per attempt, with stable testIds.
- [ ] Failed/timedout tests have bundles with metadata.json, console.log, network.json, failure.md.
- [ ] Scrubbing ran BEFORE every write; a post-write grep found no secret shapes.
- [ ] PII-shaped fields were masked (key hints honored), not just secret-scrubbed.
- [ ] Retry attempts are distinguishable (retryIndex) and the first attempt is preserved.
- [ ] Metadata records commit, branch, environment, browser, framework, duration, seed where available.
- [ ] No existing bundle was mutated; corrections created new artifacts.
- [ ] Retention policy is documented with an owner; deletions are treated as HIGH_RISK.
- [ ] Missing artifacts/events from this run are declared NOT_RUN, not reconstructed.
- [ ] Downstream consumers (flake, triage, risk, learning) can query what they need from the captured fields.
