# Security

**Audience:** contributors, security reviewers, and platform teams exposing The-QA-Skill to untrusted input (agent clients, foreign repositories, CI).
**Source of truth:** `packages/core/src/triage/signature.ts` (input bounds), `packages/core/src/evidence/bundle.ts` (scrubbing), `packages/runners/src/executor.ts` (spawn hygiene), `packages/mcp-server/src/{server,tools,handlers,rpc}.ts` (agent-facing surface), `packages/reasoning/src/{openai,anthropic,registry,internal}.ts` (network + key handling), `packages/core/src/policies.ts` + `golden-rules.ts` (authorization), root + package `package.json` (supply chain).

This doc is the threat model **of the platform itself** — not a guide to testing other systems (that is `skills/qa-security`). The platform's job is to be safe while pointed at hostile or merely sloppy input: repositories that are not yours, agents that do not share your goals, and error output that contains secrets.

## Trust boundaries and assets

Everything the platform touches crosses one of five boundaries; each boundary names what must not cross it:

1. **Repository content → engines.** Test sources, error output, stacks, DOM snapshots, file names. Must not crash engines, exhaust memory, or execute anything.
2. **Process environment → test processes → artifacts.** CI tokens, cloud credentials, model keys. Must not reach child processes (beyond the allowlist) or survive into on-disk evidence.
3. **Agent client → MCP tool surface.** Whatever an LLM client puts in `tools/call` params. Must not escalate beyond the tool catalog's plan-by-default posture or read outside the project root.
4. **Engines → reasoning providers (optional).** Repo-derived payloads sent to a configured model endpoint. Keys must travel header-only; conclusions must carry their evidence and `fallbackUsed` honesty.
5. **Platform → learning store / evidence tree.** The audit record itself. Must be append-only, scrubbed, and never mutated retroactively.

Failures degrade in one direction only: toward refusal (`assertAuthorized` throws, `applyProposal` refuses, `get_failure_evidence` rejects out-of-root paths, the gate returns `UNKNOWN`) — never toward a confident wrong answer.

## Untrusted repository content

Triage, healing, discovery, and quality engines regex-parse content that originates in the repository under test: error messages, stack traces, test source, DOM snapshots.

**What is bounded (verified constants):**

- Normalized failure messages are truncated to **300 characters** (`normalizeMessage` in `signature.ts`) — after replacement, before hashing/clustering.
- Stack frames: **3** per signature (`normalizeFrames`), **12** in evidence narratives (`renderFailureNarrative`).
- Selector candidates per heal: **8** (`selectorCandidatesFromSnapshot`); `data-testid`/role/label pools capped 5/5/3.
- Evidence bundles returned per MCP `get_failure_evidence` call: **10** (`MAX_EVIDENCE_BUNDLES`).
- Repository file enumeration: **20,000 files** (`listFiles` `maxFiles` default, `packages/core/src/util/glob.ts`), with a fixed ignored-dirs set.
- Captured runner output: **64 MiB** (`MAX_CAPTURE_CHARS` in `executor.ts`), truncation flagged in the captured text.
- Reasoning `inputSummary`: **240 chars**; provider error bodies truncated at **200–300 chars** (`internal.ts`).
- Manifest validation and graph parsing collect/validate finite structures; graph node/edge kinds are closed unions.

**Are the regexes ReDoS-safe — honest answer:** the pattern sets in this repo (`NOISE_PATTERNS`, `SECRET_SCRUBBERS`, triage `*_PATTERNS`, mask patterns, scrub filters) contain **no nested quantifiers** — the `(a+)+`-shape that produces exponential catastrophic backtracking does not occur, so worst-case matching is polynomial (quadratic on `.+...+` sequences), not exponential. The platform does **not** claim linear-time guarantees; it claims the combination above: no exponential shapes, bounded inputs upstream (64 MiB capture, 300-char normalization), and bounded iteration. The one structural caveat worth knowing: `normalizeMessage` applies replacements to the full captured message **before** the 300-char slice, so a pathological multi-megabyte error string does more regex work than a small one — still polynomial, still bounded by the 64 MiB capture cap, and worth shrinking at the capture layer if adversarial repos become a real scenario.

