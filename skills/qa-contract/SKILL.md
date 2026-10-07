---
name: qa-contract
description: Contract testing strategy for the 'contract' layer — contract-first workflows, OpenAPI/schema validation inside tests, backward-compatibility analysis, and provider/consumer verification without mandating any vendor. The skill maps schema-mismatch failure shapes onto the triage engine's categories so drift is diagnosed, not guessed at.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  - core:triage (schema-mismatch shapes → DEPENDENCY_FAILURE / SELECTOR_FAILURE / TEST_DATA_DEFECT paths)
  - core:impact (layer 'contract' entries participate in selectTests and routing hints)
  - core:evidence/bundle (schema diffs recorded as git_diff evidence)
---

# QA Contract

## Purpose

Keep provider and consumer expectations from drifting by making the interface itself a tested artifact. The skill defines the contract-first workflow (schema before client code), how to validate requests/responses against the schema inside ordinary tests, how to distinguish additive from breaking changes, and when a contract test legitimately replaces a heavier integration test. No specific vendor is required — the pattern is schema + generated expectations + verification, implementable with OpenAPI, JSON Schema, or proto files.

The layer's value is precision of blame: integration failures point at the whole stack, contract failures point at the exact boundary and field. That precision only holds when the schema is machine-readable and the expectations are generated from it — hand-copied expectations re-introduce the drift they were meant to catch, one keystroke at a time.

## When to activate

- A provider changes its API/schema, or a consumer upgrades a generated client.
- You are asked to "add contract tests", "check backward compatibility", or "stop integration suites from breaking on schema changes".
- Integration failures cluster around missing fields, renamed fields, or type mismatches across a service boundary.
- A monorepo or multi-repo setup has more than one team consuming the same interface.
- An event/queue payload changed shape and consumers beyond the emitting service must be found before deploy.

## Inputs

| Input | Source | Required | Notes |
| --- | --- | --- | --- |
| Machine-readable schema | OpenAPI/JSON Schema/proto in repo | yes | Versioned; the schema is the contract under test |
| Consumer expectations | generated client types or pact-like expectation files | yes | Derived from the schema, never hand-copied |
| Provider build | the service under test (app or mock) | yes | Contract tests run against the provider or its stub |
| Diff of change set | `analyzeDiff` | yes | Classifies schema edits as additive or breaking |
| Test inventory | `discovery.inventoryTests` | yes | Layer `contract` entries with provider/consumer tags |
| Historical contract failures | learning store | no | Recurring drift paths get standing tests |
| Versioning policy | repo docs | yes | Path/versioning scheme, additive windows, sunset dates |

## Preconditions

- A schema file exists and is loadable; if none exists, generate it from provider types FIRST — consumer expectations written against prose are NOT_VERIFIED by definition.
- The provider can be started locally or stubbed deterministically; contract tests must not depend on live third-party availability.
- Generated clients are regenerated as part of the same change set that edits the schema — stale clients are the classic false drift.
- The schema's versioning strategy is documented (URL/path versioning, additive-only windows, deprecation policy).
- Versioning decisions are recorded per interface: which version prefixes are live, which fields sit in a deprecation window, and when each sunset fires — a contract test without a versioning answer is a guess with a test file around it.
- The additive/breaking classification (table below) is agreed as repo policy, not per-PR improvisation — reviewers and generators apply the same table.

## Decision rules

