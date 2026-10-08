# Enterprise Governance

**Audience:** platform teams, QA leads, and compliance reviewers deploying The-QA-Skill in an organization.
**Source of truth:** `packages/core/src/policies.ts` (safe-automation registry), `packages/core/src/learning/store.ts` (audit log), `packages/data/src/mask.ts` + `packages/data/src/manifest.ts` (PII masking, fixture contracts), `packages/core/src/evidence/bundle.ts` (secret scrubbing), `packages/runners/src/executor.ts` (env allowlist), `docs/enterprise-qa-gap-analysis.md` + `docs/migration-map.md` (capability provenance).

This doc maps the platform's implemented mechanisms onto enterprise controls: who may do what (policy classes), what is on the record (audit), what never leaves the machine unscrubbed (PII/secrets), what is kept and for how long (artifacts), what needs a human (approvals), how to avoid vendor lock-in (adapters), and what it costs (deterministic-by-default).

## Safe automation policy (`ACTION_POLICIES`)

Every action the platform can take is classified in `packages/core/src/policies.ts`. The table below is the registry, verbatim in content (order preserved; rationale strings abbreviated to their exact claims — see source for full strings):

| Action | Safety class | Rationale (source) |
|---|---|---|
| `discover` | `READ_ONLY` | Inspects repository structure and test inventory without writing. |
| `plan` | `READ_ONLY` | Produces a QA plan document in memory; writes only with `--out`. |
| `risk` | `READ_ONLY` | Reads diffs and history; computes scores. |
| `impact` | `READ_ONLY` | Reads diffs and import graph; selects tests without running them. |
| `coverage` | `READ_ONLY` | Computes coverage from inventory; reads only. |
| `flake` | `READ_ONLY` | Reads historical run records; reads only. |
| `report` | `READ_ONLY` | Renders existing artifacts; reads only. |
| `doctor` | `READ_ONLY` | Performs environment health checks; probes local ports without modifying. |
| `explain` | `READ_ONLY` | Explains models, rules, and prior decisions. |
| `test` | `READ_ONLY` | Executing tests does not modify tracked sources; artifacts go to untracked dirs. |
| `generate` | `LOW_RISK_WRITE` | Creates new test files under the generated-tests directory; never overwrites existing files without `--force`. |
| `init` | `LOW_RISK_WRITE` | Writes `theqa.config.json` and `.theqa/` scaffolding into the target repo. |
| `heal.apply.high-tier` | `LOW_RISK_WRITE` | Applies only HIGH-tier healing proposals that passed every policy check; original file preserved as `.bak` alongside. |
| `db.migrate` | `HIGH_RISK` | Destructive database operations can corrupt or destroy persistent state. |
| `test.production` | `HIGH_RISK` | Running tests against production can mutate real data and trigger real side effects (emails, payments). |
| `external.systems` | `HIGH_RISK` | Calls to external third-party systems may create records, spend money, or notify real users. |
| `coverage.delete` | `HIGH_RISK` | Deleting coverage or baseline data destroys verification history. |
| `ci.security.change` | `HIGH_RISK` | Modifying CI security configuration (permissions, secrets, runners) changes the trust boundary. |
| `deploy` | `HIGH_RISK` | Deployments change what real users experience. |
| `prod.data.write` | `HIGH_RISK` | Writing production data is irreversible in general. |
| `notify.external` | `HIGH_RISK` | Posting to Slack/Jira/email reaches humans outside the loop. |
| `test.delete` | `HIGH_RISK` | Deleting tests removes protection; requires strong recorded evidence. |

`SafetyClass` is the three-value union `'READ_ONLY' | 'LOW_RISK_WRITE' | 'HIGH_RISK'` (`packages/core/src/types.ts`).

### Conservative default for unregistered actions

`classifyAction(action)`:

1. Exact registry match wins.
2. Otherwise, an unknown action is `READ_ONLY` **only if** it matches an explicit read verb — `/^(read|inspect|list|show|get|diff|check)/i` — with rationale *"Unregistered read-shaped action; classified conservatively as read-only."*
3. Everything else is `HIGH_RISK` with rationale *"Unregistered action — classified HIGH_RISK until registered in ACTION_POLICIES."*

So a typo'd or invented action fails closed, not open.

## assertAuthorized flow and `--confirm-risk`

`assertAuthorized(action, { confirmRisk? })`:

1. Classifies the action via `classifyAction`.
2. If `safety === 'HIGH_RISK'` and `confirmRisk` is not `true`, throws with a message naming the action, its rationale, and the required flag (`requiresFlag`, default `'--confirm-risk'`).
3. `requiresConfirmation(action)` is the boolean predicate (`safety === 'HIGH_RISK'`).

