---
name: qa-reporting
description: Renders quality evidence for four deliberately different audiences — engineering, QA, leadership, executive — with verification labels on every claim and honest "no data" where data is absent. Covers the md/json/junit/slack formats, JUnit XML for CI ingestion, Slack verdict colors, and report cadence per orchestration policy.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa report --audience engineering|qa|leadership|executive --format md|json|junit|slack"
  mcp: "generate_quality_report (audience + ReportData in, labeled markdown out)"
  core: "packages/reporting — renderMarkdownReport (labelPolicy: true required), toJUnitXml, toSlackPayload/colorForVerdict, renderConsoleSummary"
  channels: "Slack/email posting = notify.external (HIGH_RISK, --confirm-risk); JUnit XML = CI ingestion; console = raw-readable (the library never emits ANSI)"
---

# QA Reporting

## Purpose

Same evidence, four different truths: engineering needs the fix path, QA needs suite health, leadership needs confidence and risk, executives need a decision. `packages/reporting` renders each audience its own document — not one trimmed document — and enforces the label policy mechanically: `renderMarkdownReport` refuses to run without `labelPolicy: true`, because claims without verification labels are a policy violation. Where data is absent the report says so plainly ("no data", NOT_RUN, NOT_VERIFIED) instead of inventing content; a report that fabricates is worse than no report.

## When to activate

- At the close of any pipeline run (`pr`, `pre_merge`, `nightly`, `release`, `post_deploy` policies each have a natural report shape).
- A release decision is pending — the gate verdict must reach its audiences in their own language.
- CI needs machine-readable results — JUnit XML for native ingestion.
- A recurring digest is configured (nightly flake/triage/quality summary).
- Someone upstream asks for "the QA numbers" — first ask which audience they are.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `audience` | caller | yes | `engineering` \| `qa` \| `leadership` \| `executive` — selects a different renderer. |
| `format` | caller | yes | `md` \| `json` \| `junit` \| `slack` (plus the console summary for terminal output). |
| `events: TestEvent[]` | execution | for run reports | Status, duration, retryIndex, filePath, error message per event. |
| `gate: ReleaseGateResult` | release gate | for release/leadership/exec views | Verdict + reasons + blockingFindings + warnings + label. |
| `risk` / `selection` | risk + impact engines | recommended | Change risk with top contributors; selected/unaffected counts. |
| `triage` / `clusters` | triage engines | for engineering/QA | Root-cause hypotheses with confidence; deduplicated failure signatures. |
| `quality` / `suiteHealth` / `coverage` | quality + coverage engines | for QA view | Per-file deductions, 10-component suite score, weighted coverage + gaps. |
| `labelPolicy` | caller | MUST be `true` for markdown | The renderer throws otherwise — labels are not optional. |
| `url` | caller (Slack) | recommended | Link back to the full report or CI run. |

## Preconditions

- The data to report on exists as artifacts — events, gate results, engine outputs — or the report will render their absence honestly.
- Verification labels ride on every claim; the report never states a bare number without its provenance class.
- Nothing in the payload contains secrets or unmasked PII — scrubbing happens before rendering, and again before any external transmission.
- The console summary is rendered without ANSI (the library owns no colors); the CLI owns colorization.

## Decision rules

1. IF audience is `engineering` THEN the report contains: failing tests (name, testId, file, first error line, framework, duration, attempt number), triage root-cause hypothesis + recommended action + evidence pointers per failure, and change risk with top contributors; with no events provided it says "No execution events were provided — nothing to report (NOT_RUN)".
2. IF audience is `qa` THEN the report contains: weighted + raw coverage with critical-flow status and top gaps, failure deduplication clusters, per-file quality deductions, weak suite-health components (score < 60), selection counts, and event counts.
3. IF audience is `leadership` THEN the report contains: release verdict + warning count, critical/high risk with its explanation, the unclassified-failure backlog, and trends ONLY when historical data was provided — the renderer states their absence rather than inventing a trend.
4. IF audience is `executive` THEN the report contains: the verdict sentence ("This release is blocked by quality gate findings."), blockers, business-risk exposure, and an explicit decision line ("Proceed only after assigning owners to the warnings above.") — no jargon, no per-test lists.
5. IF a claim cannot carry its VerificationLabel THEN the report is invalid — `labelPolicy` must be true, and hand-written summaries pasted into PRs follow the same rule: CONFIRMED > OBSERVED > INFERRED > NOT_RUN > NOT_VERIFIED.
6. IF data for a section is absent THEN render "no data" / NOT_VERIFIED / NOT_RUN exactly as the renderers do — never fabricate a number to fill a section.
7. IF format is `junit` THEN map statuses honestly: failed → `<failure>`, timedout → `<error>` (JUnit has no native timeout), skipped and not_run → `<skipped>` (not_run distinguished by message "status: not_run"), durations in seconds with 3 decimals, suites grouped by filePath falling back to framework, all values XML-escaped with illegal control characters stripped.
8. IF format is `slack` THEN use `colorForVerdict`: PASS → 'good', PASS_WITH_WARNINGS → '#e2b203' (amber — warnings stay visible, not red), BLOCKED/FAIL → 'danger', UNKNOWN/no gate → '#808080' (grey — "we don't know" is its own color); include top reasons, first warning, first blocking finding; a missing gate renders "verdict unknown (NOT_RUN)".
9. IF the report posts to Slack, email, or Jira THEN that transmission is `notify.external` (HIGH_RISK): explicit confirmation required, and the payload is scrubbed of secrets/PII BEFORE posting — the report must not become the leak.
10. IF citing failing tests THEN attach or link their evidence bundles (`run-<date>/<testId>/`) so every claim is checkable — a report without pointers for its failures is INFERRED storytelling.
11. IF choosing cadence THEN map to policy: PR comment → selection + quality + risk (`pr`); nightly digest → flake + triage backlog + suite health (`nightly`); release report → gate verdict + blockers + all four audiences (`release`); post-deploy summary → event counts (`post_deploy`).
12. IF multiple audiences need the same run THEN render four documents from the same inputs — each renderer selects different fields; hand-merging one "universal" report serves none of them.

