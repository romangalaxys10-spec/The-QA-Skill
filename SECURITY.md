# Security Policy

## Reporting a vulnerability

Email the maintainers via the GitHub security advisory feature ("Report a vulnerability" on this repository) rather than opening a public issue. Include reproduction steps and affected versions. We aim to acknowledge within 72 hours and will credit reporters in the release notes unless anonymity is requested.

## Scope

In scope: the deterministic engines (`packages/core`), the MCP server (`packages/mcp-server`), the CLI (`packages/cli`), evidence handling (`packages/core/src/evidence`), secret scrubbing, and the CI templates. Out of scope: vulnerabilities in end-user projects, third-party model providers behind `ReasoningProvider`, and social engineering of the human approver in HIGH_RISK flows.

## Security model highlights

- **Secret hygiene**: artifacts are scrubbed before write (`Bearer` tokens, `ghp_*`, `sk_live_*`/`sk_test_*`, AWS keys, private keys); child processes receive an env allowlist, never the full environment; model API keys live only in environment variables and are never logged or embedded in error messages.
- **Safe automation**: every action is classified `READ_ONLY / LOW_RISK_WRITE / HIGH_RISK`; HIGH_RISK requires explicit `--confirm-risk`. Unregistered actions default to HIGH_RISK (fail closed).
- **MCP surface**: planning tools never write files; `run_tests` defaults to dry-run; file reads are root-bounded; tool failures become `isError` results, never process crashes.
- **Patching is governed**: only HIGH-tier healing proposals with zero policy violations apply, always with a `.pre-heal.bak` backup and a learning-store audit record; test deletion is never automatic.
- **Bounded parsing**: error messages truncate at 300 chars, stacks cap at 12 frames, file listings cap at 20,000 entries, regexes avoid nested quantifiers.

Full details: [docs/security.md](docs/security.md) and [docs/enterprise-governance.md](docs/enterprise-governance.md).