**No shell, ever:** runners spawn via `node:child_process` with `shell: false` (`defaultSpawnImpl`) — repository-controlled file names and arguments cannot become shell syntax.

## Secret hygiene

**3.1 Scrub before artifacts.** `scrubSecrets` applies six patterns (authorization header values, `Bearer` tokens, `ghp_…` GitHub tokens, Stripe `sk|pk_(live|test)_…` keys, `AWS_ACCESS_KEY_ID`, PEM private-key blocks) to `console.log`, `network.json`, `failure.md`, and embedded error message/stack **before** any byte is written to disk (golden rule 8: *never expose secrets in test artifacts*). The MCP server deep-scrubs every string in tool payloads — before serialization, because JSON escaping would hide quote-anchored patterns from the regexes.

**3.2 Spawn allowlist.** Test processes never inherit the full environment: only `PATH, HOME, LANG, TZ, CI, NODE_ENV` and `CI_*`/`QA_*`-prefixed variables are forwarded (`buildChildEnv`). A CI token configured at job scope cannot reach test suites or their captured output.

**3.3 Model-provider keys.** `OpenAIProvider` (env `OPENAI_API_KEY`) and `AnthropicProvider` (env `ANTHROPIC_API_KEY`) hold the key only in the `Authorization` / `x-api-key` **header** of the request. Both module docs and `postJson` enforce: never logged, never embedded in request bodies, never included in error messages. Provider errors surface status + a truncated body, not credentials. There is no key field in `theqa.config.json` — config comments state *"Model endpoints read from environment variables — never from this file."*

**3.4 Test data is not production data.** `packages/data` masking (Luhn-validated cards keep last 4 only, `[MASKED_*]` shapes, key-hint masking) and synthetic identities keep real PII out of fixtures and evidence in the first place (see `docs/enterprise-governance.md`).

**3.5 Provider payloads are validated, not trusted.** A model response is never a verdict until it survives `buildConclusion`: the payload must be an object with a `result`, a finite `confidence` (clamped into [0, 1]), and a **non-empty** evidence array — anything else throws `ProviderError` ("garbage in never becomes a verdict"). Evidence items are mapped to kind `reasoning` with label defaulting to `INFERRED`; model-asserted labels are accepted only from the known five-value `VerificationLabel` set. The system prompt additionally demands JSON-only output and *"Every claim must be backed by evidence. Never invent data that is not present in or derivable from the input."* Honest caveat: category membership for `classify` is enforced by prompt text (`"result.category" MUST be exactly one of: ...`), not by a schema — callers consuming classifications should treat the category as advisory and re-validate against the closed union.

**3.6 Config is not a secret channel.** `theqa.config.json` is Zod-validated with unknown keys **rejected** (a typo fails loudly instead of silently changing behavior), `schemaVersion` pinned to literal `1`, and the upward config search bounded at 12 directory levels. No field accepts credentials or endpoints that would turn the config file into a secret store or an SSRF vector.

## MCP server surface (agent-facing)

The stdio server speaks newline-delimited JSON-RPC 2.0 with a hand-rolled, dependency-free codec (`rpc.ts`: `-32700/-32600/-32601/-32602/-32603`), processes lines strictly sequentially, and converts tool failures into `isError: true` results so no input can crash the loop. Protocol-level safety of the 11 tools:

