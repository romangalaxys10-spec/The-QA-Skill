# Changelog

All notable changes to The-QA-Skill are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [Semantic Versioning](https://semver.org/). Machine outputs (`--json`) carry `schemaVersion`; additive tool/command changes are minor, breaking contract changes are major.

## [0.2.0] — 2026-10-08

### Added
- **xRouteLM — the portable System One decision engine (`packages/xroutelm`)**: Jev-compatible question semantics (choice / score / noul) with calibrated probabilities and recorded evidence; plugin scorer pipeline — `xroutelm/heuristic` (always available, zero dependencies) plus a feature-detected `xroutelm/laya-bridge` that reports honest unavailability off macOS/Apple Silicon; `SystemOneHarness` for agent-loop gating and fast-vs-powerful model routing; JSONL decision journal; `RouteStats` success-rate learning (≥5 samples, <0.3 demote / ≥0.7 promote, never silent); `xroutelm.plugin.json` manifest discovery with visible errors. Runs anywhere Laya cannot, without needing Jev.
- **`qa route`** — task routing over xRouteLM (default QA targets + plugin targets + learning); **`xroutelm` bin** (`decide`, `route`, `doctor`, `plugins list`).
- **Ground-truth verification (`qa verify` + core verify engine)**: claim → deterministic probes (file_exists, dir_exists, file_contains, file_not_contains, json_valid, cmd_exit_zero, git_ref_exists, http_status) → VERIFIED / REFUTED / UNKNOWN. Probe errors are UNKNOWN, never refutations. `--repeat` upgrades agreeing runs to CONFIRMED. REFUTED claims are recorded in the persistent KNOWN_FALSE registry (`.theqa/known-false.json`) banning silent retries. `verify_claim` MCP tool.
- **Mechanical golden-rule audits (`qa audit-rules` + core rules engine)**: the enforceable subset of the 15 rules (sleep discipline, retry masking, evidence-backed CONFIRMED, pyramid budget, secret patterns, seeds, explainability, categorization) evaluated over any payload; inapplicable rules report `applicable: false` — honest inapplicability instead of fake passes.
- **Traceability matrix (`qa matrix`)**: requirement→test records (`.theqa/matrix.json`) rendered with per-requirement confidence (CONFIRMED / OBSERVED / NOT_RUN / GAP) and honest empty-state instructions.
- **Token-efficiency module (`qa tokens` + core DTOC)**: documented caps (ls 20 · logs 30 · diff 100 · config 80 · search 40), tail-keeping for logs/search, visible truncation markers, chars/4 token-savings estimates; `skills/token-efficiency` codifies AST-first reading, progressive disclosure, session cache, and six-field subagent scoping.
- **MCP catalog grows to 13 tools**: `verify_claim` and `route_task` join the 11 existing tools.
- **Claude plugin packaging**: `.claude-plugin/plugin.json` + `marketplace.json`, SessionEnd hook (`hooks/hooks.json` → draft session records, secret-free by construction).
- **Skill-contract linter (`scripts/lint-skills.mjs`)**: enforces the 13-section contract, frontmatter schema, 120-line content floor for qa-* skills, and a machine-readable schema block per skill — 30/30 skills pass.
- **Documentation drift linter (`scripts/lint-docs.mjs`)**: every `qa <cmd>` reference in docs/skills must name a real command; every doc must anchor to real packages/commands/benchmarks; benchmark claims must match results.json.
- **xRouteLM routing benchmark (`benchmarks/agentic-qa/run-routing.ts` + `routing.json`)**: 12 routing expectations measured against the exact `qa route` engine — first run 12/12 (100%), mean confidence 0.87; results in `results-routing.json`/`results-routing.md`; wired into `npm run benchmark` and CI.
- **docs/xroutelm.md** — design, semantics, plugin system, honesty contract, and the Laya/Jev relationship.

### Fixed
- CI `on.push.branches` YAML bug (`branches: ain]` parsed as a branch literally named "ain]" — main-branch pushes never ran CI); doctor self-check now uses visible `continue-on-error` instead of `|| true`; linters added as blocking CI steps.
- All 28 skills: `license: MIT` added to frontmatter; bindings updated to the 21-command/13-tool surface; qa-enterprise output contract now includes the machine envelope schema.

### Changed
- CLI surface 16 → 21 commands; MCP catalog 11 → 13 tools; skills 28 → 30.
## [0.1.0] — 2026-10-07

### Added
- **Layer A — 28 agent-readable skills** (`skills/*/SKILL.md`): qa-enterprise (entry point), qa-orchestrator (intent routing + lifecycle governance), qa-discovery, qa-requirements, qa-risk-analysis, qa-test-strategy, qa-test-generation, qa-test-review, qa-test-execution, qa-failure-triage, qa-flake-detection, qa-test-healing, qa-coverage-analysis, qa-impact-analysis, qa-visual, qa-accessibility, qa-api, qa-contract, qa-security, qa-performance, qa-mobile, qa-data, qa-release-gate, qa-reporting, qa-observability, qa-governance, and flagship qa-llm-testing + qa-agent-evaluation. Every skill carries the 13-section contract (Purpose → Verification checklist) with bindings to real commands, MCP tools, and engines.
- **packages/core** — Zod-validated QA Context model; documented 8-factor risk engine with tier floors; change-impact diff analysis + smallest-high-confidence-set selection with pyramid demotion and routing hints; 12-category failure triage decision table with signature normalization and Jaccard clustering; flake scoring (40/25/20/15 formula); 17-dimension test quality scoring + 10-component suite health; confidence-tiered healing policy with golden-rule enforcement and `.pre-heal.bak` backups; risk-weighted coverage; evidence bundles with secret scrubbing; JSONL learning loop; 12-phase lifecycle tracker with mandatory-phase guard; safe-automation policy registry; 15 golden rules.
- **packages/agents** — Discovery, Requirements, Risk, Generation (deterministic test-plan pipeline across 10 case categories), Review, Execution, Triage, Healing agents + Orchestrator with intent routing, primary-vs-cascade detection, and local release gate.
- **packages/runners** — Playwright, Vitest/Jest (JSON), pytest + JUnit XML parser, k6, ZAP (plan-only), Appium adapters; RunExecutor with dry-run, env allowlist, and evidence collection; retry discipline (never hides regressions).
- **packages/reporting** — JUnit XML writer; four-audience Markdown reports with verification-label discipline; Slack payloads with verdict colors; deterministic release-gate verdict engine.
- **packages/graph** — Quality Graph (12 node kinds, 8 edge kinds): traceRequirement, affectedTests, GraphViz export, JSON persistence.
- **packages/data** — seeded deterministic factories (mulberry32 + FNV-1a), unique identities, Luhn-aware PII masking, fixture manifest validation.
- **packages/reasoning** — ReasoningProvider interface; deterministic default provider; OpenAI/Anthropic providers with strict error discipline and injected-transport tests; never-throw registry.
- **packages/mcp-server** — dependency-free MCP stdio server (JSON-RPC 2.0) exposing 11 QA tools; plan-by-default semantics.
- **packages/cli** — 16 commands (`init discover plan risk generate review test impact triage heal flake coverage release report doctor explain`), `--json/--quiet/--verbose/--dry-run/--confirm-risk`, schema-versioned machine envelope, honest exit codes.
- **fixtures** — 13 broken apps with materializable git histories and machine-checkable expected diagnoses.
- **benchmarks/agentic-qa** — deterministic harness: materializes fixture git repos, grades engines against expectations, publishes `results.json`/`results.md`. First measured run: triage 18/18, quality 9/9, coverage 1/1, risk 1/1 expectation checks green.
- **templates** — GitHub Actions (PR + nightly), GitLab CI, Jenkins, Azure DevOps, POSIX shell; plus this repo's own CI (Node 20/22 matrix, build, tests, doctor, fixture validation, benchmark).
- **docs** — enterprise-qa-gap-analysis (measured audit of the reference capability landscape), migration-map, architecture, agent-model, quality-model, risk-engine, test-selection, failure-triage, self-healing, enterprise-governance, ci-integration, benchmark, security, quality-graph.
