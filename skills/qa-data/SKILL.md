---
name: qa-data
description: Engineers deterministic, isolated, and compliant test data — seeded factories, collision-free identities, explicit cleanup contracts, and PII masking at every enforcement point. The fixture manifest is the per-test answer sheet for source, owner, isolation, and reproducibility.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  core: "packages/data — SeededRandom (mulberry32 + FNV-1a), defineFactory (seq starts at 1), uniqueIdentity, slug, maskValue/maskObject, validateManifest"
  layer: "data"
  quality: "dataQuality + isolation dimensions; learning record type 'data_collision'"
  evidence: "bundle metadata.seed — every evidence bundle records the seed that reproduces the run"
---

# QA Data

## Purpose

Test data answers four questions per test: where it comes from (seed/source), who owns it, how it is isolated, and how it is cleaned up. `packages/data` makes those answers mechanical — mulberry32 seeded by FNV-1a, factories with sequence-based uniqueness, Luhn-aware masking, and a manifest validator that rejects any suite that cannot state its cleanup contract. Same seed → same data is a tested contract, not an aspiration; deterministic data is what makes a failed run reproducible (golden rule 12) and a flaky test diagnosable instead of mysterious.

## When to activate

- Writing or reviewing any test that creates entities (users, orders, accounts) — factory discipline applies from the first line.
- A failure mentions duplicate keys, unique violations, or "user already exists" — collision triage.
- A test passes locally and fails in CI (or vice versa) with data-shaped differences — reproducibility audit.
- Production-shaped data is needed for staging/demo — anonymization pipeline.
- Preparing a suite for parallel execution — isolation and parallel-safety review.
- A compliance question arises about personal data in test systems — masking and retention review.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| Seed | fixture manifest or explicit | yes | Number or non-empty string; string seeds are hashed via FNV-1a to uint32. |
| Factory definitions | repo (test helpers) | yes | `defineFactory({ name, attributes(seq, rnd), traits })` — name non-empty, attributes a function. |
| Trait set | factory definition | no | Named transformations; unknown trait names throw at build time WITHOUT consuming a sequence number. |
| Fixture manifest | per suite/run | yes for seeded suites | `{ seed, factories: Record<slot, {name, count, traits[]}>, cleanup: {strategy, owner} }`. |
| Data to anonymize | exports/staging dumps | no | Runs through `maskValue`/`maskObject` before landing anywhere. |
| Cleanup target | DB/API per strategy | yes | `per-test` \| `per-suite` \| `manual` — always with a named owner. |

## Preconditions

- No `Math.random()` or `Date.now()` in data generation paths — every value derives from a `SeededRandom` (session seed) or the factory sequence.
- Identity-bearing fields (email, username, orderRef) come from `uniqueIdentity` per session — a per-PRNG WeakMap counter yields `user-1@example.test`, `user-2@example.test`, …, collision-free within the session.
- The manifest validates (`validateManifest` collects ALL issues: seed, ≥1 factory spec with non-negative integer counts, cleanup strategy + owner) before the suite runs.
- Production data never enters test systems unmasked; masking happens at enforcement points, not "eventually".

## Decision rules

1. IF a test uses generated data THEN it derives from `SeededRandom` — same seed → same data is a tested contract, and the seed is recorded in the run's metadata (evidence bundle metadata carries `seed?`; golden rule 12).
2. IF identity-bearing fields are involved THEN use `uniqueIdentity` with the session PRNG — the `user-<seq>` counter guarantees no collision within the session; sharing one SeededRandom across the run is what makes uniqueness global to it.
3. IF a factory needs a variant THEN use `withTrait` (returns a NEW factory sharing seq + PRNG, so identities stay unique across both) or per-build overrides — overrides always win, deterministic defaults survive.
4. IF data must be reproducible across machines THEN pin the seed in the committed fixture manifest; factories without an explicit seed default to `fnv1a32(name)`, which is stable but worth pinning anyway for clarity.
5. IF choosing between per-test and shared fixtures THEN default to per-test isolation; shared fixtures are acceptable ONLY for read-only reference data — shared writable state converts parallel runs into order-dependent flakes (golden rule 6).
6. IF seeding an API or database THEN seed through the same interface the app uses (API client or repository layer), record every created identity, and bind cleanup to exactly that identity set — never "delete everything like this".
7. IF defining cleanup THEN `per-test` is the default; `per-suite` for genuinely expensive shared setup (single named owner); `manual` only with a named owner and tracked debt — `validateManifest` rejects a manifest without strategy + owner, because an unnamed owner means nobody cleans up.
8. IF data comes from production or resembles real people THEN mask before it lands anywhere: `maskValue`/`maskObject` — emails → `[MASKED_EMAIL]`, SSNs → `[MASKED_SSN]`, Luhn-valid cards keep last 4 (`****-****-****-1234`), phones (dates excluded) → `[MASKED_PHONE]`, ≥20-char tokens → `[MASKED_TOKEN]`; masking is idempotent.
9. IF a key NAME looks sensitive (`/email|phone|card|ssn|token|secret|password|dob/i`) THEN `maskObject` masks by key hint even when the value matches no shape; card hints still require 13–19 Luhn-valid digits, else `[MASKED_CARD]` — key names leak intent that value shapes hide.
10. IF a collision happens (duplicate email, unique violation) THEN record it as a learning record `data_collision` and find the unseeded source (`Math.random`, `Date.now()` suffix, counter reset) — the quality engine's `dataQuality` dimension specifically flags `Date.now()`-suffixed identity.
11. IF writing a manifest THEN fix ALL `validateManifest` issues in one pass — the validator collects every issue precisely so suites stop failing validation one error at a time.
12. IF a test needs random-looking but stable values (slugs, order refs) THEN `slug(len, sessionRnd)` from the unambiguous alphabet (no 0/O/1/I/L look-alikes); passing the session PRNG keeps everything reproducible from one seed — the shared default slug PRNG is session-scoped and NOT tied to your seed.

