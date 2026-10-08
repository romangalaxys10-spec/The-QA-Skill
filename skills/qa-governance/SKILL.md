---
name: qa-governance
description: Governs what the platform and its agents may do — the ACTION_POLICIES safety registry, confirmation gates for HIGH_RISK actions, audit trails in the append-only learning store, and PII/secret handling at every enforcement point. Also owns adapter discipline against vendor lock-in, compliance mapping, and cost governance starting from the deterministic-by-default provider.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  core: "ACTION_POLICIES + classifyAction + requiresConfirmation + assertAuthorized(action, {confirmRisk}) (packages/core/src/policies.ts)"
  audit: "LearningStore.append — append-only JSONL at .theqa/learning.jsonl; every HIGH_RISK action + confirmation recorded with actor/effect"
  heal: "canApply (HIGH tier, zero violations) / applyProposal (.pre-heal.bak) / classifyDeletionRequest (always false)"
  config: "theqa.config.json integrations.* — integrations live behind interfaces; keys env-only"
  cli: "qa explain safety — surfaces every action's classification + rationale"
---

# QA Governance

## Purpose

Governance is who may do what, what gets recorded, and what never happens — enforced by code, not memos. The platform's mechanical floor is the ACTION_POLICIES registry: every action is classified READ_ONLY, LOW_RISK_WRITE, or HIGH_RISK; HIGH_RISK requires an explicit confirmation flag; unknown actions classify conservatively (HIGH_RISK unless read-shaped). Above that floor sit the audit trail (the append-only learning store), PII/secret enforcement points, the healing approval workflow, adapter discipline against vendor lock-in, and cost governance that starts at zero because the default reasoning provider IS deterministic.

## When to activate

- Before any operation with side effects — classify first (`classifyAction` / `qa explain safety`), act second.
- Wiring a new integration (GitHub, GitLab, Jira, Slack, Allure, BrowserStack, ZAP, k6) — adapter discipline review.
- A HIGH_RISK action is about to run — confirmation, then audit record.
- Healing proposals await action — the approval workflow decides who may apply what.
- Compliance questions (SOC2 change management, GDPR data minimization) — map controls to code.
- Cost review — token spend per operation, deterministic-path coverage.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| Action name | caller | yes | Looked up in ACTION_POLICIES; unregistered names get the conservative default. |
| `confirmRisk` flag | human/authorized step | for HIGH_RISK | `assertAuthorized` throws without it; the flag is granted, never self-granted. |
| Actor identity | session/repo config | for audit | Who ran the action — recorded in the learning record payload. |
| Learning store | `.theqa/learning.jsonl` | yes | Append-only JSONL: `{id, timestamp, type, tags, payload, effect}` — the audit trail. |
| Healing proposal | heal engine | for approvals | Tier + `policyChecks` + `violations` decide who may apply it. |
| Integration targets | config | as needed | Reasoning providers, runners, reporting channels — all behind interfaces. |

## Preconditions

- Every action the platform can take is either registered in ACTION_POLICIES or consciously accepted as conservatively HIGH_RISK — extending the registry is a reviewed change.
- The learning store is append-only and writable; a governance system that cannot record is a governance system that did not run.
- Secrets live in env vars or constructor opts — never in `theqa.config.json`, fixtures, or artifacts.
- PII masking utilities (`maskValue`/`maskObject`) are available at every enforcement point (fixtures, artifacts, logs, reports).

## Decision rules

1. IF an action is not in ACTION_POLICIES THEN `classifyAction` defaults it: read-shaped verbs (read/inspect/list/show/get/diff/check) → READ_ONLY; everything else → HIGH_RISK "until registered" — registering a new action is a governance decision, not a convenience.
2. IF `classifyAction` returns HIGH_RISK THEN `assertAuthorized` throws without `confirmRisk` — and the flag must come from a human or an explicitly authorized approval step, never self-granted by the agent executing the action.
3. IF a HIGH_RISK action runs THEN an audit record is appended to the learning store with actor, action, effect, and the confirmation reference — the JSONL store is append-only, which is exactly what makes it an audit trail.
4. IF a healing proposal is MEDIUM or LOW tier THEN it requires human review — `canApply` auto-applies only HIGH tier with zero policy violations; inflating a tier to skip review is a governance violation.
5. IF a HIGH-tier heal auto-applies THEN it carries a `.pre-heal.bak` backup (`applyProposal` refuses without one) and a `healing_applied` record lands in the store; rejections record `healing_rejected` with the reason.
6. IF someone proposes deleting a test THEN `classifyDeletionRequest` never authorizes it (always false at the policy layer); deletion is `test.delete` = HIGH_RISK and demands strong recorded evidence (golden rule 7).
7. IF PII-shaped data flows toward an artifact, log, or report THEN masking runs at that enforcement point — masking at only one layer (e.g. reports) is not enforcement, because the raw data already landed upstream.
8. IF a secret is needed (API key, token) THEN it comes from env or constructor opts, is sent only in headers, and never appears in config files, request bodies, logs, or error messages — the provider tests assert this; governance keeps the assertion load-bearing.
9. IF an integration is added (GitHub, GitLab, Jira, Slack, Allure, BrowserStack, ZAP, k6) THEN it sits behind an interface/adapter — like `ReasoningProvider`, the runner adapters (`DefaultRunnerAdapter`, injected `SpawnFn`), and the reporting renderers — because direct SDK calls in business logic create vendor lock-in AND bypass policy checks.
10. IF LLM tokens are spent THEN the operation records usage; deterministic paths bypass LLM entirely — the default provider IS deterministic (`'gemini'` and `'local'` also map to deterministic), so cost governance starts at zero-by-default and every model call is a deliberate config choice.
11. IF compliance asks for evidence THEN point at mechanisms, not promises: SOC2 change management → git history + review policy + ACTION_POLICIES gates + the JSONL audit trail; GDPR data minimization → synthetic-by-default test data, masking at enforcement points, retention policy with owner, no production data in test systems without documented authorization.
12. IF governance and velocity conflict THEN the resolution is recorded (config change through review, learning record with effect) — never a silent bypass; "we were in a hurry" is a post-hoc excuse, not a policy.

