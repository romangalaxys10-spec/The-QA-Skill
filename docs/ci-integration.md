# CI Integration

**Audience:** platform teams wiring The-QA-Skill into GitHub Actions, GitLab CI, Jenkins, Azure Pipelines, or plain shell.
**Source of truth:** `templates/` directory layout (this repo), root `package.json` scripts, `packages/reporting/src/verdict.ts` (gate rules), `packages/runners/src/executor.ts` + `retry.ts` (execution and retry discipline), `packages/core/src/evidence/bundle.ts` (artifact layout), `packages/mcp-server/` (agent-platform registration), `packages/core/src/discovery/stack.ts` (doctor detection inputs), `docs/migration-map.md` (CLI `--json` contract).

**Status note (read first):** the `templates/` directories exist (`github-actions/`, `gitlab-ci/`, `jenkins/`, `azure/`, `shell/`) and this doc specifies the contract each template file implements; the workflow files land in those directories as their own deliverable. Everything below about engines, env vars, artifacts, and gate wiring is verified against shipped code; where a template file is referenced, verify it matches its section before trusting a copy-paste.

## Template set

| Path | Purpose |
|---|---|
| `templates/github-actions/qa-pr.yml` | PR pipeline: doctor → impact/selection → tests → triage → upload evidence |
| `templates/github-actions/qa-nightly.yml` | Nightly: full suites, flake scoring, coverage, release-gate dry run |
| `templates/gitlab-ci/` | Same two stages expressed as `.gitlab-ci.yml` include fragments |
| `templates/jenkins/Jenkinsfile` | Declarative pipeline with the same stages and artifact archiving |
| `templates/azure/` | Azure DevOps pipeline equivalents |
| `templates/shell/qa.sh` | Vendor-neutral entrypoint the other templates call (so logic lives in one place) |

The shared stage graph every template implements:

```
preflight (doctor) → select (impact) → execute (tests) → triage → gate (release) → upload artifacts
```

## Stage contracts

### Preflight: doctor as CI preflight

Run `qa doctor` (root script: `node packages/cli/dist/index.js doctor`, or the `doctor` npm script) before spending minutes on tests. Doctor is a `READ_ONLY` action (`ACTION_POLICIES`) that probes the environment — stack detection (`detectStack`) reports language, package manager, test frameworks, and CI system from file-presence signals, and CI authors should fail the job early when the environment is unhealthy rather than collecting garbage failures that triage would classify `ENVIRONMENT_FAILURE`. A failing environment is an infra problem: fix the env, not the test.

### Select: smallest high-confidence set

`qa impact --json` (selection engine) maps the git diff range onto the transitive import-closure coverage map and returns a `SelectionResult` with per-test reasons. Empty selection on a code change is a **coverage gap, not safety** — treat it as a warning signal, not a green light.

### Execute: retry policy discipline

`RunExecutor` spawns runners with no shell, an allowlisted env (below), and a hard timeout (`QA_RUN_TIMEOUT_MS`, default 600000 ms); tests killed by the timeout are honestly marked `timedout`. The retry policy (`packages/runners/src/retry.ts`) is explicit and must survive any CI wrapper:

> *Retries exist for flake diagnostics, never to hide regressions (golden rule 2): REAL_REGRESSION failures are never retried, and every retry is recorded as an attempt.*

Mechanically: `RetryManager.plan()` returns **0 additional attempts** for anything triaged `REAL_REGRESSION`; everything else gets at most `maxRetries` minus retries already spent (config `execution.maxRetries`, default 1). CI must not add a blanket retry knob on top — a retried green run over changed code still classifies `REAL_REGRESSION` in triage (rule 9), and the rerun budget for bug reproduction is `execution.rerunBudget` (default 3), not a pass-laundering loop.

### Triage + gate: the quality-gate job pattern

The gate is deterministic (`packages/reporting/src/verdict.ts`, `computeReleaseGate`): empty input → `UNKNOWN` (never PASS); `failedRealRegressions > 0` or any triage `REAL_REGRESSION` with confidence ≥ 0.9 → `BLOCKED`; otherwise warnings (incomplete evidence downgrades PASS to `PASS_WITH_WARNINGS`, `openUnknownCategories > 2`, `criticalFlakeCount > 0`, weighted coverage < 60) → `PASS_WITH_WARNINGS` or `PASS`. `FAIL` is reserved for human override downstream; the gate never invents it.

