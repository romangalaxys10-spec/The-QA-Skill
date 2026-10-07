---
name: qa-test-healing
description: Proposes confidence-tiered self-healing changes for broken tests under mechanical golden-rule checks, applying only HIGH-tier selector repairs that were observed in target evidence. Every apply leaves a .pre-heal.bak backup and a learning-store record; LOW tier explains and touches nothing.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa heal --evidence <file> [--apply] [--confirm-risk]"
  mcp: "propose_test_heal(candidate) — PROPOSALS ONLY, never applies"
  agent: HealingAgent
  core: "buildProposal(candidate) -> HealingProposal; applyProposal(proposal, root, {confirmRisk?}) -> ApplyResult"
---

# QA Test Healing

## Purpose

Repair broken tests mechanically, with the trust level of every proposal computed, not asserted. The tier engine (`buildProposal` in `packages/core/src/heal/tiers.ts`) runs golden-rule checks over the current/proposed code pair and assigns: **HIGH** (0.9) = pure selector repair, proposed selector observed in the target snapshot, assertions untouched, zero violations → auto-apply eligible; **MEDIUM** (0.6) = intent-preserving structural change → propose + human review; **LOW** (0.2) = anything touching assertion semantics, timeouts, skipping → explain only. Application (`applyProposal`) backs up the original as `<file>.pre-heal.bak` and refuses drifted sources.

## When to activate

- Triage returned `SELECTOR_FAILURE` with the selector literal present in the product diff (the canonical HIGH-tier setup).
- Triage returned `TEST_DATA_DEFECT` or a timing-shaped verdict where a structural, intent-preserving patch is conceivable (MEDIUM territory).
- A healing proposal exists from a previous run and must be applied or rejected with an audit trail.
- Post-heal `VERIFY`: re-execute the healed test and record the outcome in the learning store.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `candidate` | triage + evidence bundle | yes | `{ testId, filePath, kind, description, currentCode, proposedCode, observedInTarget?, signals[] }`. `kind ∈ selector \| assertion \| data \| timing \| locator_strategy`. |
| `observedInTarget` | DOM snapshot / source of truth | for HIGH | Text containing the proposed selector; missing ⇒ violation "would be guessing". |
| Evidence bundle | `run-<date>/<testId>/` | yes | The triage verdict and DOM evidence the proposal must be consistent with. |
| `--apply` | CLI flag | no | Without it, the skill proposes only. |
| `--confirm-risk` | CLI flag | no | Confirmation posture for high-risk applies (`assertAuthorized`); HIGH-tier heal itself is `LOW_RISK_WRITE` in ACTION_POLICIES (`heal.apply.high-tier`). |
| Learning store | `paths.learning` | no | `healing_applied` / `healing_rejected` records with explicit `effect` strings. |
| Proposal shape | engine output | — | `HealingProposal { id, testId, filePath, kind, description, currentCode, proposedCode, tier, confidence, evidence[], rationale, policyChecks[], violations[] }`; the id is a deterministic hash of testId+current+proposed. |

## Preconditions

- TRIAGE phase complete with a verdict that healing may address — NEVER heal a `REAL_REGRESSION` (0.92 or 0.75): the product is broken, not the test.
- The evidence bundle contains the DOM/snapshot state the proposal claims to be grounded in.
- `currentCode` must match the file on disk at apply time; the engine re-reads and refuses on drift ("refusing blind patch").
- A human is in the loop for anything below HIGH tier — the tier IS the review policy.

## Decision rules