### Audience contract (what each renderer includes)

| Audience | Sections | Deliberately excluded |
|---|---|---|
| engineering | Failing tests, root cause & recommended action, change risk | Trend talk, business framing |
| qa | Coverage + gaps, failure dedup, test quality deductions, suite health, selection | Executive decision lines |
| leadership | Release confidence, critical risks, trends (or their honest absence), scope of testing | Per-test detail, stack traces |
| executive | Release readiness verdict, blockers, business risk exposure, decision | Everything above |

### Format matrix

| Format | Consumer | Key contract |
|---|---|---|
| md | Humans (PR comment, digest, release doc) | `labelPolicy: true`; labels inline; absent data stated, never filled |
| json | Agents and tooling | schemaVersion/data/label; claims carry their own labels |
| junit | CI servers | failed→`<failure>`, timedout→`<error>`, skipped/not_run→`<skipped>`; XML-escaped; re-parses round-trip |
| slack | Channels | Block Kit + colorForVerdict; transmission is `notify.external` — confirmation first |
| console | Terminal, cron mail, MCP text | No ANSI; readable raw; prints the no-data line when inputs are empty |

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Gather artifacts: events, gate result, risk, selection, triage, clusters, quality, coverage, bundle paths. |
| MODEL | The report input models (`MarkdownReportInput` / `ReportData`) define what can be said; anything outside them cannot appear. |
| PLAN | Choose audience(s), format(s), and cadence per orchestration policy. |
| GENERATE | Render via `renderMarkdownReport` / `toJUnitXml` / `toSlackPayload` / `renderConsoleSummary` — deterministic from inputs. |
| VALIDATE | Labels present on claims; absent sections say so; JUnit output re-parses (round-trip contract). |
| EXECUTE | Emit the artifact (PR comment, file, CI summary); external transmission may be HIGH_RISK (rule 9). |
| OBSERVE | Record what was sent where, with the link-back (Slack context block) for traceability. |
| TRIAGE | The engineering report's "recommended action" IS triage output — reports never editorialize root causes. |
| HEAL | Post-heal re-renders show before/after; never edit a published artifact — append corrections (golden rule 13). |
| VERIFY | Spot-check report numbers against artifacts: failing count, verdict, coverage figure. |
| MEASURE | Across digests: verdict trends, warning recurrence, dedup ratio — trend claims need retained history. |
| LEARN | `review_feedback` records for recurring readability complaints — improve renderers, never the data. |

## Anti-patterns

- One "universal" report for all audiences — leadership drowning in stack traces, engineering getting "quality is good".
- Dropping verification labels when copying report claims into slides or PR descriptions.
- Inventing trends from two data points, or filling the trends section with adjectives.
- Turning amber into red or green in Slack — the amber exists precisely so warnings stay visible.
- Posting to Slack without `--confirm-risk` or without scrubbing the payload first.
- Hand-editing JUnit XML to make CI green — the writer's mapping is the contract.
- A release report with no evidence-bundle pointers for its cited failures.
- Restating triage root-cause hypotheses as certainties, without confidence or label.
- Burying `blockingFindings` under warnings in the executive view — blockers lead there.

## Failure handling