CI wiring (documented CLI contract: all commands accept `--json` with a `schemaVersion` field — `docs/migration-map.md`):

```bash
verdict=$(qa release --json | jq -r '.data.verdict // .verdict')
if [ "$verdict" = "BLOCKED" ]; then
  echo "release gate blocked"; exit 1
fi
```

Until the `packages/cli` surface ships in this workspace stage (root script `qa` exists; implementation is staged), the identical gate is available over MCP via the `evaluate_release` tool or in-process via `computeReleaseGate` from `@the-qa-skill/reporting` — the rules are byte-for-byte the documented decision table, mirrored in `packages/mcp-server/src/report.ts` (`computeGate`). The job fails on `BLOCKED`; `PASS_WITH_WARNINGS` is recorded (job annotations) but does not fail by default; `UNKNOWN` must never be treated as PASS.

## Sharding guidance

- Shard along the selection engine, not blindly: `SelectionResult` groups by framework and priority; the executor only runs runners whose framework appears in the selection, so per-framework shards (`vitest` shard, `playwright` shard) partition cleanly.
- Keep `maxPrE2E` (default 25) as the PR e2e budget per run; a nightly job can lift it deliberately via `theqa.config.json` — the policy lives in config, not in CI YAML.
- Each shard writes its own evidence tree under `.theqa/artifacts/run-<date>/`; because bundle directories are keyed by run date + test id, use one `runId`-scoped artifacts upload per shard job (below) to avoid cross-shard overwrites.

## Artifact upload of `.theqa/artifacts` evidence

Upload the whole evidence root as a CI artifact on **every** run that executed tests, not only failures (triage and release gates need the evidence trail):

- Layout produced by `writeEvidenceBundle`: `.theqa/artifacts/run-<date>/<testId>/` containing `metadata.json`, `failure.md`, `console.log`, `network.json` (plus `screenshot.png`/`trace.zip` when runners emit them). Contents are secret-scrubbed before write.
- Dry runs persist `<evidenceRoot>/<runId>/plan.json` — upload it too; it is the run's paper trail of what *would* have executed.
- Retention: follow `docs/enterprise-governance.md` (PR bundles ~30 days, nightlies 90, release evidence for the audited window). Append-only: never mutate a bundle after upload.

## Failure annotation

- JUnit is the interchange format: `packages/reporting/src/junit-writer.ts` (`toJUnitXml`) maps failed → `<failure>`, `timedout` → `<error type="Timeout">`, `skipped`/`not_run` → `<skipped>` (not_run carries the message `status: not_run`), durations in 3-decimal seconds, suites grouped by `filePath`. Feed this to the CI platform's native test-report feature (e.g. `dorny/test-reporter`-style JUnit ingestion on GitHub, JUnit archiving on Jenkins/GitLab/Azure) so failures annotate the PR without custom scripts.
- For human-readable summaries, render the 4-audience markdown report (`renderMarkdownReport`) and post it as a job summary; every claim carries its verification label and absent data is stated as absent.
- Failure evidence pointers (bundle paths under `.theqa/artifacts/...`) belong in the annotation so an engineer can jump from PR to proof.

## MCP server registration for agent platforms

The MCP server is a stdio, newline-delimited JSON-RPC 2.0 server (protocol `2024-11-05`, server name `the-qa-skill-mcp`, version from `packages/mcp-server/src/version.ts`), started with the root script `npm run mcp` → `node packages/mcp-server/dist/index.js`. Register it with generic stdio JSON — no marketplace or registry links involved:

**Claude Code (`claude code` — `.mcp.json` at repo root or user config):**

```json
{
  "mcpServers": {
    "the-qa-skill": {
      "command": "node",
      "args": ["/absolute/path/to/The-QA-Skill/packages/mcp-server/dist/index.js"],
      "env": { "THEQA_ROOT": "/absolute/path/to/your-project" }
    }
  }
}
```

**Cursor (`.cursor/mcp.json`):**