1. IF triage classified the failure `REAL_REGRESSION`, THEN do not heal: a heal that greens a real regression is a false pass (the NEVER list). Fix the product change.
2. IF the proposal's tier is HIGH (kind `selector` + zero violations + `observedInTarget` present + assertions unchanged), THEN it may be applied automatically with backup — verify the proposed selector in the DOM evidence yourself before trusting the tier: the engine checked that it was observed; the agent checks that it is the RIGHT element (role/label matches the behavior the test pins).
3. IF the tier is MEDIUM (zero violations, structural change: locator strategy, data construction), THEN present `currentCode`/`proposedCode` + `policyChecks` + evidence to a human; apply only after explicit approval. MEDIUM is propose+review by definition.
4. IF the tier is LOW (any violation), THEN explain only: quote the violations ("rule-1: assertion expressions differ — weakening detected", "proposal increases a timeout — forbidden as first response", "proposal disables the test (skip/only/todo)", "rule-3: proposal introduces an arbitrary sleep") and stop. LOW proposals exist to document what a fix would require — never to be applied.
5. IF a proposed change would weaken an assertion, delete the failing test, raise a timeout as first response, or introduce skip/only/todo/sleep, THEN refuse regardless of tier claims — these are the mechanical violations the engine encodes, and the agent re-asserts them.
6. IF `canApply(proposal)` is false (tier ≠ HIGH or violations > 0) and `--apply` was requested, THEN report the refusal reason verbatim; do not downgrade to a "manual patch" that bypasses the tier system.
7. IF apply succeeded, THEN confirm the backup path (`<file>.pre-heal.bak`), re-run the test (VERIFY), and append the `healing_applied` record with its effect string; IF apply was refused or review rejected, THEN append `healing_rejected` — every decision lands in the learning store with an effect.
8. IF the same test accrues repeated `healing_rejected` records, THEN stop proposing: the test's intent and the product's behavior have diverged beyond selector repair — escalate to a test-review pass (this is what `store.rejectedHealingsFor(testId)` is for).
9. IF the proposal needs a new selector and none was observed, THEN generate candidates from the snapshot (`selectorCandidatesFromSnapshot`: up to 8 — `getByTestId` from `data-testid` attrs, `getByRole` from button/link/heading/textbox/checkbox tags, `getByLabel` from aria-label/alt) and re-propose with the chosen candidate as `observedInTarget` — a candidate is only usable once it is OBSERVED in target state.
10. IF deletion of the test is being considered instead of healing, THEN it is refused by policy: `classifyDeletionRequest` always returns `allowed: false` (golden rule 7 — deletion requires strong recorded evidence AND human approval; duplicates recommend MERGE in a proposal).

### Tier mechanics (mechanical, not judgment)

The tier is COMPUTED by `buildProposal` from checkable properties — the agent never assigns tiers by feel:

| Check | Failure becomes |
|---|---|
| Assertion expressions unchanged (line-level comparison of `expect/assert/should` lines) | violation: rule-1 weakening detected |
| No NEW `waitForTimeout`/`setTimeout`/`sleep(` introduced | violation: rule-3 arbitrary sleep |
| No new `.skip/.only/.todo(` | violation: test disabled |
| No timeout value increased (paired comparison; new >10000 values also flagged) | violation: timeout raise as first response |
| For kind `selector`: `observedInTarget` provided | violation: would be guessing |

ZERO violations + kind `selector` + selector observed + assertions untouched ⇒ **HIGH** (0.9). ZERO violations otherwise ⇒ **MEDIUM** (0.6). ANY violation ⇒ **LOW** (0.2) — the violations ARE the rationale string.

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Read the evidence bundle; locate the failing selector/assertion site. |
| MODEL | Restate the test's intent in one sentence — the invariant the heal must preserve. |
| PLAN | Choose tier expectations: which kind is this (selector vs structural)? |
| GENERATE | Build the candidate (current/proposed pair + signals). |
| VALIDATE | `buildProposal` runs golden-rule checks; tier + confidence are computed. |
| EXECUTE | Not applicable (no suites run here; VERIFY does that). |
| OBSERVE | DOM snapshot / source evidence grounding (`observedInTarget`). |
| TRIAGE | Verdict gates entry: SELECTOR_FAILURE/TEST_DATA_DEFECT/TEST_DEFECT in; REAL_REGRESSION out. |
| HEAL | **Primary phase**: propose → (HIGH: apply w/ backup) → (MEDIUM: review) → (LOW: explain). |
| VERIFY | Re-execute the healed test; a heal that does not green the test is reverted from the `.bak`. |
| MEASURE | Healing outcomes feed suite health; rejection trends feed review priorities. |
| LEARN | `healing_applied`/`healing_rejected` records with effect; rejected-healing density informs test quality work. |

