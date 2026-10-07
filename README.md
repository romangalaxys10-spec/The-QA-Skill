<div align="center">

# The-QA-Skill

**The AI-native QA operating system for coding agents.**

Turns Claude Code, Cursor, Copilot, Windsurf, Codex, Cline, Gemini CLI, and Zed into
an elite, evidence-driven QA organization — deterministic engines first, AI only
where semantics demand it.

[![Sponsored by xShredo.dev](https://img.shields.io/badge/Sponsored_by-xShredo.dev-6d28d9?style=for-the-badge)](https://xshredo.com/promo/anytest)
[![CI](https://github.com/romangalaxys10-spec/The-QA-Skill/actions/workflows/ci.yml/badge.svg)](https://github.com/romangalaxys10-spec/The-QA-Skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.17-blue)](package.json)

`qa impact` — smallest high-confidence test set for this PR ·
`qa triage` — 87 failures → real defects vs flakes vs env ·
`qa heal` — repair without weakening intent, with confidence

</div>

---

> Sponsored by **[xShredo.dev](https://xshredo.com/promo/anytest)** — opening the link supports this project.

## Why

Coding agents are great at *writing* tests and terrible at *doing QA*. They jump from "user asked for tests" straight to Playwright code, with no risk model, no selection discipline, no triage, no evidence, and no way to say "I verified this" honestly. The-QA-Skill is the missing operating layer: **28 agent-readable skills** (Layer A) backed by a **deterministic execution platform** (Layer B) with a documented risk algorithm, a 12-category failure classifier, confidence-tiered self-healing, evidence bundles, a quality graph, and a benchmark corpus that measures all of it — 13 broken apps with expected diagnoses, graded honestly.

## The lifecycle (every QA task, no exceptions)

```
DISCOVER → MODEL → PLAN → GENERATE → VALIDATE → EXECUTE →
OBSERVE → TRIAGE → HEAL/FIX → VERIFY → MEASURE → LEARN
```

The [`LifecycleTracker`](packages/core/src/lifecycle.ts) mechanically refuses phase-skipping: you cannot EXECUTE without PLAN, cannot HEAL without TRIAGE, cannot MEASURE without VERIFY. "User asked for tests → write Playwright code" is now an exception, not a behavior.

## Killer commands

| Command | What it actually does |
|---|---|
| `qa impact --range HEAD~1..HEAD` | Parses the diff, classifies areas, builds the import graph, selects the **smallest high-confidence test set** — every selected test carries explicit reasons; CSS-only changes never trigger API suites |
| `qa risk` | 8-factor explainable risk engine (0–100): `businessCriticality ×0.20, changeSurface ×0.15, userImpact ×0.15, defectHistory ×0.12, integrationDepth ×0.12, codeComplexity ×0.10, securitySensitivity ×0.08, dataSensitivity ×0.08` + documented tier floors (payment/migration ≥ 0.9 → **critical**) — always prints `+ payment logic changed` style reasons |
| `qa triage --evidence failures.json` | Classifies failures into **12 categories** with confidence, signals, *contradicting* signals, root-cause hypothesis, and recommended action; clusters 87 failures into signatures (primary vs cascade) |
| `qa heal --evidence … --apply --confirm-risk` | HIGH tier (pure selector swap, observed in DOM, assertions untouched) auto-applies with `.pre-heal.bak` backup; MEDIUM proposes; **LOW never touches**. Never weakens assertions, never raises timeouts, never deletes tests |
| `qa release` | PASS / PASS_WITH_WARNINGS / **BLOCKED** / FAIL / **UNKNOWN** — a subset passing is never PASS; empty evidence is never PASS |
| `qa doctor` | 12 health checks (node, git, playwright, browsers, ports, env, secrets hygiene…) → score 0–100 with fixes |

Plus: `init · discover · plan · generate · review · test · flake · coverage · report · explain` — all with `--json --quiet --verbose --dry-run` where applicable, machine envelope `{schemaVersion, command, ok, data, label}`.

## Architecture

```
Layer A — skills the agent reads          Layer B — the execution platform
┌────────────────────────────┐            ┌─────────────────────────────────┐
│ skills/ (28 SKILL.md)      │            │ packages/core     engines       │
│  qa-enterprise (entry)     │──calls──▶  │ packages/agents   8 + orchestr. │
│  qa-orchestrator (govern)  │            │ packages/runners   pw/vitest/py  │
│  qa-failure-triage         │            │ packages/healing  tiered heals  │
│  qa-llm-testing (flagship) │            │ packages/graph    traceability  │
│  qa-agent-evaluation       │            │ packages/reporting 4 audiences  │
│  …24 more                  │            │ packages/data      factories    │
└────────────────────────────┘            │ packages/reasoning multi-model  │
                                          │ packages/mcp-server 11 MCP tools│
                                          │ packages/cli        16 commands │
                                          └─────────────────────────────────┘
```

- **Deterministic first**: parsers → analyzers → matchers → *only then* optional LLMs via the provider-agnostic `ReasoningProvider` (OpenAI / Anthropic / Gemini / local behind one interface; the default provider is deterministic and always configured).
- **Explainability everywhere**: every conclusion carries `{result, confidence, evidence[], assumptions[], fallbackUsed}` and a verification label — `NOT_VERIFIED / NOT_RUN / INFERRED / OBSERVED / CONFIRMED`.
- **Safe automation**: every action classified `READ_ONLY / LOW_RISK_WRITE / HIGH_RISK`; HIGH_RISK requires explicit `--confirm-risk`.
- **No AI magic**: "classified FLAKE (0.88) because: failed then passed on retry, no relevant change, historically intermittent" — never "AI thinks it's probably flaky".

## The quality graph

```
Requirement → Feature → Code → API → UI → Test → Execution → Evidence → Defect
Commit → Changed file → Symbol → Affected feature → Risk → Relevant tests
```

([packages/graph](packages/graph)) — traceability queries: `traceRequirement`, `affectedTests`, GraphViz export, JSON persistence. See [docs/quality-graph.md](docs/quality-graph.md).

## MCP server (agent-native)

`npm run mcp` starts a dependency-free stdio MCP server exposing 11 tools: `discover_project, analyze_risk, list_relevant_tests, generate_tests, run_tests, get_failure_evidence, triage_failure, propose_test_heal, analyze_flake, generate_quality_report, evaluate_release`. Planning tools never write; `run_tests` defaults to dry-run; healing tools propose, never apply. ([docs/architecture.md](docs/architecture.md))

## Benchmark (the honest moat)

13 realistic broken apps — auth-bug, flaky-test, selector-change, api-regression, db-regression, a11y-regression, payment-regression, visual-regression, race-condition, missing-coverage, weak-assertion, false-positive, false-negative — each with materializable git history, recorded failure evidence, and machine-checkable expected diagnoses.

```bash
npm run benchmark        # → benchmarks/agentic-qa/results.md
```

Latest measured run on this repo (deterministic engines, no LLM): **triage 18/18 · quality 9/9 · coverage 1/1 · risk 1/1 expectation checks green** — reproducible byte-for-byte. Numbers come only from the harness on this repo's fixtures; we publish misses, never invented ones. Methodology: [docs/benchmark.md](docs/benchmark.md).

## Quick start

```bash
# in your project repo
npx the-qa-skill init          # or clone this repo and npm install && npm run build
qa doctor                      # 12 checks + fixes
qa discover                    # stack, tests, config inventory
qa impact --range HEAD~1..HEAD # smallest high-confidence test set for your change
qa test --policy pr            # execute with evidence bundles
qa triage                      # classify what failed, with proof
qa release                     # honest gate verdict
```

For agents: read [`skills/qa-enterprise/SKILL.md`](skills/qa-enterprise/SKILL.md) first — it routes everything else. For MCP clients, register `packages/mcp-server` (stdio).

## Documentation

[Architecture](docs/architecture.md) · [Agent model](docs/agent-model.md) · [Quality model](docs/quality-model.md) · [Risk engine](docs/risk-engine.md) · [Test selection](docs/test-selection.md) · [Failure triage](docs/failure-triage.md) · [Self-healing](docs/self-healing.md) · [Quality graph](docs/quality-graph.md) · [Governance](docs/enterprise-governance.md) · [CI integration](docs/ci-integration.md) · [Security](docs/security.md) · [Benchmark](docs/benchmark.md) · [Gap analysis](docs/enterprise-qa-gap-analysis.md) · [Migration map](docs/migration-map.md)

## The 15 golden rules (embedded in the orchestrator)

1. Never weaken an assertion to make a test pass. *(mechanically enforced in healing)*
2. Never hide a regression behind retries. *(enforced in triage)*
3. Never use arbitrary sleeps as first fix. *(penalized in quality scoring)*
4. Never claim verification without execution evidence. *(enforced by labels + gate)*
5. Never generate massive redundant E2E suites. *(pyramid demotion in selection)*
6. Never destroy test isolation for speed.
7. Never auto-delete tests without strong evidence. *(deletion always requires human approval)*
8. Never expose secrets in test artifacts. *(scrubbed before write)*
9. Never perform destructive production actions without authorization. *(--confirm-risk)*
10. Always distinguish product defects from test defects. *(triage categories)*
11. Prefer the smallest test that catches the defect. *(selection ranking)*
12. Preserve reproducibility. *(evidence metadata: commit, seed, env)*
13. Preserve evidence. *(append-only bundles + .pre-heal.bak)*
14. Explain important decisions. *(ExplainableConclusion everywhere)*
15. Optimize for signal, not test count.

## Project status

v0.1.0 — full Layer A + Layer B build-out, 480+ tests green, benchmark corpus measured. Semantic versioning; see [docs/migration-map.md](docs/migration-map.md) for capability parity guarantees and [CHANGELOG.md](CHANGELOG.md) for history.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Every new engine must ship with tests, docs, and a fixture expectation; every AI-adjacent feature must expose its evidence, confidence, and fallback.

## License

[MIT](LICENSE) © The-QA-Skill contributors

<p align="center">Sponsored by <a href="https://xshredo.com/promo/anytest">xShredo.dev</a></p>
