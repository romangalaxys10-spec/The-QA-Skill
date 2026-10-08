# Architecture — The-QA-Skill

> Sponsored by xShredo.dev → https://xshredo.com/promo/anytest

**Audience:** contributors and agent authors. Every claim in this document is checked
against source; the [Verification](#verification) checklist at the end lists what a
reviewer can confirm in the tree. Product context: see
[`docs/enterprise-qa-gap-analysis.md`](./enterprise-qa-gap-analysis.md).

---

## 1. The two-layer architecture

The product is deliberately split into two layers with a one-directional contract:

| Layer | Location | Form | Consumers |
|---|---|---|---|
| **Layer A — skills the agent reads** | `skills/` | 26 `SKILL.md` files (YAML frontmatter + 13 mandated sections: Purpose, When to activate, Inputs, Preconditions, Decision rules, Workflow, Anti-patterns, Failure handling, Evidence requirements, Safety constraints, Output contract, Examples, Verification checklist) | The coding agent (claude-code, cursor, copilot, windsurf, codex, cline, zed, …) reads them as operating guidance |
| **Layer B — packages the skills call** | `packages/` | 10 TypeScript packages, npm workspaces, TS 5.9 strict CJS composite build (`tsc -b`), vitest 2.1.9 | Layer A output contracts, the CLI, the MCP server |

The binding mechanism is the **Output Contract** section every skill carries: a skill
never asks the agent to "be careful" — it names the deterministic engine, CLI command,
or MCP tool that produces the verdict, and the exact output shape. Where the reference
system this project replaces had 440 prose skills and ~2,127 lines of marketplace
plumbing, The-QA-Skill keeps structured guidance (Layer A) but binds every guidance
file to executable, deterministic behavior (Layer B).

Layer A is data. Layer B is the platform. Agents read Layer A and call Layer B; Layer B
never depends on Layer A.

## 2. Package map (10 packages)

Source-level import graph (verified by scanning `packages/*/src` for
`@the-qa-skill/*` imports — see the Verification checklist):

```
                 ┌──────────────────────────────────────────────┐
                 │ core  (depends on nothing internal)          │
                 └──────────────────────────────────────────────┘
                    ▲        ▲        ▲        ▲        ▲
              graph  reasoning  runners  reporting  agents
                                                     ▲
                                                 mcp-server ──▶ agents (type-only)
                 cli, healing: stubs (see below)
```

| Package | Responsibility (one paragraph) |
|---|---|
| `@the-qa-skill/core` | The deterministic QA engine — all shared contracts (`types.ts`), the Zod `QAContext` model, `theqa.config.json` loading, the 12-phase `LifecycleTracker`, safe-automation policy (`policies.ts`), the 8-factor risk engine, change impact + test selection, 12-category failure triage + signature clustering, flake scoring, 17-dimension test quality + suite health, healing tiers/policy, evidence bundles, business-risk-aware coverage, the append-only JSONL learning store, stack discovery, and the 15 Golden Rules with enforcement points. 26 source files, ~3,688 lines. Imports only `zod` and `picomatch`. |
| `@the-qa-skill/graph` | The Quality Graph: a directed attributed store over 12 `NodeKind`s (`Requirement`, `Feature`, `CodeUnit`, `ApiEndpoint`, `UiElement`, `Test`, `Execution`, `Evidence`, `Defect`, `Commit`, `File`, `Symbol`) and 8 `EdgeKind`s (`traces_to`, `covers`, `implements`, `executed_as`, `produced`, `caused_by`, `changed_in`, `references`). Answers `traceRequirement` (the canonical Requirement→Feature→Code→Test→Execution→Evidence→Defect chain) and `affectedTests`. `builders.ts` bridges discovery output into graph nodes (`unit:<path>` ids). |
| `@the-qa-skill/data` | Test data engineering with zero internal dependencies: `SeededRandom` (mulberry32 + FNV-1a), `defineFactory` (sequence starts at 1; attributes → trait → overrides precedence; `withTrait` shares seq + PRNG), `uniqueIdentity` (session-scoped collision-free email/username/orderRef), PII masking (`maskValue`/`maskObject` with documented patterns: email, SSN, card, phone, token), and `FixtureManifest` validation (seed, factories, cleanup strategy + owner). |
| `@the-qa-skill/reasoning` | The `ReasoningProvider` interface (`analyze`/`generate`/`classify`, each returning an `ExplainableConclusion` with confidence, evidence, assumptions, `fallbackUsed`) plus `DeterministicProvider` (no model; keyword scoring capped at confidence 0.85), OpenAI/Anthropic providers (keys from env only, injected `fetchImpl` in tests, zero real network), and `ProviderRegistry` which **never throws**: an unconfigured preferred provider falls back to the deterministic one. |
| `@the-qa-skill/runners` | Test-framework runner adapters behind the `Runner` interface (`id`, `framework`, `detect`, `buildCommand`, `parseOutput`): Playwright, Vitest, Jest, pytest, k6, ZAP, Appium, plus a JUnit/JSON-summary parser layer and a `RunExecutor` that plans commands without spawning. Adding a framework never touches the execution pipeline. |
| `@the-qa-skill/reporting` | Output rendering for four audiences: JUnit XML writer, Markdown reports (`markdown.ts`), Slack payloads (`slack.ts`), console output, and the deterministic release gate (`verdict.ts` — BLOCKED always wins; FAIL is reserved for humans and never invented by the gate). |
| `@the-qa-skill/agents` | The 8 specialized QA agents (Discovery, Requirements, Risk, Generation, Review, Execution, Triage, Healing), `routeIntent` keyword routing, the `Orchestrator` that walks all 12 lifecycle phases, and a local `computeGate`. Depends on core only; runner spawning is injected (`SpawnFn`/`RunnerAdapter`). Documented in [`docs/agent-model.md`](./agent-model.md). |
| `@the-qa-skill/mcp-server` | A **hand-rolled** MCP server (no MCP SDK dependency): newline-delimited JSON-RPC 2.0 over stdio, processed strictly sequentially; 11 QA tools (`discover_project`, `analyze_risk`, `list_relevant_tests`, `generate_tests`, `run_tests`, `get_failure_evidence`, `triage_failure`, `propose_test_heal`, `analyze_flake`, `generate_quality_report`, `evaluate_release`). Tool errors become `isError: true` results; unexpected errors become `-32603`. Every outgoing payload is deep-scrubbed with `scrubSecrets`. |
| `@the-qa-skill/healing` | **Stub at this stage** (`src/index.ts` exports only `PACKAGE_NAME`). The actual healing engines live in core: `heal/tiers.ts` (HIGH/MEDIUM/LOW tier computation) and `heal/policy.ts` (`canApply`, `applyProposal` with `<file>.pre-heal.bak` backups). The package exists as the future home for healing-specific composition. |
| `@the-qa-skill/cli` | **Stub at this stage** (`src/index.ts` exports only `PACKAGE_NAME`). The 16-command surface (`init discover plan risk generate review test impact triage heal flake coverage release report doctor explain`) is declared in the package description; implementation is the remaining Layer B work item. MCP server + agents are callable today. |

Note on manifests: a few `package.json` files still declare workspace dependencies that
their sources do not import (a scaffold artifact; e.g. `core` lists all packages but its
`src/` imports only `zod`/`picomatch`). The source-level graph above is the real one.

## 3. The 12-phase lifecycle

`packages/core/src/lifecycle.ts` defines the only control flow the platform allows:

```
DISCOVER → MODEL → PLAN → GENERATE → VALIDATE → EXECUTE → OBSERVE →
TRIAGE → HEAL → VERIFY → MEASURE → LEARN
```

### 3.1 The mandatory-phase guard

Six phases may never be skipped under any orchestration policy
(`MANDATORY` set in `LifecycleTracker`):

```
DISCOVER, PLAN, EXECUTE, TRIAGE, VERIFY, MEASURE
```

`LifecycleTracker.skip(phase, reason)` throws for these. Skipping an optional phase
(`MODEL`, `GENERATE`, `VALIDATE`, `OBSERVE`, `HEAL`, `LEARN`) requires a non-empty
`reason` — silent skipping is forbidden; the reason is stored on the `PhaseRecord.note`.

### 3.2 Transitive preconditions

Each phase declares direct preconditions; `unmetPreconditions(phase)` computes the
**transitive closure** — a phase cannot begin until every ancestor in the chain is
`complete`:

| Phase | Direct preconditions |
|---|---|
| `DISCOVER` | — |
| `MODEL` | `DISCOVER` |
| `PLAN` | `MODEL` |
| `GENERATE` | `PLAN` |
| `VALIDATE` | `GENERATE` |
| `EXECUTE` | `VALIDATE` |
| `OBSERVE` | `EXECUTE` |
| `TRIAGE` | `OBSERVE` |
| `HEAL` | `TRIAGE` |
| `VERIFY` | `HEAL` |
| `MEASURE` | `VERIFY` |
| `LEARN` | `MEASURE` |

Because the chain is total, entering `VERIFY` transitively requires all eleven prior
phases to be complete. Violations throw `LifecycleError` with the full ordered list of
unmet phases and the lifecycle line. A phase cannot be restarted after `complete`; only
`active` or `blocked` phases can be completed. `block(phase, reason)` marks a failed
phase, and the orchestrator's recovery pattern (blocked → complete with the error kept
in the note) lets a failing step degrade honestly instead of aborting the walk.

