# Agent Model — The-QA-Skill

> Sponsored by xShredo.dev → https://xshredo.com/promo/anytest

**Audience:** contributors and agent authors. This document describes the 8 specialized
QA agents and the `Orchestrator` in `packages/agents` exactly as implemented. All types
come from `@the-qa-skill/core` unless marked as agents-local (`packages/agents/src/types.ts`).

---

## 1. Overview

`packages/agents` is the orchestration layer between intent text and the deterministic
core engines. It contains:

- 8 agents in `src/agents/` — Discovery, Requirements, Risk, Generation, Review,
  Execution, Triage, Healing;
- `routeIntent` (`src/route-intent.ts`) — keyword routing to 8 intent kinds;
- `Orchestrator` (`src/orchestrator.ts`) — walks all 12 lifecycle phases per intent;
- `computeGate` (`src/gate.ts`) — local release-gate computation.

Dependency rule: **agents depend on `@the-qa-skill/core` only.** Runner spawning is
injected (§5); the release gate is computed locally (§6) because the canonical gate
lives in `@the-qa-skill/reporting`, which this package must not import.

## 2. The agents

Every agent wraps core engines; none re-implements engine logic. "Failure behavior"
describes what happens when inputs are missing, unreadable, or wrong.

### 2.1 DiscoveryAgent — the eyes of the platform

| | |
|---|---|
| Responsibility | Run core stack detection + test inventory; turn the result into a Zod-validated `QAContext`; capture provenance (commit/branch) for downstream conclusions |
| Wraps | `discover(root)`, `currentCommit(root)`, `currentBranch(root)`, `buildContext(input)` |
| Inputs | repo `root`; optional `config?: TheQAConfig` |
| Outputs | `discover(): Promise<DiscoveryResult>` — `{root, stack: StackInfo, testFiles: DiscoveredTestFile[], sourceFiles, configFiles, label}`; `buildContext(discovery): QAContext` |
| Failure behavior | Provenance commit/branch are honestly `undefined` outside a git repo (the agent does not fabricate them). `application.type` is derived deterministically: detected framework → `web-app`, `stack.monorepo` → `monorepo`, known language → `library`, else `unknown`. `knownFlakes` starts empty — flake history is attached only by callers that actually have it. |
| Constructor | `constructor(root: string, opts: { config?: TheQAConfig } = {})` |

### 2.2 RequirementsAgent — extraction, never invention

| | |
|---|---|
| Responsibility | Extract testable requirements from markdown specs |
| Wraps | `listFiles(root)` (core); parsing is agents-local (`parseMarkdownSpec`, `slugify`) |
| Inputs | repo `root`; optional explicit `paths?: string[]` (absolute or root-relative). Default scan set: `README.md`, `docs/**/*.md`, `requirements/*.md`, capped at 20 files, sorted |
| Outputs | `extract(paths?): Requirement[]` — `{id: 'REQ-<slugified-title>-<index>', title, criteria[], source, priority, status: 'draft'}`; `priority` is `must` when the text contains `\bmust\b`, else `should` |
| Failure behavior | Non-existent/unreadable files are skipped; files > 5000 lines are skipped (documents, not specs); fenced code blocks are ignored (a `#` inside a fence is not a heading); when nothing is found the agent returns an honest empty array. Deterministic: identical inputs → identical ids in global 1-based traversal order. |
| Constructor | `constructor(root: string)` |

### 2.3 RiskAgent — the core risk engine with real inputs

| | |
|---|---|
| Responsibility | Produce the change-set risk assessment and the routing classification |
| Wraps | `analyzeDiff(root, range)`, `churnHotspots(root)` (defect-history proxy), `classifyRouting(files)`, `assessRisk(input, {weights, thresholds})` |
| Inputs | repo `root`; diff `range` (e.g. `'HEAD~1'`, `'main...HEAD'`) |
| Outputs | `assess(range): Promise<AssessResult>` — `{assessment: RiskAssessment, changedFiles: ChangedFile[], routing: ChangeRouting, label}` |
| Failure behavior | `modulesTouched` is computed as distinct containing directories of changed source files (test-shaped files excluded; root-level files count as one `'(root)'` module). A partially specified injected config is normalized section-wise against core `DEFAULT_CONFIG`, so `config.risk.weights` can never be `undefined`. The returned label is the assessment's own (`'INFERRED'`). |
| Constructor | `constructor(root: string, opts: { config?: Partial<TheQAConfig> } = {})` |