## Anti-patterns

- Healing first, understanding later: a proposal built before stating the test's intent is a patch in search of a justification.
- Trusting tier HIGH without opening the DOM evidence — "observed somewhere in the snapshot" is not "observed as the element this assertion means".
- Weakening an assertion to green the run (`expect(res.total).toBe(50)` → `toBeGreaterThan(0)`): that is rule-1 violation territory and produces a test that protects nothing.
- Deleting a failing test instead of healing it — auto-deletion is refused by policy, always.
- Raising a timeout (5000 → 15000) as the first response to a timing failure: profile the slow step and use web-first waiting first; the engine flags ANY paired timeout increase.
- Applying a MEDIUM proposal because review is "slow today" — the tier is the policy, not a suggestion.
- Skipping the learning-store record: an applied heal without an effect record is invisible to the trend loop and indistinguishable from an untracked repo edit.
- Healing a REAL_REGRESSION because the fix is "just the selector" — if the selector changed because the flow changed, the test may be asserting obsolete behavior; that is a review decision.
- Re-proposing an identical candidate after rejection: the proposal id is deterministic from testId+code, so re-proposing without changing the approach is noise, and rejected-healing density is a signal the loop tracks.

## Failure handling

- Source drift (`currentCode` no longer in file) → apply refuses; re-derive the proposal from the current file; never hand-patch around the drift check.
- Backup write fails → abort the apply; writing the patch without the backup violates golden rule 13 (preserve evidence).
- Post-heal test still fails → restore from `.pre-heal.bak`, append `healing_rejected` with the failure effect, and return to triage — a wrong heal must not survive as a second defect layered on the first.
- Evidence bundle lacks a DOM snapshot → no `observedInTarget` ⇒ no HIGH tier; either collect the snapshot (re-run with trace) or propose MEDIUM with explicit human review.
- Learning store unavailable → proceed with the apply but state the audit gap explicitly in the output; do not fake a record.

## Evidence requirements

- Every proposal: `policyChecks[]` and `violations[]` quoted verbatim; evidence items are `OBSERVED`-labeled (`static_analysis` for signals, `dom_snapshot` for observed selectors).
- HIGH-tier applies: the `observedInTarget` grounding is mandatory evidence — a heal applied without it is by definition not HIGH tier.
- Apply results: `OBSERVED` (backup path + reason). Refusals: `OBSERVED` (the refusal reason is itself the evidence).
- Post-heal verification: the re-run event is the only basis for claiming the heal worked — `OBSERVED` from a real event, never assumed.
- Review rejections of MEDIUM proposals: record the human's reason in the `healing_rejected` payload; a rejection without a reason teaches nothing.
- Deletion requests: always `NOT_ALLOWED`; any claim that deletion was "approved" needs the recorded human approval to be shown (`CONFIRMED`), else it is `NOT_VERIFIED`.

## Safety constraints