- No events provided → renderers state NOT_RUN honestly; the console summary prints its no-data line; never an empty "all passed".
- Malformed event in the input → skip it and list the skip as a data-quality note; do not crash the whole report.
- Gate absent from an executive request → "No gate data was provided — readiness is UNKNOWN" (NOT_RUN).
- `renderMarkdownReport` throws on `labelPolicy !== true` → fix the call site, never the renderer.
- Slack delivery fails → the payload remains the artifact; record the delivery failure; a retry is a new transmission and a new confirmation.
- JUnit consumer rejects the output → validate the round-trip; escaping issues are renderer bugs to fix, not post-hoc patches.
- Two renderings disagree (console vs markdown counts) → re-render from the same input; divergence means different inputs were used.

## Evidence requirements

- Every claim carries its label; the markdown renderer prints the ordering line (CONFIRMED > OBSERVED > INFERRED > NOT_RUN > NOT_VERIFIED) at the top.
- Counts (failures, warnings, selected tests): OBSERVED from the arrays actually passed in.
- Root-cause hypotheses: carry their triage label + confidence — never restated as certainties.
- Absent sections: NOT_VERIFIED (no analysis provided) or NOT_RUN (nothing executed) — stated, not silently omitted.
- Evidence pointers (bundle paths) upgrade a claim to checkable; a failure cited without a pointer stays INFERRED for the reader.
- A report as a whole is NOT_VERIFIED if its inputs were never persisted as artifacts.

## Safety constraints

- Safety class: rendering is READ_ONLY (policy `report`); transmission to external channels is `notify.external` — HIGH_RISK, `--confirm-risk` required.
- Scrub before render and again before post: `scrubSecrets` for narratives, `maskObject` for structured payloads (golden rule 8).
- Golden rules engaged: 4 (labels = no verification claims without evidence class), 13 (published artifacts are never mutated — corrections are appended), 14 (explainable — the report shows reasons, not just verdicts), 9 (authorization for external sends).
- PII: audience views never include raw user data; user-shaped fields pass through masking before render.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "audience": "engineering",
    "format": "md",
    "artifacts": {
      "report": ".theqa/artifacts/report-2026-03-04-engineering.md",
      "junit": ".theqa/artifacts/junit.xml"
    },
    "claims": [
      { "claim": "3 failing tests in this run", "label": "OBSERVED" },
      { "claim": "root cause: selector changed in commit 2f1a9c4", "label": "INFERRED", "confidence": 0.86 },
      { "claim": "trend: failures down 40%", "label": "NOT_VERIFIED", "note": "no historical data provided — trend intentionally absent" }
    ],
    "gate": { "verdict": "PASS_WITH_WARNINGS", "warnings": 2 }
  }
}
```

`label` is the aggregate for the rendering pass; individual `claims[]` carry their own labels, mirroring what the rendered document shows inline.

## Examples

### Walkthrough 1 — release-day four-audience pack
The `release` pipeline finished: 1 blocked-by-regression run earlier today was fixed, this run passes with 2 warnings. The agent renders four documents from the same inputs: engineering (failing tests from the earlier run with fix path + evidence pointers, current change risk), QA (coverage 61.4%, one flake cluster, top quality deductions), leadership (verdict PASS_WITH_WARNINGS, no high/critical risk, warnings count 2), executive (verdict sentence, empty blockers list, decision line with owner-assignment condition). JUnit XML goes to the CI system (statuses mapped per rule 7). A Slack post to #releases uses the amber color after explicit `--confirm-risk` (rule 9), payload scrubbed, with the link-back context block. All four documents and the Slack payload land in `.theqa/artifacts/` — the release record references them.

### Walkthrough 2 — nightly digest with absent data
The `nightly` policy ran flake + triage but coverage analysis was not scheduled tonight. The QA-audience digest renders: "No coverage analysis was provided — coverage claims are intentionally absent (NOT_VERIFIED)." — the section exists and states its absence instead of disappearing. Flake section shows 2 suspect tests with scores; triage backlog shows 1 UNKNOWN (within budget, so no gate warning — the digest reports the fact, not a verdict). The trends section prints its standard honesty line: no historical trend data was provided, trend claims intentionally absent. The console summary appended to the cron mail renders the same inputs with no ANSI codes. Nothing was invented; the digest is still useful because absence is legible.

## Verification checklist

- [ ] The audience selector chose the correct renderer; no hand-merged universal report.
- [ ] Every claim in the output carries its verification label; `labelPolicy: true` was passed to the markdown renderer.
- [ ] Absent data rendered as "no data"/NOT_RUN/NOT_VERIFIED — nothing was invented.
- [ ] JUnit XML used the documented status mapping and re-parses cleanly.
- [ ] Slack colors followed colorForVerdict; UNKNOWN was grey, warnings amber.
- [ ] External transmission required and recorded --confirm-risk, and the payload was scrubbed first.
- [ ] Failing tests cited in reports link to their evidence bundles.
- [ ] Cadence matched the orchestration policy (PR vs nightly vs release vs post-deploy).
- [ ] Published artifacts were never mutated; corrections were appended.
- [ ] Spot-check passed: report numbers equal the underlying artifacts' numbers.