- **`generate_tests` never writes.** Tool description and handler: *planning only — this tool NEVER writes files*; the returned plan is a proposal for review.
- **`run_tests` is opt-in.** `dryRun` defaults to **true**; only an explicit `dryRun: false` spawns processes. The handler surfaces the safety class (`test` is `READ_ONLY` per `ACTION_POLICIES` but side-effectful) and a note naming which posture ran. Dry runs persist `plan.json` and emit `not_run` synthetic events — nothing is implied or faked.
- **`get_failure_evidence` is root-bounded.** `artifactsRoot` is resolved against the server root and refused unless it resolves **inside** the project root (`artifactsRoot === serverRoot || startsWith(serverRoot + sep)` — path traversal out of the repo is rejected with an explicit error). Bundles are capped at 10, most recent first; metadata contents are secret-scrubbed at the server boundary regardless of what was read.
- **`propose_test_heal` is proposals-only.** There is no apply tool in the catalog — application happens only in deliberate code paths (see §7).
- **`evaluate_release` / `generate_quality_report` are read-shaped** over supplied evidence; the report renderer states `no data` rather than fabricating.
- Unknown tools are `-32602`; unknown methods `-32601`; notifications never get responses; blank lines are ignored. Malformed input degrades to an error message, never a crash.

### Transport and audit-record hardening

- **Sequential protocol:** the read loop fully handles one line before reading the next, and responses are emitted in request order — no interleaving, no re-entrancy surface. Logs go to stderr only; stdout is owned by the protocol.
- **Parse discipline:** `parseMessage` validates `jsonrpc` version, method shape, id type (string/number/null, finite), and params object-shape before any handler runs; malformed JSON is `-32700`, structurally-wrong-but-valid-JSON is `-32600`. Handler output is always wrapped through `renderResponse`/`renderError` — raw exceptions never reach the wire (a belt-and-braces catch maps unexpected failures to `-32603`).
- **Append-only audit:** the learning store is append-only JSONL with content-hash ids (`lr-<sha10>` over record + timestamp + randomness); readers skip malformed lines instead of failing, so a truncated or corrupted line cannot poison queries or crash consumers. Nothing in the codebase rewrites or deletes records — history is preserved by construction (golden rule 13).
- **Untrusted structural input:** fixture manifests (`validateManifest` collects **all** issues, never fails fast) and graph payloads (`QualityGraph.fromJSON` throws pathed `GraphError`s for unknown kinds, bad ids, non-scalar attrs) validate closed vocabularies before anything is stored — hostile JSON shapes are rejected, not partially interpreted.

### Denial-of-service budget

Consolidated resource ceiling per adversarial input (all constants verified this session): captured output 64 MiB per runner process; normalized message 300 chars; ≤ 3 signature frames; ≤ 8 selector candidates; ≤ 10 bundles per MCP evidence query; ≤ 20,000 files enumerated; reasoning timeouts at 30 s per model call; runner hard timeout 600 s (default) via `QA_RUN_TIMEOUT_MS`; MCP processing strictly sequential so one expensive request cannot parallelize into resource exhaustion. Combined with the no-nested-quantifier regex posture, the worst realistic outcome is slowness bounded by these caps, not unbounded memory or CPU.

## Supply chain

Verified declared dependencies (all `packages/*/package.json`, this session):

