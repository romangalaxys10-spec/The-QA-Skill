---
name: qa-api
description: API-layer test design and triage for the 'api' layer — positive/negative/boundary coverage per endpoint, status-code discipline, auth-token hygiene, and async verification patterns. API tests are the pyramid's highest-signal layer for business logic, so this skill enforces the API-first policy and explains how endpoint failures cluster into cascades.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  - runners:adapters (vitest/jest/pytest/playwright adapters execute API suites; layer 'api')
  - cli:generate (`qa generate` scaffolds API-layer tests from plan cases)
  - core:evidence/bundle (network.json captures requests/responses per failure)
---

# QA API

## Purpose

Define how API tests are designed, generated, executed, and triaged so business logic is verified at the layer where it is cheapest and most stable. The skill covers per-endpoint coverage design, honest status-code semantics in triage (4xx vs 5xx mean different things), credential handling that never leaks into code or artifacts, and verification strategies for asynchronous behavior — webhooks, queues, SSE, websockets — where naive tests either flake or lie.

The API layer is where the platform's pyramid policy does its work: `selectTests` prefers lower layers for business logic (golden rule 11), routes by change area, and caps E2E additions (`maxPrE2E`). A strong API suite is therefore not just coverage — it is what keeps the E2E layer small enough to stay reliable.

## When to activate

- A change set touches handlers, controllers, resolvers, or service code (`ChangeArea 'api'` or the import closure reaching it).
- You are asked to add API tests, scaffold endpoint suites with `qa generate`, or write contract tests.
- A wave of failures points at one endpoint and you need to separate the primary defect from dependent cascade.
- The pyramid is inverted (E2E-heavy, API-light) and selection keeps paying the E2E tax (routing hints, golden rule 5).
- A spec asserts transport success but never the payload, and you are asked why it still counts as coverage.

## Inputs

| Input | Source | Required | Notes |
| --- | --- | --- | --- |
| Endpoint inventory | route definitions, OpenAPI/schema docs | yes | Per-endpoint: methods, auth scope, side effects |
| Test inventory | `discovery.inventoryTests` | yes | Layer `api` entries with `covers` import closures |
| Diff of change set | `analyzeDiff` | yes | Drives selection and `coversChangedCode` |
| HTTP fixtures | test fixtures with env-backed tokens | yes | Tokens from env/secret store, never literals |
| Network capture | runner request/response hooks | on failure | Written to network.json in the evidence bundle |
| Orchestrated policy | `pr` / `pre_merge` / `nightly` | yes | Decides suite breadth per run |
| Historical failure density | learning store `failureDensityByPath` | no | Hot endpoints get boundary cases before cold ones |

## Preconditions

- The target environment is reachable and seeded; `qa doctor` reports healthy services (a run against a dead environment produces ENVIRONMENT_FAILURE noise, not signal).
- Auth is handled by fixtures that read tokens from environment variables; no token material is ever hardcoded (golden rule 8).
- Test data is created through factories with unique identities; API tests clean up or use isolated namespaces so they stay order-independent (golden rule 6).
- The change-set diff and test inventory exist so `selectTests` can apply the pyramid policy.
- Sandbox credentials exist for side-effecting providers (payments, email); live providers are never test targets (`external.systems` HIGH_RISK without them).
- Cleanup strategy per test: isolated namespaces or factory-managed teardown — order-dependence is a defect the layer refuses to inherit.

Status-code discipline in triage (what the observed status MEANS):

| Observed shape | Triage reading |
| --- | --- |
| 4xx where 2xx expected, deterministic, over changed handler | assertion-shaped → REAL_REGRESSION path (rule 10) |
| 502/503/connection-refused/DNS shapes | infrastructure patterns → ENVIRONMENT_FAILURE (0.85; 0.55 when the test covers changed code) |
| 2xx with a malformed/empty body | weak-assertion smell: the schema assertion is missing, not the endpoint broken |
| 429 where a documented limit should bite | rate-limit contract untested or changed — test the documented shape |
| 401/403 where auth fixture should grant | fixture/credential problem first (TEST_DATA_DEFECT path), provider second |