### 2.4 GenerationAgent — deterministic test design

| | |
|---|---|
| Responsibility | Enumerate designed cases from a `FeatureSpec` and scaffold intentionally-skipped test files |
| Wraps | Core is not imported for design logic — the pipeline is agents-local by design (10 `TestCaseCategory` heuristics); `slugify` is reused from `requirements.ts` |
| Inputs | `plan(spec: FeatureSpec): TestPlan` where `FeatureSpec = {name, description?, acceptanceCriteria[], businessRules?, area?}`; `scaffold(plan: TestPlan, outDir: string, opts: {dryRun?, force?}): ScaffoldResult[]` |
| Outputs | `TestPlan = {feature, cases: TestCase[], summary: {total, byCategory, byLayer}, heuristicNotes[], label: 'INFERRED'}`; `ScaffoldResult = {path, action: 'created'|'skipped'|'dry-run', bytes}` |
| Failure behavior | Zero acceptance criteria → honest empty plan (recorded in `heuristicNotes`), not invented cases. Scaffolds are `it.skip`/`test.skip` — recorded test debt whose names encode the Given/When/Then contract. Existing files are never overwritten without `force`; `dryRun` records would-be bytes without touching the disk. Priority table: security cases and payment-area specs → `critical`; negative/boundary/concurrency/integration/resilience → `high`; positive/state/accessibility/time → `medium`. |
| Constructor | `constructor(root: string, opts: { config?: TheQAConfig } = {})` |

### 2.5 ReviewAgent — static quality review

| | |
|---|---|
| Responsibility | Run the core 17-dimension quality engine over test-shaped files |
| Wraps | `analyzeTestFile(filePath, source)`, `listFiles(root)` |
| Inputs | repo `root`; optional explicit `paths?: string[]`. Default discovery: `*.test.*` / `*.spec.*` at any depth plus anything inside `__tests__/` (`isTestShaped`) |
| Outputs | `review(paths?): Promise<TestQualityReport[]>` — `{filePath, score 0..100, testCount, deductions[], strengths[], label: 'INFERRED'}` |
| Failure behavior | Unreadable files are skipped honestly — a file that cannot be read cannot be reviewed; nothing is scored from imagination. |
| Constructor | `constructor(root: string)` |

### 2.6 ExecutionAgent — runs tests through an injected adapter

| | |
|---|---|
| Responsibility | Execute the selection under a policy; map results onto core `TestEvent`s; write evidence bundles for failures |
| Wraps | `runIdFor('run')`, `writeEvidenceBundle(root, {event, consoleLog})`, `loadConfig` |
| Inputs | `execute(selection: SelectionResult | null, opts: {policy: 'pr'|'pre_merge'|'nightly'|'release'|'post_deploy', dryRun: boolean, environment?: string}): Promise<ExecutionOutcome>`; `selection === null` means "plan every detected runner with no file filtering" |
| Outputs | `ExecutionOutcome = {runId, events: TestEvent[], dryRun, plannedCommands: {runner, command, args}[], bundles: {testId, path}[]}` |
| Failure behavior | `dryRun` → planned commands only, zero events, nothing spawned. Real runs: 600000 ms timeout per command (`builtinSpawn` kills with SIGKILL; timeout exit code 124; spawn error → code 127). Unparseable runner output yields zero events — but a non-zero exit with zero parsed events **synthesizes one suite-level failure event** (`<runner>:suite`): failures are never silent. Failures without a parser-produced message get the stderr tail (2000 chars). Evidence writes are best-effort and can never fail the run. Unknown runner statuses map to `'not_run'`, never invented passes. Policy is threaded into `buildArgs` as the documented hook point — no fake flags are appended today. |
| Constructor | `constructor(root: string, opts: { config?: TheQAConfig; spawner?: SpawnFn; adapter?: RunnerAdapter } = {})` |

### 2.7 TriageAgent — evidence-driven classification