1. If a schema change only ADDS optional fields or responses → additive: contract tests keep passing; consumers update fixtures opportunistically; no version bump required.
2. If a schema change REMOVES or RENAMES a field, narrows a type, makes an optional field required, or changes a status contract → breaking: requires a provider version bump (or a documented additive path) and consumer updates in the same change set; the contract test suite must encode this explicitly.
3. If a consumer test fails with module/type resolution against the generated client (`Cannot find module`, `version conflict` shapes) → DEPENDENCY_FAILURE at 0.9: the client is stale or mismatched against the schema — regenerate, pin, re-run.
4. If a consumer failure surfaces DB/schema-shaped mismatches (`no such column`, `relation ... does not exist`) → the data layer contradicts the schema; triage lands on the TEST_DATA_DEFECT path at 0.8 per the engine's data patterns — reconcile migration vs schema first.
5. If a UI/E2E test fails because a field the view binds to was renamed in the schema (field-name literal present in the diff) → SELECTOR_FAILURE at 0.9: the consumer binding is stale, not the provider.
6. If the provider passes the consumer-generated contract suite → drift-free for that interaction; label CONFIRMED for the verified pair.
7. If a contract test fully covers an interaction that an integration test also covers → the contract test REPLACES the integration test for that interaction: it is smaller, faster, and points at the exact boundary (golden rule 11); keep the integration test only for genuinely cross-service orchestration.
8. If two services negotiate versions (v1 still live, v2 ramping) → contract tests cover BOTH prefixes; deprecated fields stay tested green until the documented sunset.
9. If a contract failure has no matching signature shape and no schema diff to point at → UNKNOWN (0.2): escalate with the bundle; do not force a category.
10. If schema and implementation are edited in one PR → run the contract suite in the same run; the diff between schema and behavior is the defect class this layer exists to catch.
11. If a consumer pins an exact schema version in its tests → the pin is part of the contract; a provider change that invalidates the pin fails the consumer's suite even when the wire format stayed compatible — resolve by declaring the compatibility range, never by loosening the pin silently.
12. If queue/event payloads are part of the interface → version their schema like any API; consumers of older versions keep passing under the documented window, then migrate before the sunset.

Additive vs breaking — the classification behind rules 1 and 2:

| Schema edit | Class | Required move |
| --- | --- | --- |
| Add optional field / response | additive | none; consumers adopt opportunistically |
| Add required request field | breaking | provider bump or documented default; consumer update |
| Remove or rename a field | breaking | dual-ship window + consumer migration |
| Narrow a type / tighten an enum | breaking | version bump; consumer regeneration |
| Documentation-only edit | neither | no contract impact; the diff is still reviewed |

## Workflow (12-phase lifecycle)

1. **DISCOVER** — locate schema files, generated clients, and existing contract specs; inventory layer `contract`.
2. **MODEL** — classify each schema edit in the diff as additive or breaking; list consumer surfaces touched (API clients, UI bindings, queue payloads).
3. **PLAN** — for each breaking edit, plan the versioning move (bump, additive window, dual-ship); select contract suites via `selectTests`.
    Consumers outside the repo are listed here too — their migration is part of the plan, not a downstream surprise.
4. **GENERATE** — scaffold provider-side tests that validate real responses against the schema, and consumer-side tests that replay interactions against provider stubs.
5. **VALIDATE** — test-quality pass: contract tests must assert field presence, types, and required-ness — a test that only checks 200 is a placeholder, not a contract.
6. **EXECUTE** — run through framework adapters; provider stubs start deterministically (fixed ports/seeds) so failures are reproducible.
7. **OBSERVE** — bundle failures with the schema diff (git_diff evidence) and the offending payload (network evidence).
8. **TRIAGE** — apply decision rules: client-resolution → DEPENDENCY_FAILURE; binding renames → SELECTOR_FAILURE; data-layer contradiction → TEST_DATA_DEFECT path; else honest UNKNOWN.
9. **HEAL** — regeneration of clients/fixtures may be proposed with evidence; provider schema is NEVER auto-edited to satisfy a consumer (that inverts the contract).
    A healing proposal that would delete a consumer expectation instead of regenerating it is refused (golden rule 7).
10. **VERIFY** — after the fix, re-run both sides of the pair; the pair is CONFIRMED only when provider and consumer both pass the same schema version.
11. **MEASURE** — track drift events per interface and per team; measure how often contract tests replaced integration tests and what runtime was saved.
12. **LEARN** — record drift patterns (`failure`, `review_feedback`); recurring breaking-field renames become standing lint rules or generation templates.

