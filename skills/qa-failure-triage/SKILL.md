---
name: qa-failure-triage
description: Classifies failed tests into the 12 documented categories using the deterministic ordered decision table, with supporting and contradicting signals attached to every verdict. Clusters duplicate failures and separates primary root causes from cascades — UNKNOWN is an honest, escalation-worthy outcome.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa triage --evidence <file> --json"
  mcp: "triage_failure(failures, changedFiles?, selectorChangedInDiff?)"
  agent: TriageAgent
  core: "classifyFailure + clusterFailures + detectPrimaryCascade"
---

# QA Failure Triage

## Purpose

Turn raw failure records into auditable verdicts: category, confidence, root-cause hypothesis, signals, contradicting signals, evidence, and a recommended action. The engine (`classifyFailure` in `packages/core/src/triage/classify.ts`) is a 12-category ordered decision table — the FIRST matching rule wins, so rule order is semantics. Signatures are noise-normalized first (`buildSignature`: error type + normalized message + first stack frames + file + browser + env, hashed to a stable 8-char cluster id; normalization strips paths, timestamps, UUIDs, ports, line numbers, durations) so that "the same failure" clusters across runs via Jaccard token similarity at threshold 0.6.

Triage never guesses with false confidence: `UNKNOWN` (confidence 0.2) is a real outcome that escalates to a human with the full evidence bundle.

## When to activate

- Any execution produced a failed/timedout event (`TRIAGE` phase — mandatory, cannot be skipped).
- An evidence bundle exists at `<artifactsRoot>/run-<date>/<testId>/` and needs a verdict before healing is considered.
- Many failures appeared at once and you must decide where the one real defect lives (clustering + primary/cascade).
- A release gate needs `failedRealRegressions` and `openUnknownCategories` counts.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `failures` | `FailedTestRecord[]` | yes | `{ testId, name, filePath, layer, attempts: AttemptRecord[], changedFiles, recentRuns, networkVerified?, domVerified?, tags? }`. Attempts carry status/durationMs/timestamp/environment/errorType/errorMessage/errorStack. |
| `changedFiles` | diff analysis | no | Intersected with each record's `changedFiles` → `relevantChangedFiles`; non-empty ⇒ `coversChangedCode` (unless ctx overrides). |
| `selectorChangedInDiff` | `detectSelectorChange(testSource, diffText)` | no | True when a `getByRole/Text/Label/TestId/locator('…')` literal from the test appears in the product diff. |
| Evidence bundles | artifacts root | no | Attaches `test_output`, `git_diff`, `historical_run` evidence with labels. |
| `threshold` | clustering option | no | Jaccard similarity threshold for cluster merge, default 0.6. |
| Verdict shape | engine output | — | `TriageResult { testId, category, confidence, rootCauseHypothesis, signals[], contradictingSignals[], recommendedAction, evidence[], label }`; per-result label is `OBSERVED` when confidence ≥ 0.8, else `INFERRED`. |

## Preconditions

- Attempts are present and ordered; a record with zero attempts cannot be classified (return UNKNOWN honestly).
- `OBSERVE` phase complete — triage runs on recorded events, not on memories of them.
- For the selector rule to fire with high confidence, the product diff text must actually be available; without it the rule degrades to 0.6 and says so.

## Decision rules

