# Failure Triage

**Audience:** contributors and platform teams extending or operating the triage engine.
**Source of truth:** `packages/core/src/triage/classify.ts` (decision table), `packages/core/src/triage/signature.ts` (normalization + clustering), `packages/agents/src/agents/triage.ts` (context derivation, primary/cascade).
**Contract type:** `TriageResult` in `packages/core/src/types.ts` — `{ testId, category, confidence, rootCauseHypothesis, signals, contradictingSignals, recommendedAction, evidence, label }`.

Triage answers one question deterministically: *given a failed test's attempt history, the change set, and its run history, which of 12 failure categories is this, and how confident are we?* Every rule fires on regex/flag evidence, every classification records the signals that supported it **and** the checks that pointed elsewhere, and `UNKNOWN` is a real outcome — the engine never guesses with false confidence.

## The 12 categories

`FailureCategory` (`packages/core/src/types.ts`), listed with the engine's intended meaning:

| Category | Definition |
|---|---|
| `REAL_REGRESSION` | Product behavior broke; the change set is implicated. Blocks release (see the gate docs). |
| `TEST_DEFECT` | The test (or its expectation) is stale or was always wrong; product behavior is as specified. |
| `TEST_DATA_DEFECT` | Uniqueness collisions, missing fixtures, schema mismatches in the data the test set up. |
| `ENVIRONMENT_FAILURE` | Infrastructure noise: service/port/network unavailability with no product change involved. |
| `NETWORK_FAILURE` | A network request inside the test failed while the environment was otherwise reachable. |
| `DEPENDENCY_FAILURE` | Module resolution or version conflicts — a dependency is missing/incompatible/uninstalled. |
| `FLAKE` | Same commit, no relevant change, retry passes — nondeterminism signature. |
| `TIMING_FAILURE` | Deadline exceeded (explicit timeout or late element) without selector-change semantics. |
| `SELECTOR_FAILURE` | Locator cannot find the element; UI was refactored (selector literal in diff) or element removed. |
| `ASSERTION_FAILURE` | Assertion-shaped failure with mixed signals — evidence insufficient for a confident call. |
| `CONFIGURATION_FAILURE` | Syntax/type/config-load errors: deterministic, compile-time-shaped, not behavioral. |
| `UNKNOWN` | No documented signature pattern matched with sufficient confidence. Escalate to a human. |

## TriageContext: the three context fields

`classifyFailure(record: FailedTestRecord, ctx: TriageContext)` takes a context of exactly three fields (declared in `classify.ts`):

| Field | Type | Meaning | How `TriageAgent` derives it (`packages/agents/src/agents/triage.ts`) |
|---|---|---|---|
| `coversChangedCode` | `boolean` | Any changed file is (transitively) covered by the failing test. | Explicit ctx value when the orchestrator supplies one; otherwise `true` exactly when the failure's `changedFiles` intersect the orchestrator-provided changed files. Empty intersection → `false` — **never assumed true**. |
| `relevantChangedFiles` | `string[]` | Changed file paths relevant to this test. | `failure.changedFiles` filtered to the orchestrator's changed-file list (empty set when none provided). |
| `selectorChangedInDiff` | `boolean` | A selector/locator literal used by the test appears in the diff. | Explicit ctx value when given; otherwise the test file is read and `detectSelectorChange(testSource, diffText)` runs against the optional `diffText` extension. |

`detectSelectorChange` extracts literals from `getByRole|getByText|getByLabel|getByTestId|locator('...')` calls and returns `true` if any literal appears in the diff text. No diff text → `false`.

The agent also appends every outcome to the learning store (`type: 'failure'`, tags `['triage', category]`, payload with testId/category/confidence/paths, explicit `effect` string) when a store is present — see `docs/enterprise-governance.md` for the audit contract.

## The ordered decision table

Rules are evaluated top-down in `classifyFailure`; **the first match returns**. Confidences are the exact constants in the source. "messages" = all attempts' `errorType + errorMessage + errorStack` joined.