## Anti-patterns

- Hand-copying field expectations into consumer tests instead of generating from the schema — the copy IS the drift.
- Treating "it worked yesterday" as compatibility evidence — compatibility is a property of the schema diff, not of vibes.
- Deleting a failing contract test because "the provider changed" — the consumer may not have migrated yet; migrate, then delete with evidence (golden rule 7).
- Auto-editing the provider schema to make a consumer test pass — the tail wagging the dog.
- Contract tests against live third-party production — nondeterministic, unsafe, and HIGH_RISK; use stubs.
- One mega contract test for an entire API — contract tests should be as small as the interaction they pin down (golden rule 11).
- Contract-suite diffs that accompany pure internal refactors — if the wire shape did not change, contract tests should not change; diffs that move anyway signal copied expectations, not contracts.
- Skipping the contract layer because "integration tests cover it" — integration failures point at the whole stack; contract failures point at the boundary.
- Version-suffix URLs versioned only in docs — the schema files carry the versions; if the file naming and the URL scheme disagree, the tests will enforce the disagreement at the worst time.

## Failure handling

- Stale generated client → regenerate in the same PR; if generation is broken, that is the defect (DEPENDENCY_FAILURE evidence).
- Provider stub won't start → NOT_RUN for the contract layer; the gate must not read absent coverage as passing.
- Schema file invalid (unparseable) → CONFIGURATION_FAILURE path: fix the schema before any drift judgment is possible.
- Ambiguous failure with no schema diff → UNKNOWN 0.2, escalate with full bundle; add the new signature shape to documentation once root cause is known.
- Consumer and provider both green but production mismatch → the contract suite is missing the interaction that failed; add it (coverage gap, not triage).
- Schema edit lands without its classification → treat the edit itself as the defect: the additive/breaking table is applied per edit, and an unclassified edit blocks the run's contract verdict.
- Consumer suite passes but against a MOCK the provider never agreed to → the stub is the drift; regenerate the stub from the schema, never the other way around.
- Run executed against the wrong provider version than the consumer pinned → the verdict is NOT_RUN, not drift: verify the provider build's schema version against the consumer's pin before reading any failure as a contract break.

## Evidence requirements

- A contract verdict cites: the schema version under test, the schema diff (git_diff evidence), and the offending payload/response (network evidence) — all three or the claim stays INFERRED.
- Labels: OBSERVED for classified drift with schema diff + payload artifacts; CONFIRMED after the clean dual-sided re-run; INFERRED for classification from error shape alone; NOT_VERIFIED for expectations not derived from a machine-readable schema; NOT_RUN when the provider stub never started.
- Deprecation windows are evidence: a field inside its documented window must stay green in consumer suites; a failure inside a window is a premature-removal defect, not drift by the consumer.
- Breaking-change decisions are recorded as learning records with the additive/breaking classification and the versioning move chosen.
- Failure shapes are mapped, not invented: the engine's dependency patterns (module resolution, version conflict), selector patterns (field literals in diffs), and data patterns (column/relation mismatches) are the documented bridges from triage to contract diagnosis.
- A drift verdict never rests on a single signal: the schema diff plus the failing payload plus the consumer's expectation source all appear in the bundle, so a reviewer can re-derive the classification without re-running anything.

## Safety constraints

- `test` (running contract suites against local/stub providers) → READ_ONLY; `generate` (scaffolding contract tests) → LOW_RISK_WRITE.
- Pointing contract suites at shared staging data stores that other teams rely on → treat as `external.systems` HIGH_RISK; requires `--confirm-risk`.
- Never run provider-breaking experiments against production (`test.production` HIGH_RISK; golden rule 9).
- Golden rules in force: 1 (never weaken schema assertions to absorb drift), 2 (a green rerun after regeneration does not wash out a real breaking change over changed code), 4 (no verification claims without schema + payload evidence), 7 (consumer tests deleted only with migration evidence), 11 (smallest test at the boundary), 12 (reproducible stubs: pinned ports/seeds in metadata), 14 (every drift verdict explains the schema diff it relied on).