- **External runtime dependencies: two.** `zod ^3.24.0` (config/context validation) and `picomatch ^4.0.2` (glob matching), both only in `packages/core`. Everything else is workspace-internal (`@the-qa-skill/*`) — including the MCP server, which deliberately hand-rolls its JSON-RPC codec instead of pulling an SDK.
- Root `devDependencies`: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/picomatch` — build/test only.
- The planned CLI argument parser (`commander`) is **not yet declared** in any package.json at this workspace stage; re-verify before quoting the dependency list anywhere.
- **Runtime network posture:** no component performs network I/O except the user-configured reasoning providers (OpenAI/Anthropic at their configured `baseUrl`s, only when `integrations.reasoningProvider` selects them and a key exists). The deterministic provider never networks; discovery, triage, healing, reporting, evidence, and the MCP server are local-fs/git/process only. There is no telemetry, no phone-home, no license server.

## HIGH_RISK confirmation model

`ACTION_POLICIES` classifies every action; the destructive set (`db.migrate`, `test.production`, `external.systems`, `coverage.delete`, `ci.security.change`, `deploy`, `prod.data.write`, `notify.external`, `test.delete`) is `HIGH_RISK` and gated by `assertAuthorized(action, { confirmRisk })`, which throws naming the action, its rationale, and the required `--confirm-risk` flag. Classification is fail-closed: unknown actions are `READ_ONLY` only when they match a read verb, else `HIGH_RISK`. The guard lives **inside** the operation (e.g. `applyProposal` calls it before disk writes), so a caller cannot forget it — and the flag authorizes exactly one action, never a session, and never overrides tier gating (`canApply`).

## Agent-abuse resistance

Design question: can a coding agent that controls MCP `tools/call` payloads escalate itself? Verified barriers:

1. **No HIGH_RISK tool exists in the catalog.** The 11 tools are discovery, risk, selection, generation (plan-only), execution (opt-in via `dryRun:false`), evidence (root-bounded), triage, healing (proposal-only), flake, reporting, gating. The destructive actions in `ACTION_POLICIES` are not reachable through any tool.
2. **No apply path from the wire.** `propose_test_heal` returns a `HealingProposal`; nothing in `TOOL_HANDLERS` applies it. Application (`applyProposal`) additionally re-checks tier, re-runs `assertAuthorized`, and refuses drifted sources — an agent cannot smuggle a patch through a proposal.
3. **`assertAuthorized` cannot be bypassed from input.** The `confirmRisk` flag is a caller-supplied option to *library* calls, not a tool argument; MCP handlers do not forward any user field into it, and the conservative classifier defaults unknown actions to HIGH_RISK, so a forged action name fails closed.
4. **Execution is consent-gated per call.** Even `run_tests` — READ_ONLY by classification — requires explicit `dryRun:false` per invocation, with the posture echoed back in the result.
5. **Reports cannot lie.** Renderers refuse unlabeled claims (`labelPolicy: true` is a required literal) and print `no data` for missing sections; the gate never invents a verdict (empty input → `UNKNOWN`, label `NOT_VERIFIED`).

Residual risks to state plainly: an agent can spend compute (repeated `run_tests` with `dryRun:false` — rate-limit at the client platform), and a hostile repository can shape its own test output (bounded per §2). The learning store is append-only, so a hostile input cannot rewrite audit history, only add records.

### What the platform does not defend against (yet)

Stated so reviewers do not assume protections that do not exist:

- **No authentication on the MCP transport.** stdio assumes the caller's identity is the process owner; anyone who can attach to the server's stdin can call every tool. Do not expose the server over a network socket without adding your own authentication layer in front.
- **No built-in rate limiting or spend caps** for `run_tests` executions or model-provider calls; the 30 s per-call timeout and 600 s runner timeout bound single operations, not totals. Budget enforcement is a client-platform responsibility today.
- **Artifacts are not encrypted at rest.** Scrubbing removes known secret shapes; the bundles themselves (including `metadata.json`) are plaintext under `.theqa/artifacts`. Disk-level protection is the host's job.
- **Spawned test processes are not sandboxed.** The env allowlist limits *credentials*, not *capabilities* — a test process runs with the invoking identity and can do what any test process can. This is inherent to the tool's purpose ("run this repo's tests"); treat the executing identity as the blast radius.
- **Cross-repo path hygiene is one-directional.** `get_failure_evidence` is root-bounded, but other engines deliberately read repo files (test sources, stacks) — the assumption is that the operator chose the repo. Running the platform against a hostile repo is covered by §2's bounds, not by isolation.

### Contributor security review checklist

Touching any of these files warrants a security-focused review pass, because each enforces an invariant named in this doc:

| File | Invariant |
|---|---|
| `packages/core/src/evidence/bundle.ts` | scrub-before-write; append-only layout |
| `packages/runners/src/executor.ts` | env allowlist; `shell: false`; hard timeout; capture cap |
| `packages/core/src/policies.ts` | fail-closed classification; HIGH_RISK gating |
| `packages/core/src/heal/policy.ts` | tier gate; drift refusal; backup before patch |
| `packages/mcp-server/src/{rpc,server,handlers}.ts` | parse discipline; root-bounded reads; deep scrub; proposals-only heal |
| `packages/reasoning/src/{internal,openai,anthropic}.ts` | keys header-only; payload validation; no key leakage in errors |
| `packages/data/src/mask.ts` | PII shapes and key hints stay correct (order: card before phone) |

## Reporting vulnerabilities

- Report security vulnerabilities per **`SECURITY.md` at the repository root** — the designated private channel. Do not file public GitHub issues for security reports.
- When reporting, include: affected package(s) under `@the-qa-skill/*`, the tool or engine entry point, minimal reproduction, and (if applicable) the fixture-style evidence bundle with secrets already scrubbed.
- The golden rules relevant to a fix: rule 8 (secrets never in artifacts), rule 9 (destructive actions require authorization), rule 13 (preserve evidence) — a security patch must not silently delete or mutate recorded evidence; the learning store records the change like any other decision.

### Incident response hooks the platform already provides

When a suspected compromise or abuse event occurs, the platform's own machinery supplies the forensics without new tooling:

- **What did it do?** `.theqa/learning.jsonl` — every triage outcome, healing apply/reject, and execution failure with mandatory `effect` strings and timestamps; `summarize()` gives per-type counts in one line.
- **What did it change?** Every applied heal left `<file>.pre-heal.bak` next to the patched file, plus a `healing_applied` record naming the backup path; MEDIUM/LOW proposals never touched disk.
- **What did it run?** `plan.json` per dry run and the per-run evidence tree (`run-<date>/<testId>/`) with run identity metadata (commit, branch, env, retryIndex) — including `not_run` events for anything planned but never executed.
- **What did it see?** Bundles are append-only and scrubbed, so captured output from a suspect run is preserved as-is (modulo scrubbing) for later analysis — delete whole `run-<date>` directories only when the retention window closes, never mid-incident.

## Verification

- [ ] Bounded-input constants quoted here match source: 300-char message normalization, 3 signature frames / 12 narrative frames, 8 selector candidates, 10 evidence bundles, 20,000-file list cap, 64 MiB capture cap, 240-char input summaries.
- [ ] The ReDoS paragraph is accurate as written: no nested-quantifier patterns in `NOISE_PATTERNS`/`SECRET_SCRUBBERS`/triage pattern sets; polynomial-worst-case honestly stated, no linear-time claim.
- [ ] `scrubSecrets` pattern list (6) verified in `bundle.ts`; MCP `scrubDeep` runs before serialization (`server.ts` module doc explains the ordering rationale).
- [ ] `ENV_ALLOWLIST` and `shell: false` verified in `executor.ts`; keys header-only with no log/body/error exposure verified in `openai.ts`, `anthropic.ts`, `internal.ts`.
- [ ] MCP surface claims verified in `tools.ts` + `handlers.ts`: `generate_tests` never writes; `run_tests` `dryRun` default true; `get_failure_evidence` root check `startsWith(serverRoot + sep)`; no apply tool; error-code mapping in `rpc.ts`.
- [ ] Supply-chain claims verified against every `packages/*/package.json`: exactly two external runtime deps (`zod`, `picomatch`), workspace-internal otherwise; `commander` absence noted pending CLI; no telemetry.
- [ ] `assertAuthorized` placement (inside operations) and fail-closed `classifyAction` default verified in `policies.ts`; no MCP handler forwards a user argument into `confirmRisk`.
- [ ] Gate honesty claims verified in `verdict.ts` (empty → UNKNOWN) and `markdown.ts` (`labelPolicy: true` refusal).
- [ ] `SECURITY.md` pointer kept current — update this section if the reporting channel changes.
- [ ] The "does not defend against (yet)" list re-reviewed at each minor release: no MCP auth, no rate limiting, no at-rest encryption, no spawn sandboxing — if any of these ship, move the item into the countermeasures sections above.