| # | Fires when | Category | Confidence |
|---|---|---|---|
| 1 | Any `DEPENDENCY_PATTERNS` match (`Cannot find module`, `Module not found`, `peer dep`, `ERR_MODULE_NOT_FOUND`, `ImportError`, `No module named`, `ERESOLVE`, `version conflict`, `NoSuchMethodError`) | `DEPENDENCY_FAILURE` | 0.9 |
| 2 | Any `CONFIG_PATTERNS` match (`SyntaxError`, `ReferenceError`, `TypeError: ... is not a (function|constructor)`, `Invalid (config|option)`, `unexpected token`, ...) **and** no `SELECTOR_PATTERNS` match | `CONFIGURATION_FAILURE` | 0.85 |
| 3 | Any `SELECTOR_PATTERNS` match (`waiting for (locator|selector)`, `TestingLibraryElementError`, `stale element reference`, `NoSuchElement`, `TimeoutError.*(locator|waitFor|getBy|selector)`, ...). **Sub-branches:** selector literal in diff → `SELECTOR_FAILURE` 0.9; else pass-after-retry and not consistent → `TIMING_FAILURE` 0.7; else → `SELECTOR_FAILURE` 0.6 | see left | 0.9 / 0.7 / 0.6 |
| 4 | Any `ENV_ERROR_PATTERNS` match (`ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, `EAI_AGAIN`, `ETIMEDOUT`, `getaddrinfo`, `502/503`, `EPERM`, `EACCES`, ...). **Sub-branches:** test covers no changed code → `ENVIRONMENT_FAILURE` 0.85 (plus a signal if `networkVerified === false`); covers changed code → `ENVIRONMENT_FAILURE` 0.55 with a contradicting signal | see left | 0.85 / 0.55 |
| 5 | Network-adjacent error (`fetch failed`, `networkerror`, `net::`, `request failed`, `socket hang up`) **and** network was not verified broken | `NETWORK_FAILURE` | 0.7 |
| 6 | Any `DATA_PATTERNS` match (`duplicate key value`, `unique constraint`, `foreign key`, `E11000`, `no such table/column`, `fixture`, `test data`, `IntegrityError`, ...) | `TEST_DATA_DEFECT` | 0.8 |
| 7 | Timeout-shaped: `timedout > 0` in attempts or `TIMEOUT_PATTERNS` match (`timeout`, `timed out`, `deadline exceeded`, `test timeout of`, ...) — **unless the rule-7 exception below applies**. Confidence: 0.8 when passed-after-retry and no changed code covered; otherwise 0.55 | `TIMING_FAILURE` | 0.8 / 0.55 |
| 8 | `passAfterRetry` **and** `!coversChangedCode`. Confidence: 0.88 with intermittent history, else 0.7 | `FLAKE` | 0.88 / 0.7 |
| 9 | `passAfterRetry` **and** `coversChangedCode` — golden rule 2 (below) | `REAL_REGRESSION` | 0.75 |
| 10 | `consistentFailure` (all attempts failed/timed out) **and** any `ASSERT_PATTERNS` match (`AssertionError`, `expect(ed?)`, `assert`, `Expected:...Received:`, `toBe/toEqual/...`). **Sub-branches:** covers changed code → `REAL_REGRESSION` 0.92; else → `TEST_DEFECT` 0.7 | see left | 0.92 / 0.7 |
| 11 | Any `ASSERT_PATTERNS` match left over with mixed signals | `ASSERTION_FAILURE` | 0.5 |
| 12 | Nothing matched | `UNKNOWN` | 0.2 |

Definitions used by the table (computed up front from `record.attempts` / `record.recentRuns`):

- `retried` — more than one attempt.
- `passAfterRetry` — retried, at least one `passed` attempt, and at least one `failed`/`timedout` attempt.
- `consistentFailure` — every attempt failed or timed out (and there is at least one).
- `intermittentHistory` — `recentRuns` contains both `'passed'` and `'failed'`.

### The rule-7 exception (timeout-shaped that is really flake)

A timeout-shaped failure (explicit `timedout` status or `TIMEOUT_PATTERNS` match) is classified `TIMING_FAILURE` **unless all three** of these hold:

1. it **passed on retry** (`passAfterRetry`),
2. it **covers no changed code** (`!coversChangedCode`),
3. it has **intermittent history** (`recentRuns` mixes passed and failed).

In that case rule 7 is skipped and rule 8 classifies it `FLAKE` at confidence **0.88** (intermittent history adds a supporting signal). Rationale encoded in the source: *the retry outcome plus history outweigh the error's phrasing* — a pure rewording of a flake as a timeout would hide nondeterminism. If any one of the three conditions is missing, the failure stays `TIMING_FAILURE` (0.8 with retry-pass and no changed code, else 0.55).

### Golden rule 2 enforcement (rule 9)

Golden rule 2 is *"Never hide a regression behind retries"* (enforced by `triage/classify.ts` per `packages/core/src/golden-rules.ts`). Mechanically: a retry-pass **does not clear a regression** when `coversChangedCode` is true — rule 9 returns `REAL_REGRESSION` at confidence 0.75 with the supporting signal *"passed on retry BUT test covers changed code"*. Note the interaction with rule 7: a *timeout-shaped* retry-pass over changed code returns earlier from rule 7 as `TIMING_FAILURE` 0.55 (with the contradicting signal *"slowdown may be caused by the change"*); rule 9 catches assertion-shaped and unclassified retry-passes. Either way the retry never produces a clean `passed` story — the run's runners layer additionally refuses retries for `REAL_REGRESSION` failures entirely (`packages/runners/src/retry.ts`: `plan()` returns 0 for `REAL_REGRESSION`).

## Signature normalization and clustering

`packages/core/src/triage/signature.ts` — a signature is *error type + normalized message + normalized stack frames + test file + browser + environment*.

### NOISE_PATTERNS (evaluation order)

Normalization strips run-to-run noise so "the same failure" maps to the same signature across runs:

| # | Pattern | Replacement |
|---|---|---|
| 1 | `node_modules` paths | `<nm>/` |
| 2 | ISO-8601 timestamps | `<ts>` |
| 3 | UUIDs | `<uuid>` |
| 4 | Hex literals (`0x...`) | `<hex>` |
| 5 | URLs with ports | `$1:<port>` |
| 6 | `:line:col` offsets | `:<line>` |
| 7 | bare `:line` offsets | `:<line>` |
| 8 | numbers with units (`12.5ms`, `3s`, `1.2mb`, ...) | `<num>` |
| 9 | standalone integers (2+ digits) | `<num>` |
| 10 | `expected ... to equal ...` | `expected <x> to equal <y>` |
| 11 | `expected ... to (contain|match|have) ...` | `expected <x> to <op> <y>` |

The normalized message is trimmed and **truncated to 300 characters**. Stack frames keep at most **3** meaningful frames (test file first), with `node_modules` paths collapsed to `<nm>/...` and line/column stripped.

### Clustering algorithm

`clusterFailures(failures, { threshold = 0.6 })`:

1. Build a `NormalizedSignature` per failure. The **cluster id** is the first 8 hex chars of the SHA-256 of the canonical parts joined with `§`.
2. Walk failures in order. Merge into the first existing cluster whose **representative** signature has token-set **Jaccard similarity ≥ 0.6** (tokens: lowercased `errorType + message + frames`, split on non-letters, length > 2). Otherwise open a new cluster.
3. `testIds` accumulate per cluster, deduplicated; clusters are returned **sorted by member count, largest first**.

Cluster shape (`SimpleCluster`): `{ id, signature, testIds, representative }`.

### Primary vs cascade

`detectPrimaryCascade(clusters, failures)` in `packages/agents/src/agents/triage.ts` ranks clusters for humans — it is explicitly *correlation, not proven causation*:

- **PRIMARY**: the cluster's signature (or representative error type) matches `DEPENDENCY_ENV_RE` (dependency/connection patterns: `ECONNREFUSED`, `ENOTFOUND`, `getaddrinfo`, `Cannot find module`, `502/503`, ...) **and ≥ 2 other clusters** share its environment with start times within **±5 minutes** (`CASCADE_WINDOW_MS = 5 * 60 * 1000`) of the primary's earliest failure.
- **CASCADE**: any non-primary cluster in the same environment that started after a primary within the 5-minute window.
- Failures without a parseable timestamp are excluded from window math.

## Confidence floor and the label rule

The `verdict()` helper in `classify.ts` applies one label rule to every result:

```
label = confidence >= 0.8 ? 'OBSERVED' : 'INFERRED'
```

So every category at its floor confidence lands honestly: `DEPENDENCY_FAILURE` 0.9 / `CONFIGURATION_FAILURE` 0.85 / `SELECTOR_FAILURE` 0.9 / `ENVIRONMENT_FAILURE` 0.85 / `TEST_DATA_DEFECT` 0.8 / `REAL_REGRESSION` 0.92 and 0.75→ (`INFERRED`) / `FLAKE` 0.88 and 0.7→ (`INFERRED`) / `TIMING_FAILURE` 0.8 and 0.55→ (`INFERRED`) / `SELECTOR_FAILURE` 0.6 / `NETWORK_FAILURE` 0.7 / `ASSERTION_FAILURE` 0.5 / `UNKNOWN` 0.2. Evidence items emitted by the engine (`test_output` for the first attempt, `git_diff` for covered changed files, `historical_run` for recent-run history) carry label `OBSERVED`; the classification label is computed separately by the rule above.

## UNKNOWN is an honest outcome

Rule 12 exists so the platform *never guesses with false confidence*. `UNKNOWN` (confidence 0.2, label `INFERRED`) carries the recommendation to escalate to human triage with the full evidence bundle and to add a pattern to the decision table once root cause is known. Downstream, the release gate tolerates at most 2 open `UNKNOWN` triage results before warning (`maxUnknownTriage`, default 2 — `packages/reporting/src/verdict.ts`), so UNKNOWNs are visible pressure, never silent noise.

## Worked example: 4 same-signature failures → 1 cluster

Input (verified against the engine this session): four tests (`alpha`, `beta`, `gamma`, `delta`) from one Playwright spec, all failing identically behind an auth change:

```
errorType:     AssertionError
errorMessage:  AssertionError: expected 401 to equal 200 at app/http/auth-middleware.ts:41:15
filePath:      tests/auth.spec.ts, browser chromium, environment ci
```

`clusterFailures` returns **one** cluster:

```
{ id: '6864d593', signature: 'AssertionError: expected <x> to equal <y>', testIds: [4 members] }
```

- the message normalizes through pattern 10 (`expected <x> to equal <y>`) and patterns 6–7 (`:<line>`), so line numbers do not split the cluster;
- the id is stable across runs because the canonical parts (type, normalized message, frames, file, browser, env) are unchanged;
- triage then runs per test: with `coversChangedCode=true` (auth middleware is in the diff) and all attempts failed, rule 10 returns `REAL_REGRESSION` at 0.92 (`OBSERVED`) — verified: `classifyFailure` on this shape returns exactly that.

Primary/cascade: the dependency-shaped cluster becomes PRIMARY only when **two other clusters** share its environment within the ±5-minute window — e.g. a second cluster matching `ECONNREFUSED` and a third assertion-shaped cluster, all in environment `ci`, all starting within 5 minutes of the dependency cluster's earliest failure: the dependency-like cluster is PRIMARY and the two later ones CASCADE. With only one other cluster, nothing is marked primary (the ≥ 2 threshold is deliberate — it is a ranking hint for the human, not proof).

## Extension rules for contributors

1. Add patterns, not rules, when possible — new patterns slot into the existing category buckets and preserve the ordering contract.
2. New rules must be inserted by specificity and must record supporting **and** contradicting signals; a rule that cannot name its contradicting checks does not ship.
3. Never raise a confidence constant without a fixture in `fixtures/` that exercises it (see `docs/benchmark.md`).
4. Every new category value must remain within the 12-value `FailureCategory` union — consumers (gate, reporting, MCP) switch on it exhaustively.

## Verification

- [ ] Each of the 12 rules in the table matches the ordered `if` chain in `packages/core/src/triage/classify.ts`, including confidences (0.9, 0.85, 0.9/0.7/0.6, 0.85/0.55, 0.7, 0.8, 0.8/0.55, 0.88/0.7, 0.75, 0.92/0.7, 0.5, 0.2).
- [ ] Rule-7 exception verified by execution this session: timeout-shaped + retry-pass + no changed code + intermittent history → `FLAKE` 0.88 `OBSERVED`; without intermittent history → `TIMING_FAILURE` 0.8.
- [ ] Golden rule 2 verified by execution: assertion-shaped retry-pass over changed code → `REAL_REGRESSION` 0.75 `INFERRED`.
- [ ] `UNKNOWN` honesty verified by execution: unmatched message (`Worker process died with signal SIGKILL`) → `UNKNOWN` 0.2 `INFERRED`.
- [ ] Clustering verified by execution: 4 identical-signature failures → 1 cluster `6864d593` with 4 members; NOISE_PATTERNS table matches `signature.ts` order and replacements; message truncation 300 chars; frames capped at 3.
- [ ] `TriageAgent` context derivation matches the table above (empty intersection → `coversChangedCode: false`; no diff text → `selectorChangedInDiff: false`).
- [ ] `detectPrimaryCascade` constants: `CASCADE_WINDOW_MS = 5 * 60 * 1000`, ≥ 2 other clusters, same environment.
- [ ] Label rule `confidence >= 0.8 → OBSERVED else INFERRED` present in the `verdict()` helper.
- [ ] Learning-store `failure` records append with explicit `effect` when a store is wired.
