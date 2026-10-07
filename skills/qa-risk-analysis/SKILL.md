---
name: qa-risk-analysis
description: Scores a change set with the documented 8-factor weighted risk engine — every factor carries explicit reasons, tier floors escalate payment/migration/auth/security changes, and the recommended test posture follows the tier. Activate on any diff range before planning test breadth, and whenever someone needs to argue about how much testing a change deserves.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa risk --range a..b --json · qa impact"
  mcp: "analyze_risk(root?, range?)"
  agent: "RiskAgent.assess(range)"
  core: "assessRisk(input, {weights?, thresholds?}) / renderExplanation / classifyArea"
---

# QA Risk Analysis

## Purpose

Risk converts "what changed" into "how much testing is justified". The engine computes `score = Σ(weight_i × value_i) × 100` over eight factors, each a value in [0,1] derived from observable signals (paths, churn, hotspots) WITH recorded reasons — the engine never emits a number without a "because". Default weights: businessCriticality 0.20, changeSurface 0.15, userImpact 0.15, defectHistory 0.12, integrationDepth 0.12, codeComplexity 0.10, securitySensitivity 0.08, dataSensitivity 0.08. Tiers: ≥80 critical, ≥60 high, ≥35 medium, else low — and documented tier FLOORS can raise (never lower) a tier regardless of score. The label is `INFERRED`: deterministic given its inputs, but the inputs are repository heuristics, not production measurements. This skill's job: read the assessment honestly, route on the tier, and never argue with a score without naming factor reasons.

## When to activate

- Any PR/branch assessment: `qa risk --range main...HEAD` before `qa plan` sizes the test breadth.
- Release triage: which changed areas demand full regression vs the fast suite.
- A dispute: someone says "it's a tiny change" about `app/payments/charge.ts` — the floor rules exist precisely for that argument.
- Config tuning: `theqa.config.json` risk weights/thresholds or `project.criticalPaths` changed.
- Feeding the release gate: `ReleaseGateInput.riskAssessments` consumes this output.
- Onboarding to an unfamiliar repo: the factor reasons are a guided tour of where a codebase keeps its danger.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `range` | CLI `--range` / MCP `range` | no | Git diff range, e.g. `a..b`, `main...HEAD`, `HEAD~1`; default `HEAD~1..HEAD`. |
| Changed files | `analyzeDiff(root, range)` | yes | `ChangedFile { path, status, additions, deletions, area, language, symbols }`; `classifyArea` order: auth → payment → db → api → config → test → docs → infra → ui → unknown. |
| Defect history | `churnHotspots(root)` | no | Normalized per-path churn proxy feeding the defectHistory factor. |
| `criticalPaths` | config `project.criticalPaths` | no | Path patterns that boost businessCriticality to ≥0.9 when hit. |
| Weights/thresholds | config `risk.*` | no | Must sum ≈1; the engine renormalizes honestly if not (recorded, not silent). |
| Result shape | engine output | — | `RiskAssessment { score 0..100 (1-decimal), tier, factors: RiskFactorValue[], topContributors, explanation, label: 'INFERRED' }`; each factor: `{ factor, value, weight, contribution, reasons[] }`. |

## Preconditions

- The repo is a git repo and the range resolves; otherwise the assessment is `NOT_RUN`, not zero.
- `modulesTouched` counts distinct containing directories of changed SOURCE files (test-shaped excluded; root files → one `(root)` module) — supply it, or complexity falls back to file count.
- Lifecycle: risk analysis powers `MODEL` (after DISCOVER) and is consumed by `PLAN`. It executes nothing and writes nothing.

## Decision rules