The orchestrator adds one honest wrinkle: the tracker demands `complete` before
dependent phases begin, so a mid-pipeline HEAL with nothing to heal is *completed in the
tracker* but recorded as `skipped` (with the reason) in both the `IntentStep` and the
`lifecycle` records of `PipelineResult`. The tracker remains the precondition guard; the
pipeline record stays truthful.

## 4. The QAContext model

`packages/core/src/context.ts` defines `qaContextSchema` — the shared language every
agent reads and writes. It is Zod-validated on construction (`buildContext`) and on
every load from disk (`parseContext`); validation failures raise
`ContextValidationError` with per-path issues.

| Field | Type / default | Meaning |
|---|---|---|
| `schemaVersion` | literal `1` | Context model version |
| `generatedAt` | ISO string | When the context was built |
| `root` | string | Repository root the context describes |
| `application` | `{ type, framework?, language }` | Derived from `StackInfo` by `DiscoveryAgent` (`web-app` / `monorepo` / `library` / `unknown`) |
| `risk?` | `{ overall 0..100, tier, areas[], assessment? }` | Attached immutably by `withRisk()`; `areas` = distinct areas of `changedFiles` |
| `requirements[]` | `{ id, title, criteria[], source?, priority: must/should/could, status: draft/agreed/implemented/verified }` | Extracted from markdown specs (defaults: `criteria: []`, `priority: 'should'`, `status: 'draft'`) |
| `changedFiles[]` | `{ path, status: added/modified/deleted/renamed, additions, deletions, area, language, symbols[] }` | Output of `analyzeDiff` |
| `affectedFeatures[]` | string[] | Attached by `withSelection()` from the first word of each selection reason |
| `existingTests[]` | `{ testId, name, filePath, layer, framework, covers[], avgDurationMs?, flakeScore? }` | From discovery inventory; `layer` ∈ the 10 `TestLayer` values |
| `coverage?` | `{ weightedCoverage?, fileCoverage?, gaps[] }` | From `analyzeCoverage` |
| `knownFlakes[]` | `{ testId, score }[]` | Empty by default; attached by callers with flake history |
| `knownDefects[]` | `{ id, title, paths[], status: open/fixed/regressed, severity: blocker/critical/major/minor }` | Tracked defect backdrop |
| `environments[]` | `{ name, kind: local/ci/staging/production, baseUrl?, reachable, notes? }` | Execution targets |
| `dependencies[]` | `{ name, version, kind: runtime/dev/peer }[]` | Dependency context |
| `testData` | `{ strategy: factories/fixtures/inline/recorded/none, seeds[], maskedFields[] }` | Defaults to `{ strategy: 'none', seeds: [], maskedFields: [] }` |
| `qualityGates` | `{ minWeightedCoverage: 60, maxCriticalFlakes: 0, blockOnRealRegression: true, maxUnknownTriage: 2 }` | Defaults shown; consumed by the release gate |
| `provenance` | `{ discovery: 'unknown', commit?, branch?, range? }` | How/where this context was built (commit/branch honestly `undefined` outside a git repo) |
| `extensions` | `Record<string, unknown>` | Validated as a JSON object; consumers own their keys (e.g. `selection` is stored here by `withSelection`) |