### PII detection patterns (packages/data/src/mask.ts, in evaluation order)

| Pattern | Shape | Replacement |
|---|---|---|
| email | `x@y.zz` whole-string | `[MASKED_EMAIL]` |
| ssn | `ddd-dd-dddd` | `[MASKED_SSN]` |
| card | 13–19 digits (spaces/dashes allowed), Luhn-validated | keeps last 4: `****-****-****-1234` |
| phone | 7–15 digits with separators; pure dates (`yyyy-mm-dd`) excluded | `[MASKED_PHONE]` |
| token | ≥20 base64ish chars (JWTs, API keys, session ids) | `[MASKED_TOKEN]` |

### Seeding strategies and the isolation tradeoff

| Strategy | Use when | Isolation cost | Cleanup binding |
|---|---|---|---|
| In-memory factory build | Pure unit tests, no persistence | None — objects die with the test | None needed |
| API seeding | Integration/e2e against a real backend | Per-test identities keep parallel requests safe | per-test: delete the created ids via the same API |
| DB seeding (repository layer) | Tests that must observe persistence effects | Schema-aware; never share writable rows | per-test, or per-suite with a named owner |
| Shared reference data | Read-only lookups (catalog, country lists) | Safe only while strictly read-only | per-suite or manual, owner named |

The tradeoff is always the same: shared fixtures buy speed and charge interest in order-dependent flakes. Pay it only for data no test mutates.

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Inventory data needs per planned test: entities, unique fields, volumes, cleanup surface. |
| MODEL | Define factories + traits; declare the manifest (seed, factories, cleanup strategy + owner). |
| PLAN | Choose isolation per test; decide API vs DB seeding; check parallel safety under the chosen strategy. |
| GENERATE | Build data in fixtures/beforeEach via factories; never inline literals shaped like PII. |
| VALIDATE | `validateManifest` (all issues at once); run the reproducibility check — build twice, deep-equal. |
| EXECUTE | Seed through app-facing interfaces; run the test against data it demonstrably owns. |
| OBSERVE | Record created identities + seed in run metadata so failures reproduce bit-for-bit. |
| TRIAGE | Data-shaped failures classify TEST_DATA_DEFECT; collisions append a `data_collision` record. |
| HEAL | Fix the factory or seed, never the assertion; re-run the reproducibility check after the fix. |
| VERIFY | Re-run twice from the same seed (identical setup) and once from a fresh seed (must still pass). |
| MEASURE | `dataQuality` + `isolation` dimension scores; count of manual-cleanup debts with owners. |
| LEARN | Append `data_collision` and `review_feedback` records with explicit effect statements. |

## Anti-patterns

- `Date.now()`/`Math.random()` identity in tests — kills reproducibility AND poisons flake triage with order-dependent noise.
- One shared mutable "admin user" row that every test mutates — the suite passes alone and fails in parallel.
- Hoping unique emails stay unique (no counter, no seed) — collisions become heisenbugs.
- Hardcoded card numbers copied from the internet as fixtures — they may be real, and they may fail Luhn; generate Luhn-valid synthetic ones instead.
- Cleanup by truncate-everything shared teardown that races parallel workers.
- Masking only values, not key names — `secretHint` fields slip through as "not a pattern match".
- Storing seeds only in CI logs — logs rotate; manifests are committed.
- Treating `example.test` domains as deliverable email — they are test-safe by design; keep them that way.
- Manual cleanup with no owner — `validateManifest` exists precisely to reject this.

## Failure handling

