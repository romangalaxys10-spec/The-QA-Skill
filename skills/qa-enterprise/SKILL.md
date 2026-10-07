---
name: qa-enterprise
description: All-in-one entry point to The-QA-Skill. Activate whenever a user asks for QA work — testing, risk, triage, healing, coverage, or release decisions — and this skill routes to the right specialist skills and commands.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings: ["all 16 qa CLI commands", "all 11 MCP tools", "Orchestrator.runIntent", "skills/qa-orchestrator"]
---

# QA Enterprise

## Purpose

This is the front door of The-QA-Skill. When any QA-shaped request arrives — "QA this PR", "are we safe to release", "these 87 tests are failing, what do I do", "write tests for checkout" — this skill turns the request into a governed engagement: it states what will be done, in which lifecycle order, with which evidence, under which safety constraints. It guarantees that no QA work happens as an unstructured burst of test-writing: every engagement walks the 12-phase lifecycle, produces labeled evidence, and ends with an honest, verifiable verdict. It exists so that an agent behaves like a QA organization — planning before executing, measuring before claiming, and never converting uncertainty into false confidence.

## When to activate

Activate when the user request is any of:
- "QA this PR" / "review this change for quality" / "what tests do we need for this change"
- "why are tests failing" / "triage these failures" / "is it a bug or a flake"
- "are we ready to release" / "is this safe to ship" / "what is blocking the release"
- "what is our coverage" / "where are the gaps" / "what should we test next"
- "fix the flaky tests" / "heal these selectors" / "clean up the suite"

Do NOT activate when the user wants something this platform does not own: implementing a product feature, fixing a build script, or writing application code. Route those to normal engineering work — this skill becomes relevant again when they ask whether it works.

## Inputs

| Input | Source | Required | Validation |
|---|---|---|---|
| Intent text | user message | yes | free text; `routeIntent` classifies it |
| Target repository | cwd or explicit path | yes | git repo for risk/impact commands; plain dir otherwise |
| Change range | `--range` flag, default `HEAD~1..HEAD` | no | valid git range |
| Project config | `theqa.config.json` | no | core configSchema (defaults applied) |
| Prior artifacts | `.theqa/` (context, artifacts, learning.jsonl) | no | read-only inputs to later phases |

## Preconditions

- Working directory is the project root (or pass the dir explicitly).
- For `qa risk` and `qa impact`: a git repository with at least the base commit present. If git is unavailable, those commands fail with exit code 2 — run `qa doctor` to confirm environment health first.
- `qa doctor` should pass with no FAIL checks before executing tests. WARN checks are acceptable if understood and recorded.
- If `.theqa/context.json` exists and is fresh (same HEAD), reuse it; otherwise re-run `qa discover`.

## Decision rules

1. IF the request is ambiguous about scope (whole repo vs one PR vs one feature) THEN ask one clarifying question before running anything — running the wrong pipeline costs more trust than one question does.
2. ALWAYS classify the intent first (routeIntent): pr_review, nightly, release, generate, triage, heal, discover, or explain. Announce the classification and the plan it implies.
3. ALWAYS walk the lifecycle in order. If a phase's precondition is unmet (e.g. EXECUTE before PLAN), stop and run the missing phase — the LifecycleTracker mechanically refuses, and so should you.
4. IF the change set is docs-only or test-only (check the routing hints in `qa impact`) THEN do not run product regression suites; state that explicitly with the routing hint as the reason.
5. IF risk tier is critical (payment/migration floors apply) THEN run full relevant regression plus E2E of critical flows and recommend the gate; never summarize the tier without quoting its factor reasons.
6. IF failures appear after execution THEN run triage before proposing any fix — never heal, skip, or delete based on raw failure text.
7. IF triage returns UNKNOWN for a failure THEN escalate to the human with the evidence bundle; do not guess, do not auto-heal, do not retry it into silence.
8. IF a healing proposal is MEDIUM or LOW tier THEN present it with evidence and wait for a human decision. Only HIGH-tier proposals with zero violations may auto-apply, and only with the learning store recording the effect.
9. IF the release gate says BLOCKED THEN surface the blocking findings verbatim; never soften BLOCKED into "mostly passing".
10. WHENEVER you state a conclusion, attach its label: NOT_VERIFIED, NOT_RUN, INFERRED, OBSERVED, or CONFIRMED. A claim without a label violates this skill.
11. IF any command would perform a HIGH_RISK action (production tests, external notifications, destructive data ops) THEN require explicit `--confirm-risk` or explicit user approval, and say so before running.
12. WHEN the engagement completes THEN append what was learned to the learning store (effect stated explicitly) and point the user at the evidence directory.

## Workflow

This skill owns MODEL (deciding the engagement shape) and coordinates every other phase:

| Phase | Role of this skill |
|---|---|
| DISCOVER | consume — `qa discover` (or reuse fresh `.theqa/context.json`) |
| MODEL | own — classify intent, choose specialist skills, set scope |
| PLAN | consume — `qa plan`, adjusted with routing hints from impact |
| GENERATE | delegate — skills/qa-test-generation when gaps exist |
| VALIDATE | delegate — skills/qa-test-review on any generated tests |
| EXECUTE | delegate — skills/qa-test-execution with the policy from intent (pr/nightly/release) |
| OBSERVE | delegate — evidence bundles written per failed test |
| TRIAGE | delegate — skills/qa-failure-triage |
| HEAL | delegate — skills/qa-test-healing (HIGH tier only auto-applies) |
| VERIFY | own — re-run affected tests after any heal; confirm with fresh evidence |
| MEASURE | delegate — `qa coverage`, `qa flake`, suite health |
| LEARN | own — record lessons with explicit effects; never silent behavior change |