## Decision rules

1. If an endpoint's behavior changed → require positive, negative, and boundary coverage for it at the API layer before adding any E2E path over the same logic (pyramid policy; golden rule 11: prefer the smallest test that catches the defect).
2. If a test asserts only "status is 2xx" → strengthen it: assert status code, payload schema, and the observable side effect; weak assertions are the false-negative factory.
3. If an API test fails with an assertion-shaped mismatch (e.g. `expected 200 to equal 400`) that is deterministic and covers changed code → REAL_REGRESSION at 0.92 (triage rule 10): the handler returned the wrong status class for the input.
4. If the failure text matches infrastructure shapes (connection refused, 502/503 service unavailable, DNS) and the test does not cover changed code → ENVIRONMENT_FAILURE at 0.85: fix the environment and re-run; do not block the product on env noise.
5. If the failure text matches environment shapes BUT the test covers changed code → confidence drops to 0.55: restore the environment, re-run, then re-triage before concluding anything.
6. If many tests fail sharing one normalized signature → cluster with `clusterFailures` (Jaccard threshold 0.6, sha8 signature ids), mark the primary, and treat the rest as cascade; fixing the endpoint fixes all members — never retry members individually.
7. If tokens, api keys, or authorization headers would land in code or artifacts → move them to env-backed fixtures; the evidence writer scrubs Bearer/api-key/secret patterns before writing (golden rule 8), but fixture hygiene comes first.
8. If the behavior is asynchronous (webhook, queue consumer, SSE stream, websocket) → assert with a deadline-based poll on the resulting state or an event capture; no arbitrary sleeps (golden rule 3); make consumers idempotent so redelivery cannot corrupt assertions.
9. If idempotency or rate-limit semantics changed → dedicated tests: replay the same request with the same idempotency key and expect the recorded outcome; exceed the limit and expect the documented 429 shape.
10. If a changed endpoint has no API-layer coverage at all → report a coverage gap via `analyzeCoverage` and scaffold with `qa generate` rather than papering over it with an E2E test.
11. If a 4xx is received where the test expected success on UNCHANGED code → suspect the test's fixture/data first (TEST_DATA_DEFECT path) or a contract drift with the client — check before filing a product defect.
12. If two tests differ only by input payload over the same endpoint → parameterize rather than duplicate; duplication is a scored quality dimension and parametrized negatives scale.

## Workflow (12-phase lifecycle)

1. **DISCOVER** — detect stack and test frameworks; inventory layer `api` specs and their import closures.
2. **MODEL** — classify the diff (`ChangeArea 'api'`); extract endpoints, auth scopes, and side-effecting operations in play.
3. **PLAN** — select tests with `selectTests`; apply routing hints; budget E2E (`maxPrE2E`) so API suites carry the business logic load.
4. **GENERATE** — `qa generate` scaffolds per-endpoint cases (positive/negative/boundary) from plan cases; fixtures get env-backed auth.
5. **VALIDATE** — test-quality analysis: negativeCoverage, boundaryCoverage, assertionStrength dimensions scored; scaffolds with console-only assertions are rejected.
6. **EXECUTE** — run through the framework adapter; retries only under the execution policy (maxRetries/rerunBudget).
7. **OBSERVE** — capture request/response traffic into network.json; write the evidence bundle with metadata (commit, branch, environment).
    For async flows, the capture includes the trigger request AND the observed downstream effect, or the bundle says the effect was never seen.
