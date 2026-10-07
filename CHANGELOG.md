# Changelog

All notable changes to The-QA-Skill are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [Semantic Versioning](https://semver.org/). Machine outputs (`--json`) carry `schemaVersion`; additive tool/command changes are minor, breaking contract changes are major.

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