Phases may be skipped only when the platform marks them skippable (e.g. GENERATE with no gaps, HEAL with no proposals) and the skip reason is recorded.

## Anti-patterns

- Answering "looks good to me" without a command having run — that is a NOT_VERIFIED claim dressed as verification.
- Jumping from "user asked for tests" to writing Playwright code without PLAN.
- Running the full suite because the risk tier is unknown — compute the tier instead.
- Treating a retry-pass as proof the failure was a flake when product code changed.
- Healing selectors without DOM evidence that the new selector exists.
- Reporting a green suite while ignoring skipped tests.
- Summarizing the release gate as "mostly green" when the verdict is BLOCKED.
- Bypassing the lifecycle because the change looks small — small payment changes are still payment changes; tier floors exist for exactly this reason.

## Failure handling

- **Command exits 2**: report stderr verbatim, run `qa doctor`, and propose the fix from the doctor output. Do not retry blindly.
- **Git unavailable for risk/impact**: state that risk scoring needs git history, offer `qa discover` plus static analysis only, and label all history-dependent conclusions NOT_RUN.
- **No tests found**: this is a finding, not an error. Report the coverage-gap story, propose generation via skills/qa-test-generation, and label coverage honestly including weight caveats.
- **Conflicting evidence** (assertion says regression, history says flaky): present both signals with polarity, keep confidence low, escalate. Never average away a contradiction.
- **Engagement interrupted**: record which phases completed in the learning store, mark the rest NOT_RUN, and hand back an honest partial result.

## Evidence requirements

- Every risk statement: the factor reasons array (OBSERVED from diff/history inputs).
- Every failure claim: an evidence bundle under `.theqa/artifacts/run-<date>/<testId>/` (metadata.json, console.log, network.json, failure.md).
- Every triage verdict: signals + contradicting signals + confidence + label per the classify engine.
- Every heal: proposal id, tier, policy checks, and backup path when applied.
- The final engagement summary: a verdict with label and the artifacts that back it. CONFIRMED requires OBSERVED evidence plus re-verification; anything less stays INFERRED.

## Safety constraints

- READ_ONLY (no confirmation): discover, plan, risk, impact, coverage, flake, report, doctor, explain, triage, test execution.
- LOW_RISK_WRITE: init, generate (never overwrites without --force), heal.apply.high-tier (with .pre-heal.bak backup).
- HIGH_RISK (`--confirm-risk` mandatory): test.production, db.migrate, external.systems, notify.external, deploy, prod.data.write, ci.security.change, test.delete.
- Golden rules binding here specifically: 4 (never claim verification without execution evidence), 9 (never destructive production actions without authorization), 14 (explain important decisions), 15 (optimize for signal, not test count).

## Output contract

Any command with `--json` returns exactly: `{schemaVersion: 1, command, ok, data, label}`. The engagement ends with a human summary in this shape:

```
QA REVIEW: HIGH RISK (Risk: 87/100)
+ payment logic changed (src/payments/charge.ts)
+ authentication boundary touched (1 file)
Tests: 42 selected (of 210) — 38 passed, 2 failed, 2 skipped
Triage: 2 REAL_REGRESSION (confidence 0.92) — evidence: .theqa/artifacts/run-2026-10-07/
Healing: 1 LOW-tier proposal (timeout increase) — not applied, review required
Coverage: weighted 71.2% — gap: src/payments/refunds.ts (payment, riskWeight 10)
→ Release recommendation: BLOCKED — blocking findings above; evidence attached.
```

## Examples

**Example 1 — "QA this PR"** (payment change):
1. routeIntent → pr_review. Announce: walking lifecycle for PR review.
2. `qa discover` → stack: typescript; playwright + vitest detected.
3. `qa impact --range origin/main..HEAD` → routing: payment-change triggered; 42 tests selected with per-test reasons; 168 unaffected.
4. `qa risk --range origin/main..HEAD` → Risk: 87/100 critical — reasons: payment logic changed; user-facing surfaces affected.
5. `qa test --policy pr` → 40 pass, 2 fail; bundles written.
6. `qa triage` → both failures REAL_REGRESSION 0.92 (deterministic assertion over changed code, domVerified true).
7. No heal proposals applicable; `qa release` → BLOCKED with the two testIds listed.
8. Report per the Output contract; learning store: type failure, effect "payment routing fired; 2 product defects found — risk model unchanged".

**Example 2 — "is it a bug or a flake?"** (one failing dashboard test):
1. routeIntent → triage. Ask for the failure record if none exists under `.theqa/artifacts`.
2. `qa triage --evidence artifacts/failures.json` → FLAKE 0.88: failed then passed on retry, no relevant product change, historically intermittent.
3. `qa flake --history recent-runs.json` → score 61 (flaky): 25% fail rate, 2 retries needed historically, failures across ci + local.
4. Recommendation: record in the flake registry; fix the nondeterminism (replace `waitForTimeout(3000)` with a web-first assertion); never hide via retries. Label INFERRED until the fix is verified by re-run.

## Verification checklist

- [ ] Intent classified and announced before any command ran
- [ ] Lifecycle order respected; every skip has a recorded reason
- [ ] Risk quoted with factor reasons, not a bare number
- [ ] Selected tests justified per test (reasons array present)
- [ ] Every failure carries an evidence bundle path
- [ ] Triage categories backed by signals + contradicting signals
- [ ] No heal applied below HIGH tier without human approval
- [ ] Release verdict quoted verbatim (BLOCKED never softened)
- [ ] Every conclusion in the summary carries a verification label
- [ ] Learning store entries written with explicit effect text
