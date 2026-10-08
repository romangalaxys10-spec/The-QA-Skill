---
name: qa-orchestrator
description: Intent routing and lifecycle governance for The-QA-Skill. Activate when multiple QA concerns are in play and something must decide what runs, in what order, and what may be skipped.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings: ["Orchestrator.runIntent", "routeIntent", "core LifecycleTracker", "core ACTION_POLICIES", "qa CLI (all commands)"]
---

# QA Orchestrator

## Purpose

The orchestrator is the governance brain of The-QA-Skill: it converts an intent into a lifecycle-governed plan, routes each phase to the right specialist skill or command, enforces the safe-automation policy, and refuses shortcuts. Its core promise is structural, not aspirational: a test cannot execute before a plan exists, triage cannot run before observation, healing cannot run before triage, and a release verdict cannot exist without evidence — because the LifecycleTracker raises a LifecycleError on any phase-skipping attempt and the orchestrator surfaces that error as guidance rather than working around it. Where qa-enterprise is the front door for humans, the orchestrator is the execution spine that every other skill trusts to keep the process honest.

## When to activate

Activate when:
- A request spans multiple QA concerns (e.g. "run the PR suite, triage failures, and tell me if we can merge").
- You need to decide which skills/phases apply and in what order.
- You are about to run commands programmatically (CI job, agent loop, MCP client) and need the canonical ordering.
- A lifecycle violation was raised and you need to know how to recover.

Do NOT activate for single narrow operations that already encode their own workflow (a lone `qa risk` call does not need orchestration).

## Inputs

| Input | Source | Required | Validation |
|---|---|---|---|
| Intent text | user message / CI event / MCP tool args | yes | classified by routeIntent into: pr_review, nightly, release, generate, triage, heal, discover, explain |
| Run options | `{policy?, range?, dryRun?, confirmRisk?, json?}` | no | Orchestrator RunOptions |
| Config | theqa.config.json | no | core configSchema defaults |
| Spawner | injected SpawnFn (tests/CI) | no | dependency inversion — real spawner in production |

## Preconditions

- For intent kinds involving execution or diff analysis: a git repository and (for CI) a fetched base ref.
- `qa doctor` free of FAIL checks.
- Learning store path writable (`.theqa/learning.jsonl`) so LEARN can record effects.
- For release intent: at least one of (test evidence under `.theqa/artifacts`, live test run in this engagement) — otherwise the gate returns UNKNOWN by design.

## Decision rules

1. ALWAYS run routeIntent first and announce: kind + the planned steps + the policy (pr/pre_merge/nightly/release/post_deploy).
2. NEVER skip mandatory phases: DISCOVER, PLAN, EXECUTE, TRIAGE, VERIFY, MEASURE. If information for a mandatory phase is missing, run the phase in its cheapest honest mode (e.g. EXECUTE with dryRun, producing NOT_RUN events) rather than skipping it.
3. IF routeIntent returns pr_review THEN the plan is DISCOVER → MODEL (context+requirements) → PLAN → GENERATE (only if coverage gaps) → VALIDATE → EXECUTE (policy pr) → OBSERVE → TRIAGE → HEAL (only if proposals) → VERIFY → MEASURE → LEARN.
4. IF the kind is release THEN append gate computation (computeGate) and require evidenceComplete handling: missing evidence downgrades PASS to PASS_WITH_WARNINGS — never upgrades.
5. IF the kind is heal THEN TRIAGE must have run for the same failure set first (same evidence ids); healing without a triage classification is forbidden.
6. IF any step classifies HIGH_RISK under ACTION_POLICIES THEN check `confirmRisk` before dispatch; without it, stop with the policy rationale and the required flag name.
7. IF two routing hints conflict (e.g. css-only and payment both detected — impossible by construction but possible via config) THEN the more restrictive hint wins and the conflict is recorded.
8. IF a phase fails (command exit 2) THEN block downstream phases, record the block reason in the lifecycle snapshot, and return a partial PipelineResult with label NOT_RUN for everything blocked — never fabricate completion.
9. WHEN the same intent re-runs within one session THEN reuse the fresh context (same HEAD) but re-derive risk and selection — the diff may have changed under you.
10. IF the user overrides a decision (e.g. forces full suite on a docs-only change) THEN comply, but record the override and its rationale in the learning store (type review_feedback) — silent overrides are forbidden.
11. ALWAYS return the lifecycle snapshot in the result so callers can audit which phases ran, completed, skipped, or were blocked.
12. IF intent text mentions production smoke or deploy-related testing THEN classify HIGH_RISK regardless of phrasing and demand explicit confirmation.

## Workflow

The orchestrator owns PLAN-of-PLAN: it is the only component allowed to reorder or skip non-mandatory phases, and it does so only through recorded reasons.

| Phase | Orchestrator behavior |
|---|---|
| DISCOVER | dispatch `qa discover` / DiscoveryAgent; cache context keyed by HEAD |
| MODEL | build QAContext (application, requirements, changedFiles, knownFlakes) |
| PLAN | derive step plan from intent kind + routing hints; state policy |
| GENERATE | dispatch only when selection summary reports a coverage gap |
| VALIDATE | dispatch ReviewAgent on generated files before EXECUTE |
| EXECUTE | dispatch ExecutionAgent with the policy; dryRun honored as NOT_RUN events |
| OBSERVE | verify evidence bundles exist for every failed event; else OBSERVE incomplete |
| TRIAGE | dispatch TriageAgent; require classification before HEAL |
| HEAL | dispatch HealingAgent; HIGH-tier only auto-apply; MEDIUM/LOW → human |
| VERIFY | re-run affected subset after any applied heal; mark CONFIRMED only with new OBSERVED evidence |
| MEASURE | dispatch coverage/flake/quality measurement; assemble engagement metrics |
| LEARN | write learning records with explicit effect; refuse silent completion |

