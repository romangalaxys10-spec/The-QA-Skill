---
name: qa-discovery
description: Inventories a repository with the deterministic discovery engine — stack signals, test inventory, config files, CI systems, and monorepo shape — before any QA decision is made. Activate at the start of every engagement, when the repo state is unknown, or when a previous discovery may be stale.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa discover --json"
  mcp: "discover_project(root?)"
  agent: "DiscoveryAgent.discover() / DiscoveryAgent.buildContext()"
  core: "discover(root) / detectStack(root) / inventoryTests(root, files?) / listFiles(root, {maxFiles})"
---

# QA Discovery

## Purpose

Discovery is the eyes of the platform: `detectStack` reads file-presence signals (package.json, tsconfig, pytest.ini, go.mod, CI manifests), `inventoryTests` matches test files against documented framework patterns, and `discover()` bundles stack + test/source/config listings into a `DiscoveryResult` labeled `OBSERVED` — every claim in it traces to a file that exists on disk. This skill tells the agent what to inventory, when the result is sufficient, and what to do when the honest answer is "this repo has zero tests". Discovery never guesses: a signal that is absent is reported as absent, and a repo with no test framework is a coverage-gap story, never an invented suite.

## When to activate

- First contact with any repository — before MODEL, PLAN, or any risk/selection claim (DISCOVER is a mandatory lifecycle phase).
- After `qa init` or scaffolding changes: new config files change what discovery reports.
- When downstream skills disagree with reality (selection selected a deleted test → re-discover).
- Provenance is stale: `provenance.commit` in `.theqa/context.json` differs from the current HEAD.
- A monorepo boundary is unclear (workspace detection changes which root to operate on).
- An agent handoff needs the validated `QAContext` that only `DiscoveryAgent.buildContext` can produce.
- Post-incident audits: what did the inventory actually say before the escape — discovery output is the baseline every hindsight claim is checked against.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `root` | CLI arg / MCP `root` | no | Project root; defaults to the server/cwd root. |
| File tree | `listFiles(root)` | yes | Normalized relative POSIX paths; ignored dirs (`node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `coverage`, `.theqa`, `vendor`, …) are never walked; hard cap `maxFiles` 20,000. |
| `package.json` | repo root | no | Framework priority next → react → express; test frameworks detected from deps: `@playwright/test`, `vitest`, `jest`, `cypress`, `mocha`; `packageManager` field parsed. Unparseable → signal `package.json unparseable`, not a crash. |
| Language markers | file presence | no | `tsconfig.json`; `requirements.txt`/`pyproject.toml` (python); `go.mod`; `Cargo.toml`; `pom.xml` (java + junit); `k6.config.js`/`k6-script.js`. |
| CI markers | file presence | no | `.github/workflows` → github-actions; `.gitlab-ci.yml`; `Jenkinsfile`; `azure-pipelines.yml`. |
| Result shape | engine output | — | `DiscoveryResult { root, stack: StackInfo, testFiles: DiscoveredTestFile[], sourceFiles, configFiles, label: 'OBSERVED' }`; `DiscoveredTestFile { filePath, framework, layer, estimatedCases }`. |

## Preconditions

- The target directory exists and is readable; unreadable directories are skipped by the walker (best-effort by design) — the agent must say when that happened, not assume emptiness.
- Lifecycle: this skill OWNS `DISCOVER`. It runs before everything; every downstream skill consumes its output. It may be re-run any time the repo changed, but its result must be attached to the context (`.theqa/context.json` via `DiscoveryAgent.buildContext`) before MODEL begins.
- No writes: discovery is `READ_ONLY` (`ACTION_POLICIES: 'discover'`).

## Decision rules

1. IF `package.json` exists, THEN language is `typescript` with signals recorded per dependency; IF it also declares `workspaces` (array), or `pnpm-workspace.yaml` or `turbo.json` exists, THEN `stack.monorepo = true` and application type maps framework → `web-app`, else monorepo → `monorepo`, known language → `library`, else `unknown`.
2. IF a test file matches multiple framework patterns (e.g. `**/*.spec.ts` is both playwright-e2e and vitest), THEN the FIRST pattern in table order wins and the file is NOT double-counted — inventoryTests dedupes per file.
3. IF `estimatedCases` is 0 for a discovered test file (no `test(`/`it(`, `def test_`, `void test` matches), THEN keep the file in the inventory but flag it: an empty test file is debt, and the review skill should see it before anyone counts it as protection.
4. IF zero test files are found, THEN report the honest coverage-gap story: language, source-file count, config files, and the sentence "no test framework detected" — NEVER fabricate a test suite, a framework, or numbers (golden rule 4). Route to `qa-requirements` + `qa-test-generation` for a real plan.
5. IF the file count hits the 20,000 `maxFiles` cap, THEN state that the walk was truncated: inventory numbers are lower bounds, and a monorepo should be discovered per workspace root instead of one giant walk.
6. IF CI markers are found, THEN record them in `stack.ciSystems` — CI presence determines which orchestration policies (pr/pre_merge/nightly) can ever be enforced mechanically.
7. IF the stack has test frameworks but no `theqa.config.json`, THEN proceed (config is optional — `loadConfig` falls back to defaults) but note the missing criticalPaths/criticalFlows: the risk engine's businessCriticality factor loses its configured critical-path boost.
8. IF discovery is already attached to the context AND `provenance.commit` equals current HEAD AND no config/scaffold changed since, THEN discovery is sufficient — re-running is waste; otherwise re-run and replace the context.
9. IF `package.json` is unparseable, THEN continue with the remaining signals and carry the `package.json unparseable` signal forward — a broken manifest is itself a finding, not a reason to abort.
10. IF the repo is not a git repo, THEN `provenance.commit`/`branch` stay undefined — say so honestly; downstream provenance-sensitive claims (triage against a diff, risk ranges) are `NOT_RUN` until git exists.
11. IF source files exist but the language is `unknown` (no recognized marker), THEN report the mismatch — source extensions without stack markers usually mean an unsupported layout that selection's import closure may under-resolve.
12. ALWAYS attach the result: run `DiscoveryAgent.buildContext(discovery)` and persist via the context path (`.theqa/context.json`) so MODEL/PLAN phases read validated data, not chat memory.

### Inventory mechanics (what the engine actually matches)

Test-file patterns, in precedence order: playwright e2e (`**/*.spec.ts`, `**/*.spec.js`, `**/e2e/**/*.ts`), vitest unit (`**/*.test.ts`, `**/*.test.tsx`, `**/*.spec.tsx`), jest unit (`**/*.test.js`, `**/*.test.jsx`, `**/__tests__/**/*.ts|js`), pytest integration (`**/test_*.py`, `**/*_test.py`), k6 performance (`**/k6/**/*.js`, `**/performance/**/*.js`). Config-file capture is exact: `theqa.config.json`, `playwright.config.*`, `vitest.config.*`, `jest.config.*`, `pytest.ini`, `conftest.py`, `k6.config.js`. `estimatedCases` counts `test(`/`it(`, `def test_`, `void test` occurrences — an estimate, never a promise.

### What discovery does NOT detect (honesty boundaries)

- It does not parse test files to verify their layer is truthful — a browser-driving file named `*.test.ts` still classifies as vitest/unit; layer claims beyond the pattern table are `INFERRED` and review's job.
- It does not read lockfiles for transitive test tooling: a repo testing with a framework absent from package.json (global installs, scripts) is invisible — say so when the CI config mentions a runner the inventory lacks.
- It does not measure coverage, quality, or flakiness — those are downstream skills consuming this inventory, and discovery lends them none of its `OBSERVED` confidence.
- `estimatedCases` counts call sites, not behaviors: parameterized and table-driven cases inflate it, helper-wrapped assertions deflate it.

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | **Owned phase**: detectStack + inventoryTests + source/config listing → DiscoveryResult → buildContext. |
| MODEL | Consumed: application type, framework, language seed the context model. |
| PLAN | Consumed: inventory feeds selection (`existingTests`) and strategy layer decisions. |
| GENERATE | Consumed: gap analysis ("zero tests") is the generation mandate; scaffold targets existing framework. |
| VALIDATE | May skip (nothing generated). |
| EXECUTE | Consumed: runner choice comes from detected test frameworks. |
| OBSERVE | May skip. |
| TRIAGE | Consumed: changed-file paths are interpreted against the discovered layout. |
| HEAL | May skip. |
| VERIFY | Re-run discovery if the repo changed during the run; verify inventory still matches disk. |
| MEASURE | Consumed: test-file count and estimated cases are baseline suite metrics. |
| LEARN | Record recurring layout surprises (e.g. nonstandard test dirs) as review feedback. |

## Anti-patterns

- Fabricating a test suite for a repo with none — "I added a smoke test" that was never written is the cardinal discovery sin.
- Treating `estimatedCases` as a case count: it is a regex count over source text, blind to `.skip`, parameterization, and helper functions.
- Walking `node_modules` or vendored trees manually instead of trusting the engine's ignore list — noise drowns the inventory.
- Reporting "the project uses vitest" from one `*.test.ts` file when `stack.testFrameworks` lists three frameworks — quote the signal list, not a vibe.
- Ignoring the 20,000-file cap and presenting truncated numbers as complete.
- Discovering once and caching forever: a stale inventory makes selection select deleted files.
- Assuming a monorepo root is the right discovery root — per-workspace discovery is often the honest unit.
- Skipping discovery because "the user said it's a Next.js app" — signals beat assertions, every time.

## Failure handling

- Root does not exist / unreadable → report the error verbatim; never return an empty DiscoveryResult as if the repo were empty.
- Walker hit unreadable directories → they are skipped silently by design; the agent must call out any directory it expected to see in the output but did not.
- `package.json` unparseable → signal recorded, remaining signals still evaluated; surface the JSON error as a finding.
- No git → provenance commit/branch undefined; mark diff-dependent follow-ups `NOT_RUN`.
- Cap truncated → rerun per workspace or with custom `ignores`; never average across a truncated walk.
- Conflicting signals (python sources + package.json) → report both; the engine's language resolution is deterministic (package.json wins for `typescript`), and the anomaly is worth a sentence, not a silent pick.
- A workspace root handed in that is actually a subdirectory → discover the true root (workspace manifest location) and note the correction; inventories of half a repo mislead selection for the whole session.
- Symlink-heavy trees → the walker follows directories as the OS presents them; report duplicate-looking paths rather than deduplicating by guesswork.

## Evidence requirements

- Stack signals, test files, config files: `OBSERVED` — each is a file-presence fact; quote the `signals[]` list rather than paraphrasing it.
- `estimatedCases`: `INFERRED` — regex estimate over text, not a parsed AST.
- Application type (`web-app`/`monorepo`/`library`/`unknown`): `INFERRED` from documented mapping.
- "Zero tests exist" claims: `OBSERVED` only when the walk completed under the cap; `INFERRED` when truncated, with the cap stated.
- Provenance commit/branch: `OBSERVED` when git is present, otherwise absent — never invented.
- Anything downstream agents add on top of DiscoveryResult (e.g. "looks like a clean-architecture repo") is `INFERRED` and labeled as the agent's reading, not the engine's.
- `sourceFiles` counts (filtered by extension, test-shaped exclusion) are `OBSERVED` counts of a filtered walk — present them with the filter, because "210 source files" means something specific.

## Safety constraints

- Safety class: `READ_ONLY` (`ACTION_POLICIES: 'discover'` — "Inspects repository structure and test inventory without writing").
- No `--confirm-risk` path exists; discovery never touches production, CI secrets, or external systems.
- Golden rules engaged: 4 (no verification claims without evidence — discovery claims are file-presence facts, nothing more), 12 (reproducibility — provenance recorded), 14 (explainable decisions — the `signals[]` array IS the explanation).
- Do not read or echo secret-bearing files (.env, credential stores) during discovery even though the walker can see them — discovery reports paths, never contents of secret-shaped files.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "root": "/work/checkout-service",
    "summary": "typescript + next project — 12 test file(s) (~48 estimated cases) — 210 source file(s) — test frameworks: playwright, vitest",
    "stack": {
      "language": "typescript",
      "framework": "next",
      "packageManager": "pnpm",
      "testFrameworks": ["playwright", "vitest"],
      "ciSystems": ["github-actions"],
      "monorepo": false,
      "signals": ["package.json present", "next dependency", "@playwright/test dependency", "vitest dependency", "packageManager field: pnpm@9.1.0", "tsconfig.json present"]
    },
    "testFileCount": 12,
    "estimatedCases": 48,
    "sourceFileCount": 210,
    "configFiles": ["playwright.config.ts", "theqa.config.json", "vitest.config.ts"],
    "testFiles": [
      { "filePath": "tests/checkout/cart.total.test.ts", "framework": "vitest", "layer": "unit", "estimatedCases": 6 }
    ]
  }
}
```

`data.stack` mirrors `StackInfo`; `data.testFiles[]` mirrors `DiscoveredTestFile[]`; `label` is the engine's own `OBSERVED`. The MCP `discover_project` handler returns exactly this shape (root, summary, stack, counts, configFiles, testFiles, label).

## Examples

### Walkthrough 1 — healthy monorepo
`qa discover --json` on a pnpm workspace reports: signals include `package.json present`, `pnpm-workspace.yaml` → `monorepo: true`, frameworks playwright+vitest+jest, CI `gitlab-ci`. 340 test files, ~1,910 estimated cases. The agent applies rules 1, 2, 6, 8: attaches the context with provenance commit `a1b2c3d`, notes that `.spec.ts` files classify as playwright-e2e (rule 2 precedence) while `__tests__/**` jest files stay unit, and declares discovery sufficient for the session (rule 8). No fabrication, no per-file deep dive — the inventory is the deliverable.

### Walkthrough 2 — zero tests, honest gap
Discovery of a Go service finds `go.mod`, 87 source files, zero test files, no CI. Rule 4 applies: the report says exactly that — "no test framework detected; 0 test files against 87 source files; coverage gap is total, not partial" — and routes to requirements extraction and generation planning with the source inventory as the working set. The agent does NOT write a token `main_test.go` to make the number non-zero, does not claim pytest would work, and records in the context that every downstream label stays `NOT_VERIFIED` until real tests exist and run.

## Verification checklist

- [ ] Every claim in the report traces to a `signals[]` entry or a listed file (no invented frameworks or counts).
- [ ] Zero-test findings were reported as a coverage gap with next steps, never papered over.
- [ ] Pattern-precedence conflicts (`*.spec.ts`) were resolved by the documented first-match rule, not by guesswork.
- [ ] The 20,000-file cap was either not reached or explicitly reported as truncation.
- [ ] Provenance (commit/branch) was recorded, or their absence was stated.
- [ ] The validated context was built and attached before any downstream skill ran.
- [ ] Re-discovery was skipped only when the staleness rules (rule 8) genuinely allowed it.
- [ ] The skill wrote nothing to the repository (READ_ONLY held).
- [ ] `estimatedCases` were presented as estimates, and empty test files were flagged for review.
- [ ] The report distinguished the engine's `OBSERVED` facts from any agent-added `INFERRED` reading.