## 5. The deterministic-first pipeline

The pipeline order is fixed: **parsers → analyzers → matchers → (optionally) a model**.
AI is a last resort, never a default, and every AI conclusion must carry the same
explainability envelope as a heuristic one.

| Stage | What happens | Where it lives |
|---|---|---|
| Parser | `git diff --name-status` + `--numstat` + `--unified=0` → `DiffParseResult {files, addedLines, removedLines, range}` with area/language/symbol extraction | `packages/core/src/impact/diff.ts` (`analyzeDiff`) |
| Analyzer | 8-factor risk scoring; 17-dimension test quality; 12-category triage; flake scoring; coverage | `packages/core/src/risk/*`, `quality/*`, `triage/*`, `flake/*`, `coverage/analyze.ts` |
| Matcher | Changed files × test inventory → smallest high-confidence selection with per-test reasons and routing hints | `packages/core/src/impact/select.ts` (`selectTests`, `computeCoverage`) |
| Optional AI | `ReasoningProvider.classify/analyze/generate` — only for genuinely open questions; `DeterministicProvider` answers structurally with `fallbackUsed: true`, confidence ≤ 0.85 | `packages/reasoning/src/*` |

Two rules make "deterministic-first" more than a slogan:

1. **Registries never fail open.** `ProviderRegistry.resolve(preferred)` returns the
   preferred provider only when registered *and* `isConfigured()`; otherwise it falls
   back to the deterministic provider — recording the fallback inside the conclusion
   (`fallbackUsed: true`), not in a log line nobody reads.