8. **TRIAGE** — apply the decision rules; walk the ordered decision table; cluster cascades; keep UNKNOWN honest (0.2, escalate with bundle).
9. **HEAL** — data/timing/selector proposals only with evidence; assertion-weakening proposals are refused by policy (golden rule 1).
10. **VERIFY** — re-run failed clusters after the fix on a clean environment; confirm the primary failure flips and cascade members flip with it.
11. **MEASURE** — flake score per test, suite health components, coverage of changed endpoints; track 4xx/5xx distributions per endpoint over time.
12. **LEARN** — append failure and healing records; feed recurring data-collision patterns (`data_collision`) back into factory design.

## Anti-patterns

- One giant "API smoke" test that walks ten endpoints — a failure anywhere tells you almost nothing; one behavior per test.
- Asserting only status codes — a 200 with a malformed body is a defect the test invited in.
- Hardcoded bearer tokens in specs or fixtures committed to the repo (golden rule 8 violation at the source).
- `await sleep(2000)` before asserting a webhook side effect — nondeterministic under load and penalized by the determinism dimension (golden rule 3).
- Retrying the whole cascade — retries hide the primary regression behind green cascade members (golden rule 2).
- Duplicating business-logic coverage in E2E that the API layer already owns — slower, flakier, and redundant (golden rules 5, 15).
- Sharing mutable entities across tests — ordering dependencies masquerade as product bugs.
- Testing rate limits by hammering a shared environment until a 429 appears — you measured someone else's quota; use a scoped tenant with a documented limit.

## Failure handling

Async verification strategies (choose per mechanism; deadlines everywhere, sleeps nowhere):

| Mechanism | Verification strategy |
| --- | --- |
| Webhook | receiver-side capture; assert payload, signature, and arrival within a deadline |
| Queue | assert the consumer's side effect with a deadline poll; consumers idempotent under redelivery |
| SSE | read until the expected event id; assert event order and schema |
| Websocket | assert connect/subscription ack, then message schema within the deadline |