- `validateManifest` returns issues → fix all of them and re-validate; the collector exists so you never play whack-a-mole.
- Collision despite the counter → two sessions shared state (DB not isolated between tests); the collision is an isolation defect — record `data_collision`, fix isolation, do not retry-and-forget.
- Masking broke a test assertion (the test asserted on raw PII) → the test was wrong; assert on masked shape or synthetic values.
- Seed reproduces locally but not in CI → something reads env, clock, or locale; hunt the non-deterministic input instead of blaming the PRNG.
- Factory throws "no trait 'x'" → the error lists available traits; fix the call site — no sequence number was consumed, so rebuilding is safe.
- `buildMany` with negative or non-integer count → throws by contract; the caller is broken, not the data.
- Cleanup target unreachable at teardown → record NOT_RUN for cleanup with the owner named; never let teardown silence swallow it.

## Evidence requirements

- "Same seed → same data": CONFIRMED after the double-build deep-equal check (both sides executed) — this is reproducibility you ran, not read about.
- Masked artifacts: OBSERVED masking ran (masked output captured); claiming "no PII present" without running `maskObject` is NOT_VERIFIED.
- Cleanup executed: OBSERVED from teardown logs or a DB state check; skipped cleanup: NOT_RUN with owner named.
- Seed recorded in evidence bundle metadata: OBSERVED (metadata carries `seed?` when the runner supplied it).
- "Data is synthetic, no real persons": INFERRED unless the pipeline proves provenance — factory-built from a committed seed.

## Safety constraints

- Safety class: in-memory generation and masking are READ_ONLY; seeding test databases through app interfaces is LOW_RISK_WRITE; the HIGH_RISK paths (`prod.data.write`, `db.migrate`) are forbidden for test data — test data never goes near production systems.
- Golden rules engaged: 6 (never destroy test isolation for speed), 8 (secrets/PII never in artifacts), 9 (no destructive production action without authorization), 12 (preserve reproducibility — seed recorded), 15 (deterministic data is signal: failures become diagnosable).
- PII masking enforcement points: fixture creation, evidence artifact write, log capture, report render, cross-team dataset sharing — masking at one layer only is not enforcement.
- `--confirm-risk` has no role in data generation; it appears only if a flow would touch external systems, which test data flows must not.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "manifest": {
      "seed": "checkout-suite-2026-Q3",
      "factories": { "customer": { "name": "customer", "count": 3, "traits": ["premium"] } },
      "cleanup": { "strategy": "per-test", "owner": "tests/checkout/cart.spec.ts" }
    },
    "validation": { "ok": true, "issues": [] },
    "built": {
      "identities": ["user-1@example.test", "user-2@example.test", "user-3@example.test"],
      "reproducible": true
    },
    "masked": { "email": "[MASKED_EMAIL]", "card": "****-****-****-4242", "ssn": "[MASKED_SSN]" }
  }
}
```

`label` reflects what actually ran: OBSERVED when the manifest validated, data built, and the reproducibility check executed this run; NOT_VERIFIED when only the manifest was written.

## Examples

### Walkthrough 1 — deterministic factories and a collision hunt
The checkout suite declares seed `checkout-suite-2026-Q3` with a `customer` factory (3 builds, `premium` trait) and `per-test` cleanup owned by the spec file. A CI rerun reproduces the exact same three identities — the double-build deep-equal check marks reproducibility CONFIRMED. Weeks later a parallel suite collides on email. Triage finds a legacy helper building identity from `Date.now()` (the quality engine had flagged `dataQuality` on that file twice). The collision is recorded as `data_collision` with effect "legacy helper replaced by uniqueIdentity session counter"; the flaky parallel failures disappear because isolation, not luck, now guarantees uniqueness.

### Walkthrough 2 — anonymizing a production-shaped dataset for staging
A staging refresh needs realistic volumes without real people. The pipeline runs `maskObject` over the exported rows: emails become `[MASKED_EMAIL]`, Luhn-valid card numbers keep only their last 4 in group shape, `dob`-keyed fields are masked by key hint even though their ISO-date values match no PII shape, and long JWT-shaped tokens become `[MASKED_TOKEN]`. The refresh job's manifest declares `manual` cleanup with the platform team as named owner — accepted as tracked debt with an expiry, which `validateManifest` requires. Verification greps the staged dataset for the original values (none found — OBSERVED) and the provenance note states the data is masked-from-production, not synthetic, so consumers know exactly what they are querying.

## Verification checklist

- [ ] Every generated value traces to a SeededRandom or the factory sequence — no Math.random/Date.now in data paths.
- [ ] The seed is committed in the fixture manifest and recorded in run metadata.
- [ ] The double-build deep-equal reproducibility check ran (same seed → identical data).
- [ ] Identity-bearing fields use uniqueIdentity or an equivalent session-scoped counter.
- [ ] validateManifest passed with zero issues, including cleanup strategy + named owner.
- [ ] Per-test vs shared fixture choice is deliberate; shared state is read-only.
- [ ] maskValue/maskObject ran at every enforcement point (fixtures, artifacts, logs, reports).
- [ ] Card masking preserved last-4 only after Luhn validation; key-hint fields were masked by name.
- [ ] Any collision this run produced a data_collision learning record with an effect statement.
- [ ] Manual cleanup debts have owners and are counted in MEASURE.