## Anti-patterns

- Running EXECUTE because "PLAN is obvious" — the tracker will refuse and so must you.
- Treating LifecycleError as a bug to catch-and-ignore instead of the guidance it is.
- Merging TRIAGE and HEAL into one step "to save time" — healing without classification is how regressions get healed into passes.
- Skipping MEASURE because the suite passed — a passing suite with unknown coverage and unknown flake state is not measured.
- Running release gate on stale evidence (different HEAD) without relabeling it.
- Letting the caller pass `confirmRisk: true` implicitly via defaults — it must be an explicit act.
- Collapsing the lifecycle snapshot to a boolean "done" in reports.

## Failure handling

- **LifecycleError raised**: parse the unmet phase list, run the earliest unmet phase, retry once; if it fails again, return the snapshot with the block reason.
- **Intent unclassifiable**: default to discover + explain with a stated rationale; ask the user one question; never guess into generate/heal.
- **Execution spawner fails**: mark EXECUTE blocked (not failed), label affected conclusions NOT_RUN, continue with MEASURE of whatever evidence exists.
- **Gate input empty**: verdict UNKNOWN with reason "no evidence" — never PASS.
- **Interrupted mid-pipeline**: persist the lifecycle snapshot (JSON) so a resume can continue instead of restarting.

## Evidence requirements

- The PipelineResult carries: lifecycle snapshot (PhaseRecord[] per phase with startedAt/completedAt/note), every engine output with its label, and the intent rationale.
- Every skipped phase: a note (string) — the platform forbids silent skips for mandatory phases and the orchestrator forbids them for all phases.
- Every HIGH_RISK dispatch: the policy entry (action, safety, rationale) echoed into the result.
- LEARN records: id, type, tags, and effect — auditable in `.theqa/learning.jsonl`.

## Safety constraints

- The orchestrator never writes product or test files itself; it dispatches (LOW_RISK_WRITE belongs to generate/heal skills).
- HIGH_RISK dispatches require `confirmRisk: true` in RunOptions — enforce locally even if core assertAuthorized is bypassed by a custom spawner.
- Dry-run is the default for MCP-originated run_tests intents; the orchestrator only honors dryRun:false when the call is CLI/CI-originated or the caller explicitly confirmed.
- Golden rules binding here: 2 (never hide a regression behind retries — retry policy comes from config, not ad hoc), 4 (never claim verification without execution evidence), 13 (preserve evidence — snapshot before cleanup), 14 (explain important decisions — every routing and skip carries a reason).

## Output contract

`Orchestrator.runIntent(intent, opts)` returns PipelineResult:

```json
{
  "schemaVersion": 1,
  "data": {
    "intent": "qa this pr",
    "kind": "pr_review",
    "plan": [
      { "phase": "DISCOVER", "action": "qa discover", "status": "done" },
      { "phase": "PLAN", "action": "derive steps from routing hints", "status": "done" },
      { "phase": "GENERATE", "action": "skipped — selection summary reports no coverage gap", "status": "skipped", "note": "no gap" }
    ],
    "lifecycle": ["DISCOVER complete", "MODEL complete", "…"],
    "risk": { "score": 87.4, "tier": "critical" },
    "selection": { "selected": 42, "unaffected": 168 },
    "triage": [{ "testId": "…", "category": "REAL_REGRESSION", "confidence": 0.92 }],
    "gate": { "verdict": "BLOCKED", "blockingFindings": ["…"] }
  },
  "label": "OBSERVED"
}
```

`routeIntent("run the nightly and check flakes")` → `{ kind: "nightly", steps: [...12 phases...], rationale: "nightly keyword matched; flake analysis appended to MEASURE" }`.

## Examples

**Example 1 — PR review in CI** ( Orchestrator.runIntent("qa this pr", {policy: 'pr'}) ):
1. DISCOVER done (0.4s) → MODEL done (context: 210 tests, stack typescript) → PLAN done (policy pr).
2. Routing hint css-only detected on one commit → GENERATE skipped with note.
3. EXECUTE done (policy pr, 42 selected) → 2 failures → OBSERVE done (2 bundles) → TRIAGE done (2 REAL_REGRESSION).
4. HEAL completed as verified no-op (no HIGH-tier proposals) → VERIFY done → MEASURE done → LEARN recorded.
5. Result: gate BLOCKED, lifecycle snapshot all done/skipped-with-note, label OBSERVED.

**Example 2 — recovery from a lifecycle violation**:
1. An agent calls `qa test` directly in a fresh clone without discover/plan; the orchestrator intercepts the lifecycle preconditions.
2. LifecycleError: cannot enter EXECUTE before completing MODEL, PLAN, GENERATE, VALIDATE.
3. Orchestrator response: run DISCOVER → MODEL → PLAN (execution policy derived) → VALIDATE (nothing generated — skipped with note) → EXECUTE. Total overhead: seconds. The alternative — suppressing the tracker — is forbidden.

## Verification checklist

- [ ] routeIntent kind announced with rationale before dispatch
- [ ] All 12 phases present in plan/snapshot; mandatory ones never skipped
- [ ] Every skipped/blocked phase carries a note
- [ ] HIGH_RISK dispatches gated by explicit confirmRisk
- [ ] TRIAGE preceded HEAL for the same evidence set
- [ ] VERIFY re-ran affected tests after any applied heal
- [ ] Gate input emptiness produced UNKNOWN, not PASS
- [ ] LifecycleError handled as guidance (unmet phases run), never suppressed
- [ ] Learning records written with explicit effect
- [ ] Lifecycle snapshot included in the returned result
