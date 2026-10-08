# Enterprise QA Gap Analysis — The-QA-Skill

**Status:** COMPLETE (based on direct inspection of the reference repository on 2026-10-07)
**Method:** Full structural audit of `romangalaxys10-spec/qa-automation-skill` at commit `1d2a092` (shallow clone, depth 50): directory enumeration of all 440 skill packages, line-count measurement of every package source file, and direct reading of representative skill files (`seed-skills/playwright-e2e/SKILL.md`), the CLI command surface (`packages/cli/src/commands/*.ts`), and the MCP server (`packages/mcp/src/index.ts`).
**Ground rule:** every number below was measured, not estimated. No capability is claimed for the old system that we did not observe in the code or content.

---

## 1. What the reference system actually is

The reference repository is a **QA skill content library with a distribution marketplace**. Its 440 `seed-skills/*` directories each contain a single `SKILL.md` — structured prose guidance (average ≈ 378 lines; ≈ 166,000 lines of markdown total) with YAML frontmatter metadata (name, description, version, tags, testingTypes, frameworks, languages, domains, agents). Its executable layer totals **≈ 2,127 lines of TypeScript** and implements marketplace plumbing only:

| Package | Measured contents | Function |
|---|---|---|
| `packages/cli` | 8 commands (`add`, `info`, `init`, `list`, `publish`, `remove`, `search`, `update`), agent detector (109 loc), framework detector (209 loc), installer (238 loc), api-client (138 loc), telemetry (37 loc) | Install/uninstall/search/publish skill markdown into agent config directories |
| `packages/mcp` | 1 file | MCP server that proxies **skill search/install** against the `qaskills.sh` API — not a QA tool |
| `packages/sdk` | 1 file (5 loc in `shared`) | Thin API wrapper |
| `packages/skill-validator` | 199 loc | Validates skill frontmatter shape |
| `packages/web` | middleware only (34 loc) | Marketing site hosting |

The remainder of the repository is editorial/SEO operations: blog article batches, a 100-keyword SEO research file, content calendars, competitor analysis, landing-page plans, and engineering `learnings/` logs.

**Conclusion:** the reference system can *install instructions that describe QA work*; it cannot *perform, verify, score, or govern QA work*. That distinction defines every gap below.

## 2. Capability matrix (current / target / gap)

Scale for "current": **None** = absent; **Prose** = described in skill text only, no code; **Partial** = some code exists but not for this purpose.

| # | Capability | Reference (measured) | The-QA-Skill target | Gap severity |
|---|---|---|---|---|
| 1 | Risk scoring engine (8-factor, explainable, 0–100, tiers) | None | `packages/core` deterministic engine + contributor explanations | Critical |
| 2 | Change impact analysis (git diff → files → symbols → affected tests) | None | `qa impact` with per-test selection reasons | Critical |
| 3 | Intelligent test selection (smallest high-confidence set) | Prose only (`regression-test-selection`, `test-impact-analysis` skills) | `packages/core/impact` import-graph selector with routing policies | Critical |
| 4 | Failure triage (12 categories, confidence, evidence, root-cause hypotheses) | Prose only (`flaky-test-doctor`, `debugging-strategies`) | Deterministic rules engine + signature clustering | Critical |
| 5 | Flake intelligence (scores, trends, env/browser spread) | Prose only (`test-flakiness-detection`, `flaky-test-quarantine`) | `qa flake` with documented scoring formula | High |
| 6 | Self-healing with confidence tiers + policy guardrails | Prose only (`self-healing-locators-strategy`) | `packages/healing` — HIGH/MEDIUM/LOW tiers, golden-rules enforcement | Critical |
| 7 | Test quality scoring (17 dimensions, explainable deductions) | None | `qa review` static analysis engine | High |
| 8 | Suite health score (10 components, 0–100) | None | `packages/core/quality` | High |
| 9 | Quality Graph (Requirement→Feature→Test→Defect traceability) | None | `packages/graph` with traceability queries | High |
| 10 | Evidence bundles (trace, screenshots, console, network, failure.md) | None | `packages/core/evidence` — deterministic artifact layout | Critical |
| 11 | Test execution runners (Playwright, pytest, k6, ZAP, Appium adapters) | None (CLI never runs tests) | `packages/runners` with output parsers per framework | Critical |
| 12 | Lifecycle orchestration (12 phases, no phase-skipping) | None | `packages/core/lifecycle` + `packages/agents` orchestrator | Critical |
| 13 | Safe automation policy (READ-ONLY / LOW-RISK-WRITE / HIGH-RISK) | None | `packages/core/policies` enforced across CLI + MCP | High |
| 14 | Verification labels (NOT VERIFIED / NOT RUN / INFERRED / OBSERVED / CONFIRMED) | None | `packages/core/labels` used by every output contract | Critical |
| 15 | Release quality gate (PASS / PASS_WITH_WARNINGS / BLOCKED / FAIL / UNKNOWN) | Prose only (`release-readiness-checklist`) | `qa release` verdict engine with blocking reasons | High |
| 16 | AI/LLM system testing (prompt regression, hallucination, grounding, injection) | Prose only (`ai-model-testing`, `llm-output-testing`, 15+ related skills) | `skills/qa-llm-testing` + eval dimensions wired to platform | High |
| 17 | Agent evaluation harness (does the coding agent QA correctly?) | Prose only (`ai-agent-eval`, `agentic-testing`) | `skills/qa-agent-evaluation` + `benchmarks/agentic-qa` | High |
| 18 | MCP server exposing QA operations | Partial — MCP exists but only searches skill listings | `packages/mcp-server` with 11 QA tools (risk, triage, heal, …) | Critical |
| 19 | Multi-model reasoning (no vendor lock-in) | None | `packages/reasoning` provider interface + deterministic default | High |
| 20 | Deterministic-first pipeline (parsers before LLMs) | None — no pipeline at all | Enforced in architecture; every AI claim carries evidence + fallback | Critical |
| 21 | Learning loop (structured, non-silent) | None | `packages/core/learning` JSONL store queried by triage/healing | Medium |
| 22 | Business-risk-aware coverage reporting | Prose only (`code-coverage`, `test-coverage-gap-finder`) | `qa coverage` risk-weighted coverage + critical-flow gaps | High |
| 23 | Test data engineering (factories, seeds, masking, isolation) | Prose only (`test-data-factory`, `faker-test-data`, `test-data-anonymization`) | `packages/data` executable factories + deterministic RNG | Medium |
| 24 | Reporting for 4 audiences (engineering/QA/leadership/executive) | Prose only (`test-reporting-dashboards`) | `packages/reporting` + `qa report --audience` | Medium |
| 25 | CI/CD templates (GHA, GitLab, Jenkins, Azure, shell) | Prose only (`github-actions-testing`, `cicd-pipeline`) | `templates/` with sharding, artifact upload, quality gates | Medium |
| 26 | `qa doctor` environment health (score + PASS/WARN/FAIL checks) | None (their `init` writes agent config) | 12 health checks with recommended fixes | Medium |
| 27 | Governance (RBAC, audit logs, PII masking, retention) | Prose only (`soc2-compliance-testing`, `gdpr-compliance-testing`) | `skills/qa-governance` + masking in `packages/data` + audit policy | Medium |
| 28 | Benchmark: broken fixtures + honest baseline metrics | None | 13 fixtures with expected diagnoses + measurement harness | Critical |
| 29 | Skill content library | **Strong** — 440 skills, wide framework/domain coverage, frontmatter metadata | 28 skills, each bound to executable platform contracts | Preserve + restructure |
| 30 | Multi-agent compatibility (claude-code, cursor, copilot, windsurf, codex, cline, zed…) | **Strong** — agent matrix in frontmatter, agent detector code | Same agent matrix; skills are agent-agnostic; MCP for deep integrations | Preserve |
| 31 | Marketplace distribution (search/publish/install) | Strong | Deliberately **not cloned** — local-first design; skills ship in-repo; MCP replaces server dependency | Intentional divergence |
| 32 | SEO/blog/marketing operations | Strong (out of engineering scope) | Out of scope — this is an engineering product | Intentional divergence |