| | |
|---|---|
| Responsibility | Classify failures through the core 12-category decision table; cluster by normalized signature; feed the learning loop |
| Wraps | `classifyFailure(record, ctx)`, `clusterFailures(raw, {threshold? = 0.6})`, `detectSelectorChange(testSource, diffText)` |
| Inputs | `triage(failures: FailedTestRecord[], ctx: TriageAgentContext = {}): TriageResult[]`; `clusters(failures): SimpleCluster[]`. `TriageAgentContext = Partial<TriageContext> & {diffText?: string}` |
| Outputs | `TriageResult = {testId, category, confidence, rootCauseHypothesis, signals[], contradictingSignals[], recommendedAction, evidence[], label}`; label is `'OBSERVED'` when `confidence >= 0.8`, else `'INFERRED'` (core rule) |
| Failure behavior | The agent *derives* missing context rather than assuming it: `relevantChangedFiles` = the failure's `changedFiles` ∩ orchestrator-provided changed files; `coversChangedCode` is true exactly when that intersection is non-empty (never assumed true); `selectorChangedInDiff` is derived by reading the test file and running `detectSelectorChange` against the optional `diffText` — `false` when the file or diff is absent. When a `LearningStore` is present, every outcome is appended as a `'failure'` record with an explicit `effect` string. |
| Constructor | `constructor(root: string, opts: { learning?: LearningStore } = {})` |

### 2.8 HealingAgent — propose/apply under the golden rules

| | |
|---|---|
| Responsibility | Build healing proposals through the core tier engine; apply only policy-clean proposals; record every decision |
| Wraps | `buildProposal(candidate)` (core `heal/tiers.ts`), `applyProposal(proposal, root, {confirmRisk?})` (core `heal/policy.ts`) |
| Inputs | `propose(candidate: HealCandidate): HealingProposal`; `apply(proposal: HealingProposal, opts?: {confirmRisk?}): ApplyResult` |
| Outputs | `HealingProposal = {id, testId, filePath, kind, description, currentCode, proposedCode, tier, confidence, evidence[], rationale, policyChecks[], violations[]}`; `ApplyResult = {applied, reason, backupPath?}` |
| Failure behavior | Tiers are honest: HIGH = pure selector repair observed in a DOM snapshot with untouched assertions; MEDIUM = intent-preserving structural change needing review; LOW = explain only. `apply` never throws for policy rejections — the `ApplyResult` carries the reason; backups land at `<file>.pre-heal.bak` (golden rule 13). Outcomes are recorded as `healing_applied` / `healing_rejected` learning records when a store is present. |
| Constructor | `constructor(root: string, opts: { learning?: LearningStore; confirmRisk?: boolean } = {})` |

### 2.9 Orchestrator — the lifecycle walker