## Output contract

```json
{
  "schemaVersion": "qa.contract.v1",
  "data": {
    "testId": "tests/contract/orders-provider.spec.ts::GET /v2/orders/{id} shape",
    "layer": "contract",
    "interface": { "schema": "openapi/orders.v2.yaml", "version": "2.3.0" },
    "changeClass": "breaking",
    "verdict": "DEPENDENCY_FAILURE",
    "confidence": 0.9,
    "diagnosis": "generated client pinned to schema 2.2.0; field 'fulfillmentStatus' added in 2.3.0 and 'eta' narrowed string→object",
    "evidence": [
      { "id": "ev-7c8d9e0f", "kind": "git_diff",
        "location": ".theqa/artifacts/run-2026-01-15/schema.diff",
        "summary": "Schema diff: added required 'fulfillmentStatus'; narrowed 'eta' type (breaking per rule 2)",
        "collectedAt": "2026-01-15T12:40:00Z", "label": "OBSERVED" },
      { "id": "ev-8d9e0f1a", "kind": "network_capture",
        "location": ".theqa/artifacts/run-2026-01-15/orders-provider/network.json",
        "summary": "Provider response missing narrowed 'eta' object shape expected by consumer 2.2.0 client",
        "collectedAt": "2026-01-15T12:40:05Z", "label": "OBSERVED" }
    ],
    "assumptions": ["provider stub deterministic (seeded)", "client regenerated in same change set"]
  },
  "label": "OBSERVED"
}
```

## Examples

**Walkthrough 1 — breaking rename caught at the boundary.** A provider renames `eta` (string) to a nested `eta { at, source }` object. Consumer tests fail with type-resolution errors against the stale generated client (`Cannot find module .../orders.v2` shape) → rule 3: DEPENDENCY_FAILURE at 0.9, with the schema diff attached as git_diff evidence. The team regenerates the client, migrates the two bindings, and dual-ships v1 for the documented window (rule 8). Both sides re-run green → CONFIRMED. No integration suite had to run to locate the fault: the contract test pointed at the exact field.

**Walkthrough 2 — contract test replaces an integration test.** An integration test spends two minutes exercising checkout → orders → inventory end-to-end just to verify the order response shape. Rule 7 fires: a provider-side contract test validating the same response against the schema pins the same guarantee in seconds. The integration test is retired for that interaction (deletion justified by the coverage mapping, golden rule 7's evidence bar), kept only for the genuine cross-service orchestration path. Suite health's runtime component improves and drift now fails in one place instead of somewhere inside a stack trace.

Both walkthroughs share the same closing discipline: the schema version, the additive/breaking classification, and the versioning move are recorded as learning records, so the next edit to that interface starts from history instead of archaeology.

## Verification checklist

- [ ] A machine-readable schema exists, is versioned, and is the sole source of consumer expectations.
- [ ] Every schema edit in the change set was classified additive or breaking with a recorded decision.
- [ ] Breaking changes carry a versioning move (bump / additive window / dual-ship) — not a silent edit.
- [ ] Generated clients were regenerated in the same change set as the schema edit.
- [ ] Contract failures were triaged via the documented shape mapping, not force-fitted.
- [ ] At least one interaction previously covered only by integration tests is now pinned by a contract test (or none qualified).
- [ ] Provider stubs are deterministic; no contract suite depends on live third-party systems.
- [ ] Verdicts cite schema version + schema diff + payload evidence, or carry an honest INFERRED/UNKNOWN label.
- [ ] The additive-vs-breaking table was applied to every schema edit in the change set.
- [ ] Event/queue payload schemas are versioned like API schemas, with sunset dates recorded.