- Safety classes: propose = `READ_ONLY`; apply HIGH-tier = `LOW_RISK_WRITE` (`heal.apply.high-tier` — only proposals that passed every policy check, original preserved as `.bak`); anything beyond (deletion, prod data, migration) = `HIGH_RISK` requiring `--confirm-risk` and human approval.
- `--confirm-risk` does not bypass the tier system: `assertAuthorized` gates HIGH_RISK actions; `canApply` gates application independently (tier HIGH + zero violations).
- Golden rules engaged: 1 (never weaken an assertion — mechanically checked), 3 (never fix with sleeps — new sleeps are violations), 7 (never auto-delete), 13 (preserve evidence — `.pre-heal.bak` + append-only records), 14 (explain decisions — rationale string on every proposal).

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "OBSERVED",
  "data": {
    "proposals": [
      {
        "id": "heal-9d8c7b6a5f",
        "testId": "checkout.spec:submits-order",
        "filePath": "tests/e2e/checkout.spec.ts",
        "kind": "selector",
        "tier": "HIGH",
        "confidence": 0.9,
        "currentCode": "await page.locator('[data-testid=submit-order]').click();",
        "proposedCode": "await page.getByRole('button', { name: 'Submit order' }).click();",
        "policyChecks": [
          "rule-1: assertion expressions unchanged",
          "rule-3: no new arbitrary sleeps introduced",
          "no skip/only/todo introduced",
          "no timeout increase",
          "proposed selector observed in target DOM snapshot/source"
        ],
        "violations": [],
        "rationale": "HIGH tier: pure selector repair with observed evidence and untouched assertions — safe to apply automatically."
      }
    ],
    "applies": [
      { "proposalId": "heal-9d8c7b6a5f", "applied": true, "reason": "HIGH-tier heal applied with backup at tests/e2e/checkout.spec.ts.pre-heal.bak", "backupPath": "tests/e2e/checkout.spec.ts.pre-heal.bak" }
    ],
    "learning": [ { "type": "healing_applied", "effect": "patched tests/e2e/checkout.spec.ts for checkout.spec:submits-order (selector, tier HIGH); backup at tests/e2e/checkout.spec.ts.pre-heal.bak" } ]
  }
}
```

`data.proposals[]` mirrors core `HealingProposal`; `applies[]` mirrors `ApplyResult`.

## Examples

### Walkthrough 1 — HIGH-tier selector heal, applied and verified
Triage returned `SELECTOR_FAILURE` 0.9: `[data-testid=submit-order]` was renamed in the product diff; the run's DOM snapshot contains `<button aria-label="Submit order">`. The agent states the intent ("click the order-submit control"), proposes a `getByRole('button', …)` patch with the snapshot as `observedInTarget`, and `buildProposal` returns HIGH/0.9 with five passed policy checks. Before applying, the agent confirms in the snapshot that the button is the submit control (not an adjacent cancel button with a similar label). `--apply` runs: file patched, backup at `checkout.spec.ts.pre-heal.bak`, `healing_applied` recorded. VERIFY re-runs the test — green — and the report carries the event as the only proof the heal worked.

### Walkthrough 2 — LOW tier: the engine refuses to touch a timeout
`api.spec:sync-large-catalog` times out; a naive proposal raises the per-test timeout from 5000 to 30000 and also relaxes `expect(rows).toHaveLength(1200)` to `toBeGreaterThan(100)`. `buildProposal` returns LOW/0.2 with violations: "rule-1: assertion expressions differ — weakening detected" and "proposal increases a timeout — forbidden as first response". The agent applies nothing, explains both violations, and routes the test to review: the catalog endpoint grew from 800 to 1200 rows and the sync now paginates — the right fix is a data-construction (MEDIUM) proposal that waits on the pagination promise and asserts the real 1200, presented to a human with the profiler output showing where the time went. The rejected LOW proposal and its reason land in the learning store as `healing_rejected`.

## Verification checklist

- [ ] Triage verdict was checked first: no REAL_REGRESSION entered the healing pipeline.
- [ ] The test's intent was stated in one sentence before any proposal was built.
- [ ] Tier HIGH was trusted only after the proposed selector was located in the DOM evidence AND matched the intended element.
- [ ] Every proposal's `policyChecks`/`violations` were quoted verbatim in the output.
- [ ] No assertion was weakened, no test deleted, no timeout raised, no skip/only/todo or sleep introduced.
- [ ] MEDIUM proposals waited for explicit human approval; LOW proposals were explanation-only.
- [ ] Applied heals have a `.pre-heal.bak` backup path in the output and a `healing_applied` learning record.
- [ ] Post-heal verification re-executed the test; failures restored the backup and recorded `healing_rejected`.