2. **Every verdict is explainable.** All engines return `ExplainableConclusion`-shaped
   output or concrete reason arrays (`RiskFactorValue.reasons`, `QualityDeduction`,
   `TriageSignal` with `supports`/`contradicts` polarity, `SelectedTest.reasons`).
   Every derived product carries a `VerificationLabel` (`NOT_VERIFIED` → `NOT_RUN` →
   `INFERRED` → `OBSERVED` → `CONFIRMED`).

## 6. Data flow of a PR review, end to end

```
intent text ("review this PR")
   │
   ▼
routeIntent(intentText)                    packages/agents/src/route-intent.ts
   │  first-match-wins keyword table → kind 'pr_review', 12 planned steps, rationale
   ▼
Orchestrator.runIntent(intentText, opts)   packages/agents/src/orchestrator.ts
   │  HIGH_RISK gate: /production|prod-(smoke|test|suite|run)/ requires confirmRisk
   │  (assertAuthorized('test.production') — throws without --confirm-risk)
   ▼
12 × runPhase(phase, action, work)          LifecycleTracker guards each begin()
   │
   ├─ DISCOVER  DiscoveryAgent.discover() → DiscoveryResult; provenance commit/branch
   ├─ MODEL     RequirementsAgent.extract() (README + docs/** + requirements/*.md,
   │            cap 20 files); DiscoveryAgent.buildContext() → validated QAContext
   ├─ PLAN      RiskAgent.assess(range) → analyzeDiff + churnHotspots +
   │            classifyRouting + assessRisk  → AssessResult;
   │            selectTests(changedFiles, inventory, routing, {alwaysInclude,
   │            maxPrE2E, policy}) → SelectionResult
   ├─ GENERATE  'pr_review': coverage-gap check (verified no-op when selection covers
   │            the change set or the change is docs/test-only)
   ├─ VALIDATE  quality review of changed test files (ReviewAgent → analyzeTestFile)
   ├─ EXECUTE   ExecutionAgent.execute(selection, {policy, dryRun}) — read-only
   │            intents ('discover', 'explain') force dryRun; dryRun plans commands
   │            and spawns nothing
   ├─ OBSERVE   failed/timedout events counted; evidence bundles were written at
   │            execution time for failures
   ├─ TRIAGE    TriageAgent.triage(records, {relevantChangedFiles}) → 12-category
   │            TriageResult[]; TriageAgent.clusters() → signature clusters
   ├─ HEAL      verified no-op without observed selector evidence (documented reason)
   ├─ VERIFY    computeGate({riskAssessments, triageResults, failedRealRegressions,
   │            openUnknownCategories, evidenceComplete, …}) → ReleaseGateResult
   ├─ MEASURE   risk / selected / events / triaged / gate aggregated into the note
   └─ LEARN     triage already appended 'failure' records to the LearningStore
                (JSONL); the phase records that fact or is skipped with a reason
   ▼
PipelineResult {intent, plan: IntentStep[], lifecycle: PhaseRecord[], risk?,
                selection?, plan2?, quality?, triage?, clusters?, gate?,
                events?, label: strongestLabel(...)}
```