1. IF `businessCriticality` value ≥0.9 (payment patterns hit → 0.95, or configured criticalPaths matched → 0.9) OR `dataSensitivity` ≥0.9 (migration files present → 0.95), THEN tier is FLOORED to `critical` even if the weighted score says `low` — a 2-line payment change is never "low".
2. IF `businessCriticality` ≥0.8 (auth area touched → 0.85) OR `securitySensitivity` ≥0.85 (≥3 security-pattern hits: 0.6 + 3×0.1), THEN tier is FLOORED to `high`. Floors only raise: `ORDER.indexOf` comparison, never demote.
3. IF tier is `critical`, THEN the posture is the engine's own recommendation: "Run full regression of affected areas plus targeted E2E of critical flows before merge; require two reviewers."
4. IF tier is `high`, THEN: "Run expanded regression of affected areas plus high-value E2E of the changed flows before merge." Expanded means relevant suites beyond direct selection — justified per suite, not anxiety-driven.
5. IF tier is `medium`, THEN: "Run relevant regression of affected areas; E2E only for user-facing flows."
6. IF tier is `low`, THEN: "Fast PR suite (unit + lint) is sufficient; nightly suite covers the rest." Low is a decision, not a shrug — record it.
7. IF you argue about the score in ANY direction (accepting or contesting it), THEN name the factor reasons verbatim ("payment logic changed (app/payments/charge.ts)" — 0.95 × 0.20 = 19.0 contribution); a score contested without reasons is noise, and a score accepted without reasons is deference, not analysis.
8. IF the change surface is large (≥12 files or ≥800 churn lines saturate changeSurface to 1.0), THEN say so in breadth terms — surface alone never reaches critical without a floor or high-value factors, and that is the engine's documented intent, not a bug to work around.
9. IF weights in config do not sum to 1, THEN the engine renormalizes (divide by the actual sum) — the report must note the renormalization instead of silently presenting reweighted contributions as defaults.
10. IF a deliberate human override changes the tier or posture (e.g. "treat as high anyway — this module backs the Q3 launch"), THEN record it in the learning store: `LearningStore.append({ type: 'review_feedback', tags: ['risk-override', <tier>], payload: { range, score, engineTier, overrideTier, factorReasons }, effect: 'next planning for this area starts at <tier>' })` — overrides are decisions with owners, not silent score edits.
11. IF defect history is empty (no hotspots), THEN the defectHistory factor contributes 0 with reason "no defect history recorded for changed files" — that is honesty about missing data, not evidence of safety.
12. ALWAYS report `topContributors` (sorted by contribution) and the rendered `explanation` ("Risk: 91/100 (critical)" + up to 5 contributors with contribution ≥3, ≤2 reasons each + the action line) — the summary IS the audit trail.

### Factor mechanics (documented, auditable)

| Factor | Value derivation (documented signals) |
|---|---|
| businessCriticality | baseline 0.2; payment patterns → 0.95; auth area → 0.85; criticalPaths hit → 0.9; db area → 0.7 |
| changeSurface | min(1, files/12)×0.7 + min(1, churn/800)×0.3; floor 0.1 when files > 0; 0 when empty |
| defectHistory | max normalized churn hotspot among changed files |
| codeComplexity | min(1, churn/500)×0.6 + min(1, modules/10)×0.4 |
| integrationDepth | 0.5 + 0.15×integration hits (api clients, queues, webhooks, gateways), capped 1; else 0.1 |
| userImpact | 0.4 + 0.12×user-facing hits, capped 1; else 0.15 |
| securitySensitivity | 0.6 + 0.1×security-pattern hits, capped 1; else 0.05 |
| dataSensitivity | migrations → 0.95; else 0.5 + 0.1×persistence hits, capped 1; else 0.05 |

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Consumed: changed files come from the diff (its own DISCOVER pass). |
| MODEL | **Owned phase**: compute the assessment; tier is the model of the change's danger. |
| PLAN | Consumed: tier sets selection posture (policy expansion) and strategy breadth. |
| GENERATE | Consumed: critical/high tiers justify generation effort on affected areas. |
| VALIDATE | Sanity: every factor has ≥1 reason; floors applied before reporting. |
| EXECUTE | Not applicable. |
| OBSERVE | Not applicable. |
| TRIAGE | Consumed: tier contextualizes verdicts (critical-tier failures get priority triage). |
| HEAL | Not applicable. |
| VERIFY | Re-assess after fixes: a fix commit is a new range, never a memory of the old tier. |
| MEASURE | Track predicted-vs-observed: tiers that never catch anything are calibration data. |
| LEARN | Overrides and calibration notes recorded as review_feedback records (rule 10). |