### The action policy registry

| Safety class | Actions | Confirmation |
|---|---|---|
| READ_ONLY | discover, plan, risk, impact, coverage, flake, report, doctor, explain, test | none |
| LOW_RISK_WRITE | generate (new test files, no overwrite without --force), init, heal.apply.high-tier (only HIGH tier, zero violations, .bak written) | none |
| HIGH_RISK | db.migrate, test.production, external.systems, coverage.delete, ci.security.change, deploy, prod.data.write, notify.external, test.delete | `--confirm-risk` |

Every policy carries a human-readable `rationale` (surfaced by `qa explain safety`). The classification is deliberately conservative: production, external systems, and irreversible state are HIGH_RISK by construction.

### Compliance quick-reference

| Control area | Mechanism in this platform |
|---|---|
| SOC2 change management | Git history + review policy; ACTION_POLICIES gates destructive ops; learning store = append-only audit trail |
| GDPR data minimization | Synthetic-by-default data (factories + seeds), masking at enforcement points, owned retention policy |
| Access control (RBAC floor) | run tests = READ_ONLY; generate/heal-apply = LOW_RISK_WRITE (tier-gated); deploy/prod/notify = HIGH_RISK + human confirmation |
| Secret handling | env-only keys; header-only transmission; scrubbed artifacts; assertions in provider tests |
| Evidence custody | Append-only bundles; chain = event → bundle → learning record, each referencing the last |

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Inventory every action the platform/agent can take; map to ACTION_POLICIES; flag unregistered ones. |
| MODEL | The policy registry IS the model; rationale strings are user-facing artifacts (`qa explain safety`). |
| PLAN | For each planned operation, its safety class and confirmation needs are part of the plan. |
| GENERATE | Generated code/tests inherit the constraints: no secrets, no PII, no production writes. |
| VALIDATE | `assertAuthorized` at every boundary; pre-flight that confirmations exist for all HIGH_RISK steps. |
| EXECUTE | Perform actions; HIGH_RISK only with confirmation; append audit records as each action lands. |
| OBSERVE | The learning store grows; the audit trail stays queryable (`query` by type/tags, `summarize`). |
| TRIAGE | Governance incidents (unauthorized attempts, policy violations, scrubber misses) are first-class failures. |
| HEAL | Healing obeys the tier/policy gates; backups written; applied/rejected records appended. |
| VERIFY | Audit completeness check: every HIGH_RISK action this run has a record with actor + effect. |
| MEASURE | HIGH_RISK usage counts, MEDIUM proposals pending review, masked-field coverage, token spend per operation. |
| LEARN | Governance learnings: recurring MEDIUM proposals → automation candidates with review; repeated scrubber misses → new patterns. |

## Anti-patterns

- Self-granted `--confirm-risk` ("I confirmed with myself") — the flag authorizes; agents surface the need and stop.
- Treating the learning store as optional telemetry — it is the audit trail; skipping writes is destroying records.
- Registering a dangerous action as LOW_RISK to make automation smoother.
- Secrets in `theqa.config.json` "because env vars are annoying in CI".
- One-off integrations with direct API calls ("just this once") outside the adapter interfaces.
- Masking at the report layer only — raw PII already landed in artifacts upstream.
- A MEDIUM-tier heal applied because the human was offline.
- Deleting tests to make a gate pass — `test.delete` is HIGH_RISK and `classifyDeletionRequest` still says no.
- Free-tier LLM calls with customer data "to try something quickly" — `external.systems`, HIGH_RISK, full stop.
- Governance rules with no enforcement point — golden-rules.ts pairs every rule with its `enforcedBy`; a rule enforced by nothing is decoration.

## Failure handling

