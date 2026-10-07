# Contributing to The-QA-Skill

Thanks for helping build the AI-native QA operating layer. This project has one non-negotiable standard: **nothing is claimed that is not verified**. The rules below exist to keep that standard real.

## Ground rules

1. **Deterministic first.** Parsers and rule engines before LLM calls. Any AI-adjacent feature must expose input, reasoning objective, evidence, output schema, confidence, and fallback (see `packages/core/src/types.ts` → `ExplainableConclusion`).
2. **Every verdict carries a label.** `NOT_VERIFIED / NOT_RUN / INFERRED / OBSERVED / CONFIRMED` — if your feature produces a claim, it produces a label.
3. **No TODOs, no placeholder data, no fabricated benchmarks.** UNKNOWN is a valid outcome; inventing numbers is not.
4. **Respect the safety classes.** New actions must be registered in `packages/core/src/policies.ts` with an honest class. Conservative default: unregistered = HIGH_RISK.
5. **Golden rules are load-bearing.** If your change touches triage, healing, selection, or quality scoring, re-read `packages/core/src/golden-rules.ts` and the enforcement points named there.

## Development workflow

```bash
npm install
npm run build          # tsc -b (strict, project references)
npm test               # vitest across all packages
npm run benchmark      # fixtures corpus → benchmarks/agentic-qa/results.md
node packages/cli/dist/index.js doctor
```

- Node ≥ 18.17. TypeScript strict with `noUncheckedIndexedAccess` — treat it as a feature.
- CommonJS modules, 2-space indent, single quotes. JSDoc on every exported symbol.
- Tests live in `packages/<pkg>/test/*.test.ts`. New engines need table-driven tests including negative and boundary cases; new CLI commands need the `--json` envelope test.

## Adding a capability

| Adding | Must include |
|---|---|
| A core engine | Deterministic implementation + tests + a section in the matching doc + golden-rule check if it can modify tests |
| A skill (`skills/*/SKILL.md`) | All 13 sections (see any existing skill), bindings that reference real commands/tools, 180–260 lines |
| An MCP tool | Zod-free but validated input schema, plan-by-default semantics, error→isError mapping, tests via injected transport |
| A fixture | The 5-file contract (`README.md`, `EXPECTED.md`, `app/`, `tests/`, `evidence/failures.json`, `commits.json`), passing `scripts/validate-fixtures.js`, and a reachable expectation (walk the classify rules against your evidence strings) |
| A runner adapter | `detect`/`buildCommand`/`parseOutput` with parser tests using recorded real-world output shapes, secret-safe env allowlist |

## Pull requests

- One capability per PR; CI must be green (`npm run build`, `npm test`, fixture validation).
- Update `docs/` and the relevant skill when behavior changes — docs that lie are bugs.
- Update `CHANGELOG.md` under the next version heading.
- If your change alters a benchmark expectation, re-run the benchmark and include `results.md` output in the PR description. Expected-diagnosis changes need justification in the fixture's `notes`.

## Reporting bugs

Open an issue with: the command, `--json` output, the evidence bundle (scrubbed — `qa` already scrubs, but double-check), and what you expected. Security issues: see [SECURITY.md](SECURITY.md) — do not open public issues.