## Anti-patterns

- Arguing the tier with adjectives ("this feels risky") instead of factor reasons — the reasons array is the only accepted currency.
- "Fixing" a low score on a scary change by inflating config weights: floors exist for payment/migration/auth/security; blanket weight inflation poisons every other assessment.
- Treating `low` as "skip testing": low means the fast PR suite, which still runs (golden rule 15 — signal, not zero).
- Reporting the score without `topContributors` — a bare number is not explainable and fails golden rule 14.
- Ignoring a floor because the weighted score was below the threshold: the floor IS the documented algorithm, not an exception to it.
- Reusing yesterday's assessment for today's push: a new range is a new assessment, always.
- Hiding a renormalization (rule 9) or a manual override (rule 10) — both are legal, neither is silent.
- Treating defectHistory's absence as "stable code": no history means unmeasured, factor 0 with the honest reason string.
- Scoring a range that mixes feature work with mechanical refactors and reporting one tier: split the range or name the dominant component — a blended tier misleads both postures.

## Failure handling

- Range invalid / not a git repo → surface the git error; never emit score 0/tier low as if the change were safe (`NOT_RUN`).
- MCP fallback path: when RiskAgent is unavailable, `analyze_risk` uses the core engine and reports `engine: 'core-fallback'` — the agent must state which engine produced the numbers.
- Empty diff (no changes) → score 0 is legitimate (changeSurface 0, all baselines reported); label it as "empty change set", not as safety.
- Config weights invalid → engine renormalizes; if that is unacceptable, fix the config and re-run rather than hand-adjusting factors.
- Huge range (hundreds of files) → assessment is still computed, but say that per-factor reasons were truncated in display and consider splitting the range.
- Test-shaped files dominate the diff → the complexity inputs exclude them from `modulesTouched` by design; do not inflate the tier for test-only churn — that is what routing's `testOnly` hint is for.
- Conflict between floor tier and score tier → the floor wins; report BOTH numbers ("score 42, tier floored to critical by dataSensitivity 0.95") so the escalation is auditable.
- `analyze_risk` returns an agent-normalized bundle whose shape fails validation → the handler falls back to core; the report names the engine actually used rather than assuming RiskAgent.

## Evidence requirements

- Factor values and reasons: `OBSERVED` as engine output (quote reasons verbatim); their correctness about reality (e.g. is that path really payment logic?) is `INFERRED` until a human or deeper read confirms.
- Tier: `INFERRED` — deterministic arithmetic over heuristic inputs, never `CONFIRMED` risk.
- Floor escalations: `OBSERVED` (the rule fired; both the score and the floor reason are in the output).
- Score: report the 1-decimal engine value; rounding it in prose is fine, altering it is not.
- Override records: the learning record id is `OBSERVED` evidence that the override happened; the override's wisdom is not evidence at all.
- "This change will/won't cause incidents": forbidden as evidence — the engine predicts testing breadth, not the future.

## Safety constraints