A failing phase never aborts the walk: `runPhase` marks the tracker `blocked`, then
completes it with the error in the note, and the `IntentStep` carries `status:
'blocked'` with the message. Downstream phases degrade honestly (e.g. an empty triage
input yields "no failures to triage", never invented results).

## 7. Design decisions and rationale

**Why a hand-rolled MCP server.** `packages/mcp-server` implements JSON-RPC 2.0 itself
(`rpc.ts` — `isRequest`, `parseMessage`, `renderResponse`, `renderError`) over
newline-delimited stdio instead of importing an MCP SDK. The reasoning is dependency
discipline and inspectability: the protocol surface is small (initialize handshake,
tools/list, tools/call), the whole transport is ~300 lines that a reviewer can read in
one sitting, and the security-sensitive property — deep `scrubSecrets` on every outgoing
payload, keys never in bodies/logs — is enforced in code we own. Responses are written
strictly in request order and a failing tool can never crash the loop.

**Why regex static analysis.** The quality engine (`quality/score.ts`) and symbol
extraction (`impact/diff.ts`) are regex-based by design: deterministic, auditable,
zero-dependency, and honest. A regex that flags `waitForTimeout` is exactly reproducible;
an AST heuristic is not obviously better and is much harder to audit. The cost — the
analyzer only sees what is literally in the source — is paid for with the `INFERRED`
label on every `TestQualityReport` and a documented "what it cannot see" list
([`docs/quality-model.md`](./quality-model.md)).

**Why a JSONL learning store.** `LearningStore` (`core/learning/store.ts`) is
append-only JSONL: `append()` writes one `LearningRecord` (`lr-<sha10>` id, timestamp,
type, tags, payload, explicit `effect` string) per line; malformed lines are skipped on
read, never rewritten. There is no database and no silent behavior mutation — consumers
read aggregates (`failureDensityByPath()`, `rejectedHealingsFor(testId)`, `summarize()`).
Append-only JSONL is diffable in code review, trivially portable across CI runners, and
consistent with golden rule 13 (preserve evidence): nothing mutates history.