## 3. Root-cause analysis of the gap

Three structural causes explain why 166k lines of prose produce no execution capability. First, the unit of value is the **document**, so every improvement historically added more documents (440 skills) rather than code; nothing checks whether guidance is followed, and nothing fails when it is ignored. Second, the distribution model is **marketplace-first**: the CLI's job is moving files into agent config directories, so the natural stopping point is "instructions delivered" rather than "outcome verified." Third, there is no **shared context model**: skills cannot hand state to each other, so no lifecycle, no evidence chain, and no compounding intelligence is possible.

The rebuild inverts each cause. The unit of value is the **verified QA decision** (a risk score, a triage classification, a healing proposal — each with evidence and confidence). The distribution model is **repo-local and agent-native**: skills + CLI + MCP operate inside the user's repository where the evidence lives. And a single Zod-validated **QA Context** is the shared language every engine reads and writes, which is what makes orchestration, learning, and the Quality Graph possible at all.

## 4. Preservation commitments (backward compatibility)

Nothing useful is deleted. The migration map (`docs/migration-map.md`) accounts for every meaningful capability cluster in the reference library and maps it to The-QA-Skill equivalents under semantic versioning. Representative mappings: the 12+ Playwright skills collapse into `qa-test-generation` + `qa-test-execution` with a Playwright specialization section; the flakiness trio (`test-flakiness-detection`, `flaky-test-doctor`, `flaky-test-quarantine`) maps to `qa-flake-detection` + the `qa flake` engine; the LLM-testing cluster (`ai-model-testing`, `llm-output-testing`, `prompt-testing`, `rag-evaluation-metrics`, …) maps to `qa-llm-testing`; the marketplace CLI maps to local-first `qa discover` + MCP tools. Where the reference had breadth we keep breadth; where it had only prose we now have executable behavior with identical or stricter guidance.

## 5. Gap-closure architecture (summary)

Layer A (`skills/`, 28 skills) keeps the reference's proven strength — structured, agent-readable guidance — but every skill declares an **Output Contract** that binds to Layer B. Layer B (`packages/`, 10 packages) is a deterministic-first execution platform: Zod-validated context, a documented risk algorithm, a 12-category triage classifier, confidence-tiered healing with golden-rule enforcement, evidence bundles, a Quality Graph, provider-agnostic reasoning, and an MCP surface of 11 tools. A 13-fixture broken-app corpus with expected diagnoses exists precisely so that claims about closing this gap are **measured**, not asserted (see `benchmarks/agentic-qa/` and `docs/benchmark.md`).

## 6. Verification checklist for this audit

- [x] Cloned reference repo and enumerated all 440 skill directories (count verified by `ls seed-skills/*/SKILL.md | wc -l` = 440)
- [x] Measured total SKILL.md volume (166,221 lines) and per-skill average
- [x] Line-counted every TypeScript source file across all 6 packages (2,127 lines)
- [x] Read the CLI command surface and confirmed it performs marketplace operations only
- [x] Read the MCP server and confirmed it proxies skill search, not QA operations
- [x] Sampled representative SKILL.md files to confirm prose-only format (no output contracts, no verification steps)
- [x] Confirmed absence of: test execution, risk scoring, triage, healing, evidence, quality graph, lifecycle, benchmarks (grep + structural inspection)
- [x] No content, code, or text copied from the reference into The-QA-Skill