- Safety class: `READ_ONLY` (`ACTION_POLICIES: 'risk'` — "Reads diffs and history; computes scores").
- No `--confirm-risk` applies: risk analysis never executes tests, writes files, or contacts systems.
- Golden rules engaged: 9 (no destructive action without authorization — a critical tier never authorizes production testing by itself), 14 (explainable decisions — reasons per factor, explanation string in every report), 4 (labels stay honest: INFERRED, never upgraded).
- Overriding a tier (rule 10) is a recorded human decision; the agent must never present an overridden tier as the engine's output.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "INFERRED",
  "data": {
    "engine": "RiskAgent",
    "range": "main...HEAD",
    "assessment": {
      "score": 35.4,
      "tier": "critical",
      "factors": [
        { "factor": "businessCriticality", "value": 0.95, "weight": 0.2, "contribution": 19.0, "reasons": ["payment logic changed (app/payments/charge.ts)"] },
        { "factor": "dataSensitivity", "value": 0.95, "weight": 0.08, "contribution": 7.6, "reasons": ["database migration files present (1) — data-integrity tests required"] },
        { "factor": "changeSurface", "value": 0.2, "weight": 0.15, "contribution": 3.0, "reasons": ["3 files changed", "61 lines added/removed"] },
        { "factor": "userImpact", "value": 0.15, "weight": 0.15, "contribution": 2.3, "reasons": ["no user-facing surface detected in change set"] }
      ],
      "topContributors": ["businessCriticality", "dataSensitivity", "changeSurface", "userImpact"],
      "explanation": "Risk: 35/100 (critical)\n+ payment logic changed (app/payments/charge.ts)\n+ database migration files present (1) — data-integrity tests required\n+ 3 files changed\n+ 61 lines added/removed\n→ Run full regression of affected areas plus targeted E2E of critical flows before merge; require two reviewers.",
      "label": "INFERRED"
    },
    "changedFiles": [
      { "path": "app/payments/charge.ts", "status": "modified", "additions": 41, "deletions": 7, "area": "payment", "language": "typescript", "symbols": ["chargeCard"] }
    ]
  }
}
```

`data.assessment` mirrors core `RiskAssessment` (factors carry value/weight/contribution/reasons; the JSON shows the ≥3-contribution head of the list — all 8 are always computed); the MCP `analyze_risk` handler returns `engine` + `range` + assessment + changedFiles (+ routing), with `engine: 'core-fallback'` when RiskAgent was unavailable. Note the worked arithmetic: 19.0 + 7.6 + 3.0 + 2.3 + 1.9 (codeComplexity) + 1.2 (integrationDepth) + 0.4 (securitySensitivity) + 0.0 (defectHistory) = 35.4 — and the tier is STILL critical, because both floors fired on a score that thresholds alone would call medium.

## Examples

### Walkthrough 1 — small diff, floored to critical
`qa risk --range HEAD~1..HEAD` on a 2-file change to `app/db/migrations/2026_09_14_users_email_unique.sql` (+12/−0) and `app/db/users.ts` (+9/−4). Score computes to 28.4 (low by thresholds — businessCriticality 0.7 for the db area contributes 14.0, dataSensitivity 0.95 contributes 7.6), but dataSensitivity ≥0.9 → floor to `critical` (rule 1). The report shows both numbers, the floor reason, and the critical posture: full regression of db area + data-integrity tests + rollback path. The author's "it's a tiny migration" objection is answered with rule 7's currency: the migration reason string, not opinions.

### Walkthrough 2 — high tier with recorded override
Range `main...HEAD` touches auth middleware and two UI pages: score 66.3, auth floor keeps tier `high` (businessCriticality 0.85 ≥ 0.8). Posture: expanded regression of auth + affected UI, high-value E2E of the login flow. The team deliberately expands to full regression because this backs a compliance launch — recorded per rule 10 as a `review_feedback` learning record (`tags: ['risk-override', 'high']`, `effect: 'planning for app/http/auth starts at critical until launch'`). The next assessment for this area surfaces the override context instead of silently inheriting it.

## Verification checklist

- [ ] All 8 factors reported with value, weight, contribution, and ≥1 verbatim reason each.
- [ ] Tier floors were checked (payment/migration ≥0.9 → critical; auth ≥0.8 / security ≥0.85 → high) and escalations shown alongside the raw score.
- [ ] The recommended posture quoted the engine's tier action, not a paraphrase with more or less testing.
- [ ] Every score argument cited factor reasons; none cited adjectives.
- [ ] Any weight renormalization or deliberate override was recorded, with the override in the learning store.
- [ ] The label stayed `INFERRED`; no execution-evidence claims were attached to the score.
- [ ] Invalid ranges / empty diffs produced honest `NOT_RUN` or "empty change set" reports, not score 0 as safety.
- [ ] `topContributors` and the rendered explanation string appear in the report.
- [ ] A re-assessment was run for any new range instead of reusing a stale tier.
- [ ] Test-shaped churn was not used to inflate `modulesTouched` or the tier.