- `assertAuthorized` throws → the workflow stops; the error names the action, rationale, and required flag — never catch-and-continue.
- Audit write fails → the action did not officially happen: stop, fix the store, re-execute with confirmation; an unrecorded HIGH_RISK action is an incident, not a footnote.
- Masking unavailable (library failure) → block the artifact write; "temporarily unmasked" does not exist.
- Provider misconfigured (key missing) → the registry falls back to the deterministic provider with `fallbackUsed: true` — availability preserved, honesty preserved, cost stays zero.
- Two policy sources disagree (config vs registry) → the stricter classification wins until reconciled by review.
- Human override of a BLOCKED verdict → recorded as a learning record with effect + reviewer identity; the gate itself is never edited to encode the override.
- Integration vendor changes their API → the adapter interface absorbs the change; business logic and policy checks stay untouched — that is the point of the interface.

## Evidence requirements

- Every HIGH_RISK action: OBSERVED audit record (actor, action, effect, confirmation reference) — absence is a governance failure, not missing metadata.
- Policy classifications: OBSERVED — read from ACTION_POLICIES / `classifyAction`, never asserted from memory.
- Masking claims: OBSERVED with masked artifacts present; NOT_VERIFIED otherwise.
- "No secrets in artifacts": CONFIRMED only after a verification pass (scrub + grep) on this run's actual artifacts.
- Compliance mapping claims: INFERRED until traced to the enforcing code path — each control cites its mechanism.
- Token/cost figures: OBSERVED from provider usage fields; deterministic operations record zero.

## Safety constraints

- Safety class: this skill IS the safety layer — auditing is READ_ONLY; every other class is defined and enforced here.
- `--confirm-risk` is a human authorization signal for HIGH_RISK actions; agent workflows surface the need and stop — they do not confirm.
- Golden rules engaged (all 15 are governance-relevant; the load-bearing five here): 7 (never auto-delete tests), 8 (never expose secrets in artifacts), 9 (never destructive production action without authorization), 13 (preserve evidence — append-only audit), 14 (explain important decisions — every record carries an effect).
- RBAC boundaries: who may run/heal/deploy/read is an organizational decision; the platform enforces the mechanical floor (safety classes + confirmation), and org policy layers on top of it — never below it.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "action": "notify.external",
    "classification": {
      "safety": "HIGH_RISK",
      "rationale": "Posting to Slack/Jira/email reaches humans outside the loop.",
      "requiresFlag": "--confirm-risk"
    },
    "authorized": true,
    "confirmation": { "grantedBy": "release-manager:alice", "channel": "approval record lr-4f2a9b1c7d" },
    "auditRecord": {
      "type": "review_feedback",
      "tags": ["governance", "notify.external"],
      "effect": "release verdict posted to #qa-releases after explicit confirmation; payload scrubbed before send"
    }
  }
}
```

`authorized: false` outputs carry no audit record — only the refusal; the absence of a confirmation is itself recorded only when an attempt was made.

## Examples

### Walkthrough 1 — a MEDIUM-tier healing proposal meets the approval workflow
The healing engine proposes raising a timeout: tier MEDIUM (timeout raises are never HIGH tier — `changesAssertions`/`raisesTimeoutValue` checks keep them honest). `canApply` returns false: only HIGH tier with zero violations auto-applies. The workflow posts the proposal for human review and stops. The reviewer edits the proposal (fixing the underlying wait instead), which re-scores HIGH with zero violations; `applyProposal` applies it WITH the `.pre-heal.bak` backup and appends `healing_applied` (actor, effect). A second reviewer rejects a similar proposal outright — `healing_rejected` with the reason lands in the store, and `rejectedHealingsFor(testId)` will surface that history to any future proposal for the same test. No shortcut was taken; every step left a record.

### Walkthrough 2 — posting the release verdict to Slack
The release gate returns PASS_WITH_WARNINGS and the pipeline plan includes notifying #releases. Governance check: `classifyAction('notify.external')` → HIGH_RISK ("reaches humans outside the loop"). The workflow renders the Slack payload (amber color, scrubbed — no internal URLs bearing tokens), then STOPS and requests confirmation. The release manager grants it (recorded approval); `assertAuthorized` passes; the payload transmits; an audit record with actor + effect is appended. In the rejected branch — no confirmation — the workflow ends with the payload rendered but unsent: the artifact exists, the transmission did not happen, and that distinction is exactly what the audit trail is for.

## Verification checklist

- [ ] Every action this run was classified via ACTION_POLICIES / classifyAction — nothing ran unclassified.
- [ ] Every HIGH_RISK action had a human- (or authorized-step-) granted confirmation, never self-granted.
- [ ] Every HIGH_RISK action left an audit record with actor, effect, and confirmation reference.
- [ ] The learning store remained append-only; no records were edited or deleted.
- [ ] MEDIUM/LOW healing proposals went to review; only HIGH tier with zero violations auto-applied — with .pre-heal.bak.
- [ ] No test deletion was authorized by the agent, regardless of evidence quality.
- [ ] Secrets came from env only and appeared in no config file, log, body, or artifact.
- [ ] PII masking ran at every enforcement point (fixtures, artifacts, logs, reports), not just one.
- [ ] New integrations were added behind adapter interfaces, with policy checks on the platform side.
- [ ] Token spend per operation was recorded; deterministic paths were preferred where they suffice.