**Why tier floors in addition to a score.** A weighted average can undershoot what a
change *is* (a two-line payment edit scores small on churn). `assessRisk` therefore
imposes minimum tiers from factor values — see
[`docs/risk-engine.md`](./risk-engine.md#5-tier-floors).

**Why agents never import runners.** See
[`docs/agent-model.md`](./agent-model.md#5-the-runneradapter--spawnfn-dependency-inversion):
runner spawning is injected, so `@the-qa-skill/agents` stays testable and the
production-grade parser suite in `@the-qa-skill/runners` stays optional.

## 8. Extension points

| Point | Mechanism | Where |
|---|---|---|
| Project configuration | `theqa.config.json` (Zod-validated, unknown keys rejected; bounded 12-level upward search) | `core/config.ts` — `loadConfig`, `renderDefaultConfig` |
| Risk calibration | `risk.weights` (8 values, each 0..1, renormalized) and `risk.thresholds` (`critical/high/medium`) | `core/config.ts`, `core/risk/engine.ts` |
| Selection policy | `selection.alwaysInclude` path patterns, `selection.maxPrE2E`, `policy` mode | `core/impact/select.ts` (`SelectOptions`) |
| Import resolution | `pathAliases: {prefix, target}[]` passed to `computeCoverage` | `core/impact/select.ts` |
| Runner injection | `SpawnFn` / `RunnerAdapter` constructor options | `agents/src/agents/execution.ts` |
| Reasoning models | `ProviderRegistry.register(provider)`; `integrations.reasoningProvider` ∈ `deterministic | openai | anthropic | gemini | local` | `reasoning/src/registry.ts` |
| Context extensions | `QAContext.extensions` record (consumers own their keys) | `core/context.ts` |
| Action authorization | New actions registered in `ACTION_POLICIES`; unregistered read-shaped verbs default `READ_ONLY`, everything else `HIGH_RISK` | `core/policies.ts` (`classifyAction`) |
| Quality Graph | `addNode` (idempotent by id), `addEdge` (auto-creates endpoints), `save`/`load` payloads | `graph/src/graph.ts` |
| Learning consumers | `LearningStore.query({type, tags, limit})` over append-only records | `core/learning/store.ts` |

## Verification

Reviewers can check each claim against source:

- [ ] `skills/` contains 26 `SKILL.md` files, each with the 13 mandated sections and an Output Contract section (`find skills -name SKILL.md | wc -l`).
- [ ] `packages/` contains exactly 10 packages; `cli` and `healing` `src/index.ts` are two-line stubs exporting `PACKAGE_NAME`.
- [ ] `core/src` imports no `@the-qa-skill/*` module (grep `from '@the-qa-skill/` over `packages/core/src` → only the doc comment in `index.ts`); `mcp-server` is the only package importing `@the-qa-skill/agents` (type-only `FeatureSpec`).
- [ ] `core/src/lifecycle.ts`: `MANDATORY` set is exactly `DISCOVER, PLAN, EXECUTE, TRIAGE, VERIFY, MEASURE`; `PRECONDITIONS` forms the total chain; `skip()` requires a reason and throws for mandatory phases; `unmetPreconditions` walks transitively and returns phases in lifecycle order.
- [ ] `core/src/context.ts`: field table matches `qaContextSchema` (defaults: `qualityGates` 60/0/true/2, `provenance.discovery: 'unknown'`, `extensions: {}`); `withRisk`/`withSelection` are immutable spreads.
- [ ] `mcp-server/src/tools.ts` lists exactly the 11 tool names quoted above; `server.ts` implements sequential newline-delimited JSON-RPC with `scrubDeep` on payloads.
- [ ] `agents/src/orchestrator.ts`: production-intent regex + `assertAuthorized('test.production', …)`; HEAL verified no-op documented in the module header; error path is `block` → `complete` with the message in the note.
- [ ] `reasoning/src/registry.ts`: `resolve()` never throws and falls back to `DeterministicProvider`, whose conclusions set `fallbackUsed: true` (see `deterministic.ts`).
- [ ] The sponsor line appears in the header blockquote of this document only.