```json
{
  "mcpServers": {
    "the-qa-skill": {
      "command": "node",
      "args": ["/absolute/path/to/The-QA-Skill/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Notes verified against the server implementation: responses are written in request order on stdout and logs go to stderr; tool errors become `isError: true` results, so a failing tool cannot crash the loop; every tool payload is deep secret-scrubbed before it leaves the process. The tool catalog is plan-by-default (`generate_tests` never writes, `run_tests` has `dryRun` default **true**) — see `docs/security.md` before granting agents access.

## Secrets handling in CI

- Secrets live in the CI platform's secret store and reach the platform **as environment variables only** — never in `theqa.config.json` (the config schema has no key fields; model endpoints are read from env per the config's documented contract).
- The platform's child-process allowlist (`ENV_ALLOWLIST`) forwards only `PATH, HOME, LANG, TZ, CI, NODE_ENV` + `CI_*`/`QA_*` prefixed variables to test processes, so a CI token stored for the top-level job does not automatically reach test suites. If a test legitimately needs a credential, pass it via a `QA_*` variable and scrub outputs (evidence scrubbers handle common token shapes; do not rely on that for novel secret formats).
- Never echo secrets in logs: the MCP server scrubs, the evidence writer scrubs, but your CI YAML is your own responsibility.

## Matrix strategy

- **Node versions:** the package requires `node >= 18.17.0` (`engines` in root `package.json`). Matrix the CI over an LTS line plus the current release (e.g. 18 LTS and current) — `detectStack` and the engines are pure Node with no native deps.
- **Browsers:** Playwright projects define the browser matrix, not the CI matrix, when selection drives execution; use the CI matrix for genuinely parallel environments (e.g. `chromium` / `firefox` / `webkit` jobs) and let triage's env/browser spread reward you: failures replicated across browsers raise the flake score's env-spread term, and single-browser failures are flagged *"possibly environment-specific"*.
- Keep `environment` values on events consistent per matrix leg — triage's primary/cascade windowing and flake scoring group by environment string.

## Workflow sketches

GitHub Actions PR job (skeleton matching the template contract):

```yaml
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }          # diff range needs history
      - run: npm ci
      - run: npm run doctor               # preflight; fail fast on env problems
      - run: npm run qa -- impact --json  # selection for the PR range
      - run: npm run qa -- test --json    # execution with the documented retry policy
      - run: npm run qa -- triage --json
      - run: npm run qa -- release --json # gate; fail the job on BLOCKED
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: theqa-evidence, path: .theqa/artifacts }
```

`shell/qa.sh` runs the same sequence with plain commands for Jenkins/Azure/GitLab includes; nightly variants add `flake`, `coverage`, and the full-suite run with reporting for all four audiences.

## Verification

- [ ] `templates/` contains the five subdirectories; each template file present matches its stage contract above (doctor → select → execute → triage → gate → upload) before trusting it.
- [ ] Root `package.json` scripts verified: `qa` → `packages/cli/dist/index.js`, `doctor`, `benchmark` → `tsx benchmarks/agentic-qa/run.ts`, `mcp` → `packages/mcp-server/dist/index.js`; `engines.node >= 18.17.0`.
- [ ] Gate wiring fails the job only on `BLOCKED`; `PASS_WITH_WARNINGS` recorded; `UNKNOWN` never treated as PASS; `FAIL` never produced by the gate itself (`verdict.ts`).
- [ ] Retry discipline: `RetryManager.plan()` returns 0 for `REAL_REGRESSION`; `maxRetries` default 1; `rerunBudget` default 3; `RETRY_POLICY_NOTE` quoted in `retry.ts`.
- [ ] Evidence upload uses `.theqa/artifacts/run-<date>/<testId>/` with the four bundle files; artifacts uploaded `if: always()`; dry-run `plan.json` included.
- [ ] JUnit mapping verified (failed→`<failure>`, timedout→`<error type="Timeout">`, skipped/not_run→`<skipped>`, 3-decimal seconds, filePath grouping).
- [ ] MCP registration JSON is generic stdio config (command + args + env), no registry URLs; server protocol `2024-11-05`, name `the-qa-skill-mcp`; logs never touch stdout.
- [ ] Secrets: config file carries no credentials; `ENV_ALLOWLIST` exactly PATH/HOME/LANG/TZ/CI/NODE_ENV + `CI_*`/`QA_*`; spawn `shell: false`; `QA_RUN_TIMEOUT_MS` default 600000.
- [ ] Doctor stage is READ_ONLY and runs before execution; empty selection treated as coverage gap.