Call sites embed the guard *inside* the operation: e.g. `applyProposal` calls `assertAuthorized('heal.apply.high-tier', opts)` before touching disk. The flag authorizes that one action; it never downgrades other checks (`canApply` tier gating is independent — see `docs/self-healing.md`). A `--confirm-risk` on the CLI or an agent's explicit approval step is the documented way to pass `{ confirmRisk: true }`.

## RBAC model proposal for teams

The policy classes are designed to map onto organization roles without new machinery. Proposed floor (each role's *maximum* class; anything above is denied at `assertAuthorized`):

| Role | `READ_ONLY` | `LOW_RISK_WRITE` | `HIGH_RISK` (with `--confirm-risk`) |
|---|---|---|---|
| CI pipeline (service identity) | ✅ | `generate`, `init`, `heal.apply.high-tier` in PR scope | none — CI never holds production confirm authority |
| QA engineer | ✅ | ✅ | `test.production`, `external.systems` against staging-like systems only, with recorded approval |
| Release manager | ✅ | ✅ | ✅ — sole role allowed `deploy`, `db.migrate`, `prod.data.write`, `ci.security.change` |
| Coding agent (MCP client) | ✅ | proposals only (see below) | **none** — agents cannot self-authorize (see `docs/security.md`) |

Implementation guidance: enforce per-role by wrapping `assertAuthorized` with a role→allowed-class check, and register organization-specific actions in `ACTION_POLICIES` explicitly (remembering the conservative default). The registry ships no RBAC wiring yet — this is the documented target; do not present it as implemented.

## Audit logging via LearningStore

`packages/core/src/learning/store.ts` is the audit backbone:

- **Format:** append-only JSONL at `.theqa/learning.jsonl` (defaultLearningPath). `append()` never rewrites; `query()` skips malformed lines rather than crashing.
- **Record shape:** `{ id, timestamp, type, tags, payload, effect }` with `LearningRecordType` = `failure | healing_applied | healing_rejected | generation_rejected | review_feedback | flake_observed | mutation_survivor | data_collision`.
- **`effect` is mandatory** in the type — a record states what behavioral consequence it had (e.g. *"recorded REAL_REGRESSION (confidence 0.92) for tests/auth.spec — feeds failure-density learning"*). Nothing mutates behavior silently from a single failure.
- **Ids:** `lr-` + first 10 hex chars of SHA-256 over the record content + timestamp + randomness.
- **Consumers read aggregates:** `failureDensityByPath()` (normalized per-path failure counts, feeds the risk engine's `defectHistory`), `rejectedHealingsFor(testId)` (healing checks prior rejections), `summarize()` (per-type counts).

Governance properties: the log is append-only (tamper-evident by ordering), every autonomous decision (triage outcome, healing applied/rejected, execution failures) lands in it, and readers can reconstruct *what the system did and why* for any day.

## PII and secret handling

Three independent layers — test data, artifacts, and process environment:

**1. Test data masking (`packages/data/src/mask.ts`).** `MASK_PATTERNS`, evaluated in order (card before phone):

| Pattern | Detects | Replacement |
|---|---|---|
| `email` | email shape | `[MASKED_EMAIL]` |
| `ssn` | `ddd-dd-dddd` | `[MASKED_SSN]` |
| `card` | 13–19 digits (spaces/dashes allowed) passing **Luhn** (`luhnValid`) | keeps last 4: `****-****-****-1234` |
| `phone` | 7–15 digits with separators; **dates excluded** (`2026-01-30` is not a phone) | `[MASKED_PHONE]` |
| `token` | ≥ 20 base64ish chars (JWTs, API keys, session ids) | `[MASKED_TOKEN]` |

`maskObject` deep-walks structures and additionally honors **key-name hints** — a key matching `/email|phone|card|ssn|token|secret|password|dob/i` masks the value regardless of shape, labeled by hint word (8 hints, checked in that order). Keys are never rewritten; masking is idempotent; cycles are handled via a `WeakSet`. The principle from the package doc: *realistic shapes, never real people*.

**2. Artifact scrubbing (`packages/core/src/evidence/bundle.ts`).** `SECRET_SCRUBBERS` applied by `scrubSecrets` before anything is written to a bundle:

| Pattern | Replacement |
|---|---|
| `api_key|apikey|secret|password|passwd|token|authorization` `=`/`:` quoted value | `$1: "[REDACTED]"` |
| `Bearer <10+ chars>` | `Bearer [REDACTED]` |
| `ghp_…` GitHub tokens | `[REDACTED_GITHUB_TOKEN]` |
| Stripe `sk|pk_(live|test)_…` | `[REDACTED_STRIPE_KEY]` |
| `AWS_ACCESS_KEY_ID=…` | `AWS_ACCESS_KEY_ID=[REDACTED]` |
| PEM private key blocks | `[REDACTED_PRIVATE_KEY]` |

`console.log`, `network.json`, `failure.md` (and error message/stack inside the narrative) are all scrubbed. The MCP server additionally deep-scrubs every string in tool payloads before serialization (`scrubDeep` in `packages/mcp-server/src/server.ts`) — deep-first matters because `JSON.stringify` escaping would hide quote-anchored patterns.

**3. Environment allowlist (`packages/runners/src/executor.ts`).** Spawned test processes never receive the full `process.env`: `buildChildEnv` forwards only `PATH, HOME, LANG, TZ, CI, NODE_ENV` plus variables prefixed `CI_` or `QA_`. Combined with no-shell spawning (`shell: false`) and a hard timeout (`QA_RUN_TIMEOUT_MS`, default 600,000 ms), CI tokens and cloud credentials cannot leak into test processes or the evidence they produce.

**Fixture manifests (`packages/data/src/manifest.ts`) close the loop:** `validateManifest` collects **all** issues (never fails fast) and requires every suite to declare `seed`, factory specs (name/count/traits), and a cleanup contract (`strategy`: `per-test | per-suite | manual`, plus a named `owner`) — test data always answers *where from, who owns it, how it is cleaned up*.

## Artifact retention guidance

Verified layout facts to build policy on:

- Bundles are written to `<artifactsRoot>/run-<date>/<testId>/` (`evidenceBundleLayout`), default root `.theqa/artifacts` (`theqa.config.json` `paths.artifacts`).
- Bundles are **append-only** — new run directories, never in-place mutation (golden rule 13). Retry attempts that collide on the same test id are moved aside (`-attempt<N>`) so no evidence is clobbered.
- Each bundle: `metadata.json` (run identity: commit, branch, env, browser, seed, retryIndex), `failure.md`, `console.log`, `network.json` (+ copied-in `screenshot.png` / `trace.zip` when the runner produced them).

Recommended retention tiers (organizational choice, not code): keep PR-run bundles for the PR's lifetime (or ~30 days), nightly evidence 90 days, release-gate evidence for the audited release window; `.theqa/learning.jsonl` indefinitely (small, append-only, audit-valuable). Clean up by deleting whole `run-<date>` directories — deleting individual files inside a bundle breaks the evidence chain.

## Approvals workflow

| Decision | Approval path |
|---|---|
| HIGH-tier healing | Auto-apply allowed: backup (`<file>.pre-heal.bak`) + learning record mandatory; `heal.apply.high-tier` is `LOW_RISK_WRITE` |
| MEDIUM/LOW healing | Human review; the MCP surface is proposals-only |
| Real regressions | Gate blocks (`BLOCKED` verdict); a human fixes the product or intentionally changes the specification |
| Test deletion | Human-only, always (`classifyDeletionRequest` never returns `allowed: true`) |
| HIGH_RISK actions | Named human runs with `--confirm-risk` (or an explicit agent approval step wired to `{ confirmRisk: true }`); the action, rationale, and flag are thrown in the error if unconfirmed |
| Disabling gate blocking | Recorded, never silent: `blockOnRealRegression=false` downgrades to a warning with the reason *"policy recorded, not hidden"* (`packages/reporting/src/verdict.ts`) |

## Vendor lock-in avoidance (adapter discipline)

The platform's integrations sit behind interfaces so no vendor is load-bearing (capability rows in `docs/migration-map.md`):

- **SCM/CI:** GitHub Actions, GitLab CI, Jenkins, Azure — templates and detection (`detectStack` checks `.github/workflows`, `.gitlab-ci.yml`, `Jenkinsfile`, `azure-pipelines.yml`) treat all four as equal citizens; runner spawning is shell-free and vendor-neutral.
- **Trackers/chat:** Jira/Linear adapters behind interfaces; `notify.external` is HIGH_RISK so outbound posting is always a confirmed decision; Slack rendering is a payload renderer, not a client lock.
- **Reporting:** JUnit XML writer (the interchange format every CI server understands) + 4-audience Markdown + console/Slack renderers; Allure-style flows map to the evidence bundle layout instead of a proprietary DB.
- **Execution grids:** `Runner` adapter interface — Playwright, pytest, Vitest, Jest, k6, ZAP (plan-only), Appium; BrowserStack/Sauce-style farms attach as adapters, and the farm call itself is `external.systems` HIGH_RISK.
- **Security scanning:** ZAP adapter produces scan *plans* and parses `[ZAP]`-prefixed alerts; swapping scanners does not change triage or gating.
- **Performance:** k6 adapter with threshold/metric event markers; other load tools map onto the same TestEvent contract.
- **Observability:** Sentry/Datadog-style integrations are consumers of the TestEvent/evidence contract, not hard dependencies.
- **Reasoning providers:** `ProviderRegistry` with a deterministic default; OpenAI/Anthropic are interchangeable behind `ReasoningProvider` (see Cost governance).

## Compliance quick-mapping

| Control area | Platform mechanism (implemented) |
|---|---|
| SOC 2 — change management | Append-only learning log with mandatory `effect`; deterministic engines (same input → same verdict, `verdict.ts` module doc); release gate with recorded reasons/blockingFindings; `.pre-heal.bak` backups |
| SOC 2 — least privilege | `ACTION_POLICIES` fail-closed default; HIGH_RISK requires explicit confirmation; env allowlist for spawned processes |
| GDPR — data minimization | Shape-based PII masking (`MASK_PATTERNS`), key-hint masking, Luhn cards keep only last 4; synthetic identities (`user-<seq>@example.test` style) instead of real data; fixture manifests force a cleanup owner |
| GDPR / secrets — storage limitation & confidentiality | Secret scrubbing before artifact write; append-only bundles with retention tiers; `test data: realistic shapes, never real people` |
| Integrity of evidence | Bundles append-only; retries never clobber bundles; normalized evidence (`failure.md` with 12-frame stacks) |

## Cost governance

- **Default provider is deterministic.** `config.integrations.reasoningProvider` defaults to `'deterministic'`; `ProviderRegistry.resolve()` **never throws** — a missing/unconfigured preferred provider falls back to the deterministic provider, whose conclusions carry `fallbackUsed: true` and confidence ceilings (analyze 0.6, generate 0.4, classify capped 0.85). Zero token cost, zero network, by default.
- **Token costs exist only when model providers are configured.** Selecting `'openai'`/`'anthropic'` in config registers those providers (keys from `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` env — never from the config file); only then do `analyze/generate/classify` calls hit APIs. Temperature is 0, `max_tokens` defaults to 1024 (Anthropic), timeout 30s — bounded spend per call.
- The triage/healing/risk/selection cores are pure deterministic code and incur no model cost regardless of provider choice; model calls are reserved for the reasoning layer's optional enrichment.

## Verification

- [ ] `ACTION_POLICIES` rows (21) match `packages/core/src/policies.ts` exactly — class and rationale per action; three-value `SafetyClass` union confirmed in `types.ts`.
- [ ] `classifyAction` default verified: read-verb regex for unknowns, `HIGH_RISK` for everything else (fail-closed).
- [ ] `assertAuthorized` throws naming action, rationale, and `--confirm-risk` (or the action's `requiresFlag`) when unconfirmed; `applyProposal` embeds the guard.
- [ ] LearningStore: append-only JSONL, `lr-<sha10>` ids, mandatory `effect` field, `failureDensityByPath`/`rejectedHealingsFor`/`summarize` consumers; default path `.theqa/learning.jsonl`.
- [ ] Masking: 5 `MASK_PATTERNS` in evaluation order (card before phone), Luhn last-4 preserved (`****-****-****-1234`), 8 key hints, idempotent masking, `validateManifest` collects all issues and requires seed/factories/cleanup.owner.
- [ ] `scrubSecrets` scrubber list (6 patterns) matches `bundle.ts`; MCP server deep-scrubs payloads before serialization.
- [ ] `ENV_ALLOWLIST` = PATH/HOME/LANG/TZ/CI/NODE_ENV + `CI_*`/`QA_*` prefixes; spawn is `shell: false`; hard timeout default 600,000 ms via `QA_RUN_TIMEOUT_MS`.
- [ ] Approvals table matches implemented behavior (auto-apply HIGH-only, deletion human-only, blocking-disabled recorded as warning).
- [ ] RBAC table and retention tiers are labeled as organizational proposals, not shipped code.
- [ ] Cost claims verified: `reasoningProvider` default `'deterministic'`, registry fallback never throws, `fallbackUsed: true`, classify confidence cap 0.85, temperature 0, Anthropic `max_tokens` default 1024.
