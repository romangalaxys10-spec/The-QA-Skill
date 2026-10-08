---
name: qa-release-gate
description: Computes the release verdict with the platform's deterministic gate — the same decision table every time, from failedRealRegressions and triage confidence to coverage floors and evidence completeness. Never PASS on no data, never a hidden warning, never a BLOCKED without named findings.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa release --json"
  mcp: "evaluate_release (ReleaseGateInput in, ReleaseGateResult out)"
  core: "ReleaseGateInput / ReleaseGateResult {verdict, reasons, blockingFindings, warnings, label}; canonical engine computeReleaseGate (packages/reporting/src/verdict.ts)"
  config: "qualityGates {minWeightedCoverage: 60, maxCriticalFlakes: 0, blockOnRealRegression: true, maxUnknownTriage: 2}"
---

# QA Release Gate

## Purpose

The release gate is a deterministic function: same input → same verdict, every time. Its decision table lives in code (`computeReleaseGate` in `packages/reporting/src/verdict.ts`; the same rules power the orchestrator's local `computeGate` and the MCP `evaluate_release` surface), and this skill teaches the agent to compute it, read it, and communicate it without editorializing. The gate's central honesty rule: a gate with no data is UNKNOWN, never PASS — "we don't know" is a verdict, and inventing a green one is the single most expensive lie in software delivery.

## When to activate

- At the `VERIFY` phase of any pipeline that ends in a release decision (policies `release`, `pre_merge`).
- Before a human release meeting — the gate output is the agenda, not a suggestion.
- After healing or fixes — a stale verdict is never extended by hope; recompute.
- When leadership asks "can we ship?" — the gate answers from evidence or says UNKNOWN.
- When gate configuration (`qualityGates` in `theqa.config.json`) changes — re-run and diff verdicts.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `riskAssessments` | risk engine | for a meaningful verdict | Empty arrays are legal inputs — they mean "not assessed", not "no risk". |
| `triageResults` | triage engine | for regression blocking | REAL_REGRESSION results at confidence ≥ 0.9 block. |
| `flakeAssessments` | flake engine | recommended | Critical flakes drive a warning regardless of other results. |
| `coverage` | coverage engine | optional | Only `weightedCoverage < minWeightedCoverage` (default 60) triggers a warning; absent coverage warns about nothing — and says so. |
| `failedRealRegressions` | execution + triage | yes | Count of confirmed real-regression failures observed in `environment`. |
| `openUnknownCategories` | triage | yes | Triage results still UNKNOWN; compared against `maxUnknownTriage` (default 2). |
| `criticalFlakeCount` | flake engine | yes | Compared against `maxCriticalFlakes` (default 0). |
| `evidenceComplete` | caller attestation | yes | True only when all expected evidence exists; false forces any PASS down to PASS_WITH_WARNINGS. |
| `environment` | caller | yes | Recorded in blocking findings and reasons ("observed in environment 'ci'"). |

## Preconditions

- Inputs come from engines, not from memory: every number traces to a risk/triage/flake/coverage artifact of THIS change set.
- `qualityGates` are read from `theqa.config.json` (`minWeightedCoverage: 60`, `maxCriticalFlakes: 0`, `blockOnRealRegression: true`, `maxUnknownTriage: 2`) — thresholds are not negotiated mid-run.
- Evidence bundles exist for cited failures; `evidenceComplete = true` is an attestation backed by artifacts, not a mood.
- The gate never runs against a different commit than the evidence was collected for — stale inputs produce a stale verdict that looks fresh.

## Decision rules

1. IF the input is empty (no assessments, no triage, no flakes, no coverage, all counts 0) THEN the verdict is UNKNOWN with label NOT_VERIFIED — the gate refuses to invent a verdict from nothing; empty input is never PASS.
2. IF `failedRealRegressions > 0` AND `blockOnRealRegression` (default true) THEN verdict BLOCKED, and `blockingFindings` must name the regressions (count + environment) — real regressions block release.
3. IF any triage result is REAL_REGRESSION with confidence ≥ 0.9 THEN verdict BLOCKED and `blockingFindings` must carry that testId, confidence, and label — high-confidence regressions block regardless of counts.
4. IF real regressions exist but `blockOnRealRegression = false` THEN the finding is downgraded to a warning WITH the policy choice recorded ("recorded, not hidden") — a silent downgrade is forbidden.
5. IF `openUnknownCategories > maxUnknownTriage` (default 2) THEN warn: triage backlog required; unknowns at or under budget do not warn — the budget is the policy, not an oversight.
6. IF `criticalFlakeCount > maxCriticalFlakes` (default 0) THEN warn: flake repair required — a single critical flake already poisons suite signal.
7. IF coverage is provided AND `weightedCoverage < minWeightedCoverage` (default 60) THEN warn with both numbers stated.
8. IF `evidenceComplete = false` THEN warn "PASS would be downgraded to PASS_WITH_WARNINGS" — unverified claims must not read as a clean PASS (golden rule 4).
9. IF a subset of checks passed THEN never declare success on the subset — the verdict comes only from the full decision table; "coverage passed" is not a verdict.
10. IF the verdict is PASS_WITH_WARNINGS THEN the output must enumerate EVERY warning — a summarized verdict without its warning list is not auditable and not acceptable.
11. IF the verdict is BLOCKED THEN `blockingFindings` is non-empty, always — a BLOCKED verdict without named findings is unverifiable.
12. IF the verdict is communicated THEN adapt per audience (executives get the verdict sentence + decision line; engineers get reasons + findings) but NEVER soften BLOCKED to PASS_WITH_WARNINGS or drop warnings in transit.

### The verdict decision table (as implemented)

| # | Condition | Effect |
|---|---|---|
| 1 | Empty input (nothing assessed, executed, or counted) | UNKNOWN, label NOT_VERIFIED |
| 2 | `failedRealRegressions > 0` and blocking enabled | BLOCKED finding (count + environment) |
| 3 | Triage REAL_REGRESSION with confidence ≥ 0.9 | BLOCKED finding (testId + confidence + label) |
| 4 | `evidenceComplete = false` | Warning; forces PASS → PASS_WITH_WARNINGS |
| 5 | `openUnknownCategories > maxUnknownTriage` (2) | Warning |
| 6 | `criticalFlakeCount > maxCriticalFlakes` (0) | Warning |
| 7 | `coverage.weightedCoverage < minWeightedCoverage` (60) | Warning |
| 8 | Regressions with blocking disabled by policy | Warning ("policy recorded, not hidden") |
| 9 | Any blocking finding | verdict BLOCKED |
| 10 | Any warning (or evidence incomplete) | verdict PASS_WITH_WARNINGS |
| 11 | Otherwise | verdict PASS |

FAIL is deliberately NOT produced by the gate — it is reserved for post-human-review overrides downstream, which must be recorded with reviewer identity and reason. The gate label is honest about its nature: UNKNOWN → NOT_VERIFIED; observed failures or flakes present → OBSERVED; only triage/risk conclusions feeding it → INFERRED.

### Release checklist (run before presenting any verdict)

- Risk assessments are current — computed for this commit range, not last week's.
- Triage is current — every failure classified, or the unknown count is honestly within (or over) budget.
- Evidence bundles exist for cited failures (`run-<date>/<testId>/`) and `evidenceComplete` reflects reality.
- Gates come from config — `qualityGates` honored as committed; no inline threshold overrides.
- Environment recorded — reasons cite where the evidence was collected.
- Verdict, label, reasons, warnings, and blocking findings all render through the reporting skill, audience-appropriate.

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Gather gate inputs (risk, triage, flake, coverage, counts) from artifacts — none may be invented. |
| MODEL | `ReleaseGateInput` is the complete truth surface; anything not in it does not influence the verdict. |
| PLAN | Identify which policies (`pr`, `pre_merge`, `nightly`, `release`, `post_deploy`) evaluate the gate and with which configured gates. |
| GENERATE | — (the gate generates nothing; it is pure evaluation). |
| VALIDATE | Check input completeness BEFORE computing: failures without triage → `evidenceComplete = false`, stated honestly. |
| EXECUTE | `computeReleaseGate(input, opts)` — deterministic; same input, same verdict. |
| OBSERVE | Capture verdict, reasons, blockingFindings, warnings, and label verbatim. |
| TRIAGE | BLOCKED routes blocking findings back to triage/healing; UNKNOWN routes to evidence collection. |
| HEAL | After fixes, re-enter at EXECUTE — recompute; never carry a verdict forward across a material change. |
| VERIFY | Recompute after every material change and attach the recomputation to the release record. |
| MEASURE | Verdict trends per release; warning-category frequencies (triage backlog vs flake debt vs coverage debt). |
| LEARN | Record human overrides (a FAIL after review, an accepted PASS_WITH_WARNINGS) as learning records with effect + reviewer. |

## Anti-patterns

- PASS on empty or partial data ("CI was green" when nothing ran).
- Hiding warnings behind a summary ("passed with minor issues") without enumerating them.
- Treating PASS_WITH_WARNINGS as PASS because the release date is tomorrow.
- Overriding thresholds inline (`minWeightedCoverage` 60→30) to force a verdict instead of changing config through review.
- Reporting the verdict without its label — (OBSERVED) and (INFERRED) license very different trust.
- Re-running the gate until it says PASS (verdict shopping) — recompute only after inputs actually changed.
- Inventing FAIL — the gate never emits it; humans override downstream and record why.
- Relaying BLOCKED to leadership without `blockingFindings` ("blocked by quality issues" is not actionable).
- Computing the gate from stale inputs — last night's triage for this morning's commit is fiction with a verdict attached.

## Failure handling

- Coverage report missing → not an error: the gate proceeds without it (no coverage warning) and the report states coverage was absent (NOT_VERIFIED) — absence is visible, not silent.
- Malformed triage entries → surfaces handle defensively; report the malformed input rather than issuing a verdict built on guesses.
- Conflicting evidence (`evidenceComplete = true` but no bundles exist) → treat as false and say why; attestation without artifacts is NOT_VERIFIED.
- Two gate surfaces disagree (orchestrator-local vs reporting canonical edge behavior) → surface both outputs; the discrepancy is itself a finding — verdicts are never averaged.
- Someone demands `--confirm-risk` to "unlock" a PASS → refusal: the gate is READ_ONLY; confirmation flags unlock actions, never verdicts.
- Inputs arrive for a different commit than the current HEAD → stop; recollect evidence for the commit under decision.

## Evidence requirements

- The verdict: OBSERVED when computed by `computeReleaseGate` from captured inputs (the engine records "gate inputs: … (OBSERVED)" in its reasons).
- UNKNOWN: NOT_VERIFIED by definition — an unverifiable gate verifies nothing.
- Label semantics: OBSERVED only with observed failures/flakes or complete evidence; INFERRED when only triage/risk conclusions feed the verdict.
- Blocking findings: each names its evidence source — a triage testId with confidence, or an observed failure count with environment.
- "All checks passed": only when every input section was actually provided; otherwise the verdict is PASS_WITH_WARNINGS or UNKNOWN.
- Human overrides of gate verdicts: recorded learning records with reviewer identity and effect — an override without a record is a bypass.

## Safety constraints

- Safety class: READ_ONLY (policy `report`) — computing a gate mutates nothing.
- Acting on the verdict is a separate decision with separate policy: `deploy` is HIGH_RISK; `notify.external` (posting the verdict to Slack/email) is HIGH_RISK with `--confirm-risk`; the gate never auto-deploys or auto-announces.
- Golden rules engaged: 4 (no verification claims without execution evidence — the `evidenceComplete` mechanics), 10 (product defects vs test defects — only REAL_REGRESSION blocks), 13 (evidence preserved — bundles back the findings), 14 (explainable decisions — the reasons array is mandatory, not optional), 9 (no destructive action without authorization).
- The gate is never a backdoor: blocking disabled by policy remains a visible, recorded warning.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "verdict": "PASS_WITH_WARNINGS",
    "reasons": [
      "gate inputs: failedRealRegressions=0, openUnknownCategories=3, criticalFlakeCount=1, evidenceComplete=false (OBSERVED)",
      "3 unclassified failures exceed maxUnknownTriage=2 — triage backlog required",
      "1 critical flaky test(s) exceed maxCriticalFlakes=0 — flake repair required",
      "evidence incomplete — unverified claims force PASS downgrades to PASS_WITH_WARNINGS"
    ],
    "blockingFindings": [],
    "warnings": [
      "3 unclassified failures exceed maxUnknownTriage=2 — triage backlog required",
      "1 critical flaky test(s) exceed maxCriticalFlakes=0 — flake repair required",
      "risk-weighted coverage 54.2% is below minWeightedCoverage=60",
      "evidence incomplete — unverified claims force PASS downgrades to PASS_WITH_WARNINGS"
    ]
  }
}
```

`verdict` ∈ PASS | PASS_WITH_WARNINGS | BLOCKED | FAIL | UNKNOWN; `label` ∈ the five verification labels; `warnings` and `blockingFindings` are complete lists — never truncated in the artifact of record.

## Examples

### Walkthrough 1 — blocked by one high-confidence regression
Inputs for the `release` policy: one triage result REAL_REGRESSION at confidence 0.92 for `tests/checkout/cart.spec.ts::adds-item`, `failedRealRegressions = 1`, everything else clean, evidence complete. Rules 2 and 3 both fire → BLOCKED. `blockingFindings` carries the observed failure (environment 'ci') AND the triaged testId with its confidence and label. Communication: engineering receives the reasons plus the fix path from the triage report; the executive view renders "This release is blocked by quality gate findings" with the same blocker line — softened nowhere. The release record attaches the gate output; after the fix lands, the gate is recomputed from fresh inputs and only then may the verdict change.

### Walkthrough 2 — the honest UNKNOWN, then an earned PASS_WITH_WARNINGS
A new service: nothing executed, nothing triaged, all arrays empty, counts zero. The gate returns UNKNOWN / NOT_VERIFIED with its refusal reason. The release manager asks "can we call it good?" — the answer is no: no data, the gate refuses to invent. The checklist shows what is missing (risk, execution, triage, evidence). After the nightly run, triage, and flake assessment, recompute: no blocking findings, but two warnings (one critical flake, coverage 54.2% below 60) → PASS_WITH_WARNINGS with every warning enumerated. The decision line for the executive view: "Proceed only after assigning owners to the warnings above." Both warnings get owners before ship — the amber verdict stayed amber, not green.

## Verification checklist

- [ ] Empty or partial input produced UNKNOWN/PASS_WITH_WARNINGS — never a bare PASS without complete evidence.
- [ ] Every BLOCKED verdict has named blocking findings (testId or observed failure count + environment).
- [ ] Every PASS_WITH_WARNINGS enumerates all warnings, verbatim from the engine.
- [ ] Triage REAL_REGRESSION results at confidence ≥ 0.9 were treated as blocking regardless of counts.
- [ ] Thresholds came from `qualityGates` config, not from inline overrides.
- [ ] The verdict label (OBSERVED/INFERRED/NOT_VERIFIED) was computed and shown next to the verdict.
- [ ] No verdict was carried forward across a material change without recomputation.
- [ ] Any human override (FAIL after review) was recorded as a learning record with reviewer and effect.
- [ ] The release checklist (risk current, triage current, bundles exist, gates from config) ran before presenting the verdict.
- [ ] Audience-adapted communication softened nothing: BLOCKED stayed BLOCKED, warnings stayed enumerated.