| | |
|---|---|
| Responsibility | Route the intent, walk all 12 phases under `LifecycleTracker` guards, aggregate a `PipelineResult` |
| Wraps | All 8 agents; `LifecycleTracker`, `selectTests`, `assertAuthorized`, `strongestLabel`, `LearningStore`/`defaultLearningPath`, `loadConfig` |
| Inputs | `runIntent(intentText: string, opts?: RunOptions): Promise<PipelineResult>` with `RunOptions = {policy?, range? (default 'HEAD~1'), dryRun?, confirmRisk?, json?}` |
| Outputs | `PipelineResult = {intent, plan: IntentStep[], lifecycle: PhaseRecord[], risk?, selection?, plan2?, quality?, triage?, clusters?, gate?, events?, label}` — `label` is `strongestLabel` over every product's label plus execution honesty (`OBSERVED` when events exist, `NOT_RUN` for dry-run, else `NOT_VERIFIED`) |
| Failure behavior | A failing phase never aborts the walk: tracker `block(phase, message)` → `complete`, `IntentStep.status = 'blocked'` with the message. First-commit repos (no `HEAD~1`) fall back to the well-known empty-tree id `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. Production-flavored intents throw via `assertAuthorized('test.production')` unless `confirmRisk: true`. Read-only kinds (`discover`, `explain`) force execution into dry-run. Mid-pipeline HEAL without observed selector evidence is a **verified no-op**: the tracker records `complete` (VERIFY depends on it) while the step and lifecycle record honestly say `skipped` with the reason. |
| Constructor | `constructor(root: string, opts: { config?: TheQAConfig; spawner?: SpawnFn; logger?: Logger } = {})` |

## 3. Intent routing (`routeIntent`)

`routeIntent(intentText: string): IntentPlan` classifies free text into one of eight
`IntentKind`s. Classification is keyword-based and **first match wins** in the documented
order below; unknown intents default to `explain` — a read-only pipeline — so a vague
request can never trigger execution. The heal rule precedes the triage rule so that
"heal failures" reaches the healing pipeline instead of being captured by the triage
`\bfailures?\b` keyword.

| Order | Kind | Pattern (regex, case-insensitive) | Matches on |
|---|---|---|---|
| 1 | `pr_review` | `/\b(?:this\s+)?pr\b\|\bpull\s+request\b\|\breview\b/i` | "review this PR", "pull request" |
| 2 | `nightly` | `/\bnightly\b/i` | "run the nightly" |
| 3 | `release` | `/\brelease\b\|\bship\b/i` | "release check", "can we ship" |
| 4 | `generate` | `/\bgenerate\b\|\bscaffold\b/i` | "generate tests for checkout" |
| 5 | `heal` | `/\bheal(?:ing\|ed)?\b/i` | "heal failures", "fix flaky selectors" (healing) |
| 6 | `triage` | `/\btriage\b\|\bfailures?\b/i` | "triage the failures" |
| 7 | `discover` | `/\bdiscover(?:y)?\b/i` | "discover the test suite" |
| — | `explain` | *(default — no rule matched)* | anything else; read-only, no execution |

The returned `IntentPlan = {kind, steps: IntentStep[], rationale}` plans **all 12
lifecycle phases for every kind** — the tracker's precondition chain makes partial walks
impossible, so each kind carries a per-phase action string tailored to the pipeline
(e.g. `generate`'s EXECUTE is "run the existing suite to prove scaffolds break nothing";
`discover`'s EXECUTE is "read-only intent: plan commands without spawning (dry-run)").
The `rationale` records which keyword table fired (or the defaulting), making routing
auditable. Identical text always yields an identical plan.

Default policy per kind (`defaultPolicyFor`): `nightly` → `'nightly'`, `release` →
`'release'`, everything else → `'pr'`.

## 4. Phase walk contract

Every phase is executed through one helper (`runPhase`) which enforces:

1. `tracker.begin(phase)` — throws `LifecycleError` on unmet (transitive) preconditions.
2. The phase's work returns `PhaseWork = {note?, skipReason?, stepSkipped?}`:
   - `skipReason` → `tracker.skip(phase, reason)` (legally skippable tail phases only,
     e.g. LEARN with no lessons) and `IntentStep.status = 'skipped'`;
   - `stepSkipped` → the tracker records `complete` (downstream preconditions depend on
     it) while the lifecycle record and step honestly report `skipped` with the note;
   - otherwise the tracker records `complete` and the note is attached to the step.
3. On throw: `tracker.block(phase, message)` → `tracker.complete(phase)`; the lifecycle
   record is pushed with `status: 'blocked'` and the note; the step carries the message.
   Downstream handlers degrade honestly instead of throwing.

## 5. The RunnerAdapter / SpawnFn dependency inversion

`packages/agents` never imports `@the-qa-skill/runners`. Execution is inverted through
two seams defined in `src/agents/execution.ts`:

```ts
export type SpawnFn = (
  command: string,
  args: string[],
  ctx: { cwd: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface RunnerAdapter {
  frameworksAt(root: string): string[];
  run(runner: string, command: string, args: string[], cwd: string, timeoutMs: number):
    Promise<{ stdout: string; stderr: string; code: number }>;
  parse(runner: string, raw: string): TestEvent[];
}
```

Why:

1. **Build isolation.** `agents` was built in parallel with `runners`; a hard import
   would have coupled two independently verified packages. Depending on core only keeps
   the dependency graph acyclic and the public surface testable in isolation.
2. **Substitutability.** `DefaultRunnerAdapter` ships *inside* the agents package as a
   self-contained minimal adapter (framework detection from `package.json` deps:
   vitest, jest, playwright (`@playwright/test`), cypress, mocha; `npx`-based command
   building; best-effort JSON extraction from stdout — first `{` to last `}`, flattened
   over `events`/`tests`/`testResults`/`assertionResults` shapes). Callers wanting the
   production-grade parsers inject their own `RunnerAdapter` via the constructor's
   `adapter` option (or a raw `spawner`). The contract is documented, not guessed:
   `run` must respect the timeout and resolve (not throw) with an exit code.
3. **Testability.** Every provider/runner test injects its spawn function — zero real
   network or child processes in the unit suites.

`Orchestrator` propagates this: its constructor accepts `opts.spawner?: SpawnFn` and
passes it to `ExecutionAgent`.

## 6. `computeGate` — the local release gate

The canonical gate lives in `@the-qa-skill/reporting` (`verdict.ts`). `packages/agents`
must not import reporting, so `src/gate.ts` implements the same documented decision
table locally for pipeline VERIFY steps:

| # | Condition | Verdict effect |
|---|---|---|
| 1 | No inputs at all (nothing assessed, executed, or triaged) | `UNKNOWN` (label `NOT_VERIFIED`) — a gate with no data is never PASS |
| 2 | `failedRealRegressions > 0` | `BLOCKED` — blocking finding names the count |
| 3 | Nothing executed and nothing triaged (no execution evidence) | `UNKNOWN` with reason "no execution evidence: nothing was run and nothing was triaged, so the gate cannot be verified" |
| 4 | `openUnknownCategories > 2` | warning (recorded, non-blocking) |
| 5 | `criticalFlakeCount > 0` | warning |
| 6 | `coverage.weightedCoverage < 60` | warning |
| 7 | Any warning, or `evidenceComplete === false` | PASS downgraded to `PASS_WITH_WARNINGS` (incomplete evidence is itself pushed as a warning) |

Label logic: `verdict === 'UNKNOWN'` → `NOT_VERIFIED`; otherwise `evidenceComplete` →
`OBSERVED`, else `INFERRED`. An unverifiable gate verifies nothing.

## 7. `detectPrimaryCascade` — heuristic and its honesty limits

```ts
export function detectPrimaryCascade(
  clusters: SimpleCluster[],
  failures: FailedTestRecord[],
): { primaryIds: string[]; cascadeIds: string[] }
```

The heuristic (in `src/agents/triage.ts`):

- **PRIMARY**: a cluster whose representative error (signature or `representative.errorType`)
  matches `DEPENDENCY_ENV_RE`
  (`ECONNREFUSED | ENOTFOUND | ECONNRESET | EAI_AGAIN | ETIMEDOUT | getaddrinfo |
  connection refused | dial tcp | Cannot find module | Module not found |
  ERR_MODULE_NOT_FOUND | 50[23] (service unavailable|bad gateway)`)
  **AND** at least two *other* clusters share the representative's environment with
  start times within ±5 minutes (`CASCADE_WINDOW_MS = 5 * 60 * 1000`) of the primary's
  earliest failure.
- **CASCADE**: any non-primary cluster in the same environment that started after a
  primary within the 5-minute window.

Per-cluster metadata (`env`, `t0`) comes from the failed/timedout attempts of the
cluster's member failures; failures without a parseable timestamp or attempts are
excluded from the window math (their `t0` is `NaN`).

**Honesty limits, stated in the code on purpose:** same-environment + tight timing is
*correlation, not proven causation*. The output exists to focus human investigation —
it is a ranking hint, never a verdict, and nothing downstream treats `cascadeIds` as
safe to ignore. Local-only clusters (neither primary nor cascade) are simply not
classified.

## Verification

- [ ] Each constructor signature above matches the class declaration in `packages/agents/src/agents/*.ts` / `orchestrator.ts`.
- [ ] `route-intent.ts`: `KIND_RULES` order and patterns match the table in §3; `heal` precedes `triage`; no match → `'explain'`; `STEP_ACTIONS` plans 12 phases for all 8 kinds.
- [ ] `orchestrator.ts`: production regex → `assertAuthorized('test.production', {confirmRisk})`; `DEFAULT_RANGE = 'HEAD~1'`; `EMPTY_TREE` fallback; `strongestLabel` aggregation includes the execution-honesty label.
- [ ] `execution.ts`: `SpawnFn`/`RunnerAdapter` shapes match §5; `EXECUTION_TIMEOUT_MS = 600_000`, `TIMEOUT_EXIT_CODE = 124`, `STDERR_TAIL_CHARS = 2000`; non-zero exit with zero parsed events synthesizes a `<runner>:suite` failure; `mapStatus` maps unknown statuses to `'not_run'`.
- [ ] `gate.ts`: decision table matches §6; `label` is `NOT_VERIFIED` for UNKNOWN, else `OBSERVED` only when `evidenceComplete`, else `INFERRED`; the header comment states reporting is not imported.
- [ ] `triage.ts`: `CASCADE_WINDOW_MS = 5 * 60 * 1000`; primary requires `dependencyLike` AND ≥ 2 other same-env clusters within the window; cascade requires same-env and start after a primary within the window.
- [ ] `packages/agents/src` contains no import of `@the-qa-skill/runners`, `@the-qa-skill/reporting`, `@the-qa-skill/healing`, or `@the-qa-skill/mcp-server`.
- [ ] The sponsor line appears in the header blockquote of this document only.