The REAL precedence (first match wins; numbers below are the engine's rule order):

1. IF the error matches module-resolution/version-conflict patterns (`Cannot find module`, `Module not found`, `ERR_MODULE_NOT_FOUND`, `ERESOLVE`, `NoSuchMethodError`, …), THEN `DEPENDENCY_FAILURE` (confidence 0.9) — fix install/pinning in the failing environment.
2. IF the error matches syntax/config-load patterns (`SyntaxError`, `ReferenceError`, `Invalid config`, …) AND no selector pattern matched, THEN `CONFIGURATION_FAILURE` (0.85) — deterministic load/compile failure, not behavioral.
3. IF the error is a locator/selector wait failure (`waiting for locator`, `TestingLibraryElementError`, `Element … not visible`, `stale element reference`, …), THEN `SELECTOR_FAILURE` 0.9 when the selector literal appears in the product diff; ELSE if it passed on retry (element appeared late) `TIMING_FAILURE` 0.7; ELSE `SELECTOR_FAILURE` 0.6 with the contradicting signal "selector literal does not appear in the product diff".
4. IF the error matches infrastructure noise (`ECONNREFUSED`, `ETIMEDOUT`, `getaddrinfo`, `502/503`, `port already in use`, `EPERM`, …), THEN `ENVIRONMENT_FAILURE` 0.85 when the test does NOT cover changed code; when it DOES cover changed code, confidence drops to 0.55 with the contradicting signal "env noise may mask a real regression" — fix env, re-run, re-triage.
5. IF a network-layer error appears (`fetch failed`, `net::`, `request failed`, `socket hang up`) while the environment is otherwise reachable, THEN `NETWORK_FAILURE` (0.7).
6. IF the error matches data-integrity/fixture patterns (`duplicate key value`, `unique constraint`, `foreign key`, `no such table`, `fixture`, `E11000`, …), THEN `TEST_DATA_DEFECT` (0.8) — fix the factory/fixture, never the assertion.
7. IF the failure is a timeout and NOT (passed on retry AND no changed code covered AND intermittent history), THEN `TIMING_FAILURE` (0.8 retry-pass without changed code, else 0.55). The exception is deliberate: a timeout-shaped error that passed on retry, covers no changed code, and has intermittent history falls through to rule 8 — retry outcome plus history outweighs the error's phrasing.
8. IF the test failed then passed on retry AND covers no changed code, THEN `FLAKE` (0.88 with intermittent history, else 0.7) — record it in the flake registry; fixing nondeterminism is the mandate, never retries alone.
9. IF the test passed on retry BUT covers changed code, THEN `REAL_REGRESSION` (0.75) — golden rule 2: a retry never washes out a regression when product code changed.
10. IF the failure was consistent (all attempts failed/timed out) AND assertion-shaped (`AssertionError`, `Expected: … Received:`, `toBe|toEqual`, …), THEN `REAL_REGRESSION` 0.92 when the test covers changed code ("product regression until proven otherwise" — block merge), ELSE `TEST_DEFECT` 0.7 ("expectation stale or always wrong" — verify against the spec).
11. IF any assertion-shaped error remains with mixed signals, THEN `ASSERTION_FAILURE` (0.5) — collect more evidence (trace, network, DOM); do not auto-heal or auto-delete.
12. ELSE `UNKNOWN` (0.2) — escalate to human triage with the full bundle; add the learned pattern to the table once root cause is known.

Cross-cutting rules:

- NEVER classify without evidence: no attempts, no verdict beyond UNKNOWN.
- Contradicting signals matter: a 0.55/0.6/0.7 verdict with a `contradicts` signal is a hypothesis to re-run, not a verdict to act on.
- Primary vs cascade: `detectPrimaryCascade` marks a dependency/connection-like cluster PRIMARY when ≥ 2 OTHER clusters share its environment and started within its 5-minute window; later clusters in the same env/window are CASCADE. 87 failures can be 1 broken API behind one primary cluster — read clusters before filing 87 defects. The heuristic is a ranking hint, not proof of causation.

### The 12 categories, grouped by action implication

The 12 `FailureCategory` values, grouped by what they mean for action:

| Action implication | Categories |
|---|---|
| Product is broken — block merge, fix the change | `REAL_REGRESSION` |
| The test/spec is wrong — review or fix the test | `TEST_DEFECT`, `TEST_DATA_DEFECT`, `SELECTOR_FAILURE` |
| Infrastructure/inputs, not code — fix env, re-run | `ENVIRONMENT_FAILURE`, `NETWORK_FAILURE`, `DEPENDENCY_FAILURE`, `CONFIGURATION_FAILURE` |
| Nondeterminism — score, quarantine visibly, fix root cause | `FLAKE`, `TIMING_FAILURE` |
| Not enough evidence — gather more, act on nothing | `ASSERTION_FAILURE`, `UNKNOWN` |

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Cluster inventory: how many distinct signatures exist among the failures. |
| MODEL | Not applicable. |
| PLAN | Choose inputs: which records, which diff context, which bundles. |
| GENERATE | Not applicable. |
| VALIDATE | Verify attempts/history fields are populated; reject empty records. |
| EXECUTE | Not applicable (triage consumes execution output). |
| OBSERVE | Evidence bundles and normalized signatures are built here. |
| TRIAGE | **Primary phase**: run the decision table per failure; cluster; primary/cascade. |
| HEAL | Only SELECTOR/TEST_DATA/TEST_DEFECT-shaped verdicts may proceed to healing — never REAL_REGRESSION. |
| VERIFY | Re-triage after env fixes/re-runs; verdicts must be re-derived, not carried over. |
| MEASURE | Category counts + unknown budget feed the gate (`maxUnknownTriage` default 2). |
| LEARN | Append `failure` records; `failureDensityByPath()` feeds risk defect-history. |

## Anti-patterns

- Guessing a category from the test name ("checkout tests fail = payment bug") instead of the decision table.
- Treating a retry-pass as clean when `coversChangedCode` is true — that is exactly the golden-rule-2 trap rule 9 exists for.
- Filing one defect per failure before clustering: 87 cascaded failures behind one dead API is ONE root cause plus routing cleanup.
- Escalating everything labeled 0.55–0.7 as if it were 0.92: confidence floors per category exist (see rules) — act on low confidence by gathering evidence, not by blocking.
- Dismissing `UNKNOWN` as engine failure and hand-picking a category anyway: UNKNOWN > confident fiction.
- Ignoring contradicting signals because the supporting signal "feels stronger" — contradictions are recorded precisely so humans can audit the verdict.
- Healing or deleting a test based on an `ASSERTION_FAILURE` (0.5) verdict — that verdict explicitly forbids both.
- Re-running a low-confidence verdict repeatedly until it lands on a category you like — re-triage is for changed evidence, not for shopping.
- Passing `selectorChangedInDiff: true` into MCP `triage_failure` without having actually run `detectSelectorChange` over the diff — the flag is an attestation, not a knob.

## Failure handling

- Empty/invalid `failures` array (MCP) → input validation error; return nothing rather than an invented verdict.
- Record with zero attempts → classify as UNKNOWN with an explicit "no attempts recorded" signal; do not crash the batch.
- Unparseable timestamps in primary/cascade analysis → those tests drop out of the window computation; state the reduction.
- Confidence below 0.8 → label is `INFERRED` (the engine does this mechanically: ≥ 0.8 ⇒ `OBSERVED`); say it in prose too.
- Batch larger than useful → cluster first, triage representatives, then confirm members share the verdict.
- `recentRuns` missing from a record → intermittency signals cannot form; the flake/timing boundary degrades — say so in the report instead of letting the confidence number imply more certainty than the inputs carried.
- Environment fields empty on attempts → primary/cascade grouping falls back to 'unknown' env grouping; the cascade window analysis weakens and the report must state that.

## Evidence requirements

- Every verdict carries engine evidence: first-attempt output (`OBSERVED`), covered-changed-files from the diff (`OBSERVED`), recent-run history (`OBSERVED`) — plus your own bundle reads.
- `REAL_REGRESSION` at 0.92 requires the repro signal ("reproduced N/N attempts", `OBSERVED`); without it you hold an `INFERRED` hypothesis.
- Cascade/primary claims: `INFERRED` always — the heuristic itself documents that it is not proof of causation.
- `UNKNOWN` verdicts: attach the full bundle and mark `NOT_VERIFIED` for anything the engine could not observe.
- Verdicts from retry patterns: both attempts must be visible as evidence; a summary line "passed eventually" is not evidence.

## Safety constraints

- Safety class: `READ_ONLY` — triage classifies and recommends; it writes nothing (ACTION_POLICIES).
- No `--confirm-risk` path exists here; anything that would act on a verdict (heal, delete, migrate) belongs to another skill with its own class.
- Golden rules engaged: 2 (retries never hide regressions — enforced as rule 9), 7 (never auto-delete — deletion is never allowed by policy), 10 (always distinguish product defects from test defects — the rule-10 fork), 14 (explainable decisions: signals + contradicting signals + evidence on every verdict).

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "results": [
      {
        "testId": "checkout.spec:submits-order",
        "category": "SELECTOR_FAILURE",
        "confidence": 0.9,
        "rootCauseHypothesis": "The test targets a selector that the change set renamed or moved — test needs updating, product behavior likely unchanged.",
        "signals": [
          { "description": "error is a locator/selector wait failure", "polarity": "supports" },
          { "description": "selector literal appears in the product diff (UI was refactored)", "polarity": "supports" }
        ],
        "contradictingSignals": [],
        "recommendedAction": "Update the test to the new selector using role/label-based locators; do not weaken the assertion (golden rule 1).",
        "evidence": [ { "id": "ev-3f1c9a2b", "kind": "test_output", "summary": "first attempt failed: TimeoutError …", "label": "OBSERVED" } ],
        "label": "OBSERVED"
      }
    ],
    "clusters": [ { "id": "a1b2c3d4", "signature": "TypeError: expected <x> to equal <y>", "testIds": ["cart.spec:total", "render.spec:total"] } ],
    "primary": ["a1b2c3d4"],
    "cascade": ["e5f6a7b8"],
    "counts": { "REAL_REGRESSION": 0, "UNKNOWN": 1 }
  }
}
```

`data.results[]` mirrors core `TriageResult`; per-result `label` is `OBSERVED` when confidence ≥ 0.8, else `INFERRED`.

## Examples

### Walkthrough 1 — retry-pass over changed code
`checkout.spec:submits-order` failed attempt 1 (assertion-style error), passed on retry. The change set touched `app/checkout/totals.ts`, which this test covers. Rules 1–8 do not match (no dependency/config/selector/env/network/data patterns; rule 7's flake exception requires NO changed code). Rule 9 fires: `REAL_REGRESSION`, confidence 0.75, signal "passed on retry BUT test covers changed code", action "re-run on a clean environment; if reproducible, block merge". The agent does NOT close the failure as "passed on retry" — the verdict and its contradicting context go to the release gate as one failed real regression.

### Walkthrough 2 — 87 failures, 1 broken API
A nightly run reports 87 failures across 6 clusters. Cluster A (34 tests) matches `ECONNREFUSED`-shaped signatures in env `ci-eu`; clusters B–F started after A in the same env within 5 minutes. `detectPrimaryCascade` marks A primary (dependency-like, ≥ 2 other clusters share env + window) and B–F cascade. The agent files one defect for A ("API service down in ci-eu — dependency failure, 0.9"), annotates B–F as cascade with A's id, and re-triages 12 tests that kept failing after the API recovered — two of those are consistent assertion failures over changed code and become REAL_REGRESSION (0.92). The other 76 failures never reach a human queue as individual defects.

## Verification checklist

- [ ] Every verdict names its rule number from the ordered table, not just a category string.
- [ ] No classification was made without attempts/evidence; empty records returned UNKNOWN.
- [ ] Contradicting signals were surfaced wherever confidence < 0.8.
- [ ] Retry-passes over changed code were classified REAL_REGRESSION (rule 9), never FLAKE.
- [ ] Clustering ran before defect filing; primary vs cascade was stated for multi-failure batches.
- [ ] UNKNOWN verdicts were escalated with full bundles, not force-classified.
- [ ] Per-result labels follow the ≥ 0.8 ⇒ OBSERVED else INFERRED mechanical rule.
- [ ] No healing, deletion, or gate action was taken from this skill alone (READ_ONLY discipline).