- Environment unreachable → stop, run doctor, fix env; the re-run replaces the noise, it does not stack on it.
- Missing/invalid fixture data → TEST_DATA_DEFECT path (constraint-violation and fixture patterns classify at 0.8); fix the factory, not the assertion.
- Timeout-shaped failures → TIMING_FAILURE path: measure the slow step; only then consider an explicit, justified deadline change.
- Module/client resolution errors against the API client → DEPENDENCY_FAILURE path (0.9): regenerate or pin the client (see qa-contract).
- network.json absent on failure → evidence incomplete; verdict stays INFERRED and the gate sees `evidenceComplete: false`.
- Async assertion times out at its deadline → treat the deadline as a measured budget: capture the consumer-side state before extending it, and never extend it silently inside the test.
- Rate-limit test trips 429 on a shared tenant → the measurement is invalid by construction (someone else's quota); move to a scoped tenant with a documented limit (rule 9) and re-run — never record the endpoint as limiting on shared-quota evidence.

## Evidence requirements

- Every failure bundles: metadata.json, console.log, failure.md narrative, and network.json (scrubbed) — the network capture is what separates "endpoint returned wrong status" from "request never arrived".
- Labels: OBSERVED for classified failures with captures; INFERRED for classifications resting on error-shape alone; CONFIRMED only after a clean re-run demonstrates the fix; NOT_RUN for skipped suites; NOT_VERIFIED for claims without artifacts.
- Real fixture shape (fixture `api-regression`): POST `/api/orders` with an invalid payload (`items: []`) returns 200 where the handler contract requires 400; two attempts fail with the identical `AssertionError: expected 200 to equal 400`; the spec imports `handleCreateOrder` from the changed `app/api/orders.ts` → rule 10 → REAL_REGRESSION at 0.92 (fixture floor 0.9). Error strings were chosen to leave every earlier rule cold, so the classification is genuinely rule-10, not pattern luck.
- Cascade example (illustrative walkthrough): one broken endpoint, 52 dependent tests failing — all 52 normalize to one signature id, one primary, the rest cascade; the bundle for the representative failure carries the network.json that names the endpoint.
- Credential leak near-misses are recorded: any artifact that needed its Bearer/token patterns scrubbed is a fixture-hygiene defect logged in the learning store — scrubbing is the backstop, not the process.

## Safety constraints

- `test` (running API suites) → READ_ONLY for tracked sources; artifacts go to untracked dirs.
- `generate` (scaffolding API tests) → LOW_RISK_WRITE (generated-tests directory only; never overwrites without `--force`).
- Tests that write to shared or production-like data stores → treat as HIGH_RISK (`prod.data.write`/`test.production`); require `--confirm-risk` and isolation (golden rule 9). Side-effecting endpoints (payments, emails) must run against sandbox providers, never live ones (`external.systems`).
- Golden rules in force: 1 (assertion strength), 2 (no retry-washing), 3 (no sleeps), 5 (no redundant E2E mass), 6 (isolation), 8 (secret hygiene end-to-end: fixtures → network.json → artifacts), 11 (smallest test), 12 (reproducibility: env + seed in metadata), 15 (signal over count).

## Output contract

```json
{
  "schemaVersion": "qa.api.v1",
  "data": {
    "testId": "tests/orders-api.spec.ts::POST /api/orders rejects empty items",
    "layer": "api",
    "endpoint": { "method": "POST", "path": "/api/orders", "authScope": "orders:write" },
    "verdict": "REAL_REGRESSION",
    "confidence": 0.92,
    "cluster": { "signatureId": "a1b2c3d4", "memberCount": 1, "isPrimary": true },
    "expectedStatus": 400,
    "observedStatus": 200,
    "evidence": [
      { "id": "ev-4d5e6f7a", "kind": "network_capture",
        "location": ".theqa/artifacts/run-2026-01-15/tests_orders_api/network.json",
        "summary": "Captured request/response: 200 returned for payload items=[] where 400 required",
        "collectedAt": "2026-01-15T11:02:00Z", "label": "OBSERVED" }
    ],
    "assumptions": ["environment healthy (doctor green)", "auth fixture token scoped to test tenant"]
  },
  "label": "OBSERVED"
}
```

## Examples

**Walkthrough 1 — status-code regression on one endpoint.** A refactor of `app/api/orders.ts` drops the draft-validation guard. The API spec asserting 400 for `items: []` fails twice with `expected 200 to equal 400`; the import closure ties the spec to the changed handler. Rule 3 → REAL_REGRESSION at 0.92. The network.json in the bundle shows the request and the 200 response, making the defect unambiguous. Merge blocked; handler fixed; clean re-run confirms (CONFIRMED).

**Walkthrough 2 — cascade collapse.** The same endpoint breaks in a downstream repo: 52 dependent tests fail across suites. Instead of 52 investigations, `clusterFailures` groups all 52 under one normalized signature (one primary, 51 cascade). The primary's bundle shows the endpoint's 500; the fix lands; a single clean re-run flips all 52. The learning record notes the fan-out so the next selection pass knows this endpoint's blast radius — signal came from one signature, not fifty-two retries.

## Verification checklist

- [ ] Every changed endpoint has positive, negative, and boundary coverage at the API layer.
- [ ] No secret material exists in specs, fixtures, or artifacts; network.json is scrubbed.
- [ ] Status-code assertions check the full contract (status + schema + side effect), not just 2xx.
- [ ] Async flows assert with deadlines on real state; no arbitrary sleeps anywhere.
- [ ] Cascade clusters were handled as one primary + dependents; no member was retried into false green.
- [ ] Idempotency and rate-limit semantics have dedicated tests when they changed.
- [ ] Coverage gaps for changed endpoints were reported, not covered over with E2E tests.
- [ ] Every failure bundle includes network.json or a stated reason it is missing.
- [ ] Async mechanisms each have a deadline-based verification strategy; no sleeps anywhere.
- [ ] Duplicate single-endpoint tests were parameterized instead of copied.
