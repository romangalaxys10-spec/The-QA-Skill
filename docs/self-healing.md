# Self-Healing

**Audience:** contributors and platform teams operating or extending the healing engine.
**Source of truth:** `packages/core/src/heal/tiers.ts` (tier computation, policy checks, selector candidates), `packages/core/src/heal/policy.ts` (application policy), `packages/agents/src/agents/healing.ts` (agent wrapper + learning records), `packages/core/src/golden-rules.ts` (rule enforcement map).
**Contract type:** `HealingProposal` and `ApplyResult` in `packages/core/src/types.ts`.

Self-healing converts a diagnosed failure (typically `SELECTOR_FAILURE`) into a *proposal* to repair a test. Proposals are confidence-tiered; only one narrow class — pure selector repair observed in the target DOM with untouched assertions and zero policy violations — is eligible for automatic application. Everything else is propose-only. The tier engine is deterministic: same candidate in, same proposal out.

## Tier definitions

`buildProposal(candidate: HealCandidate)` computes `tier` and `confidence` from the candidate and the policy checks below:

| Tier | Confidence | Eligibility (exact condition in `tiers.ts`) | Disposition |
|---|---|---|---|
| `HIGH` | **0.9** | `violations.length === 0` **and** kind is `selector` (`HIGH_TIER_KINDS`) **and** proposed selector observed in target **and** assertions unchanged | May be applied automatically by `applyProposal` (with backup + audit) |
| `MEDIUM` | **0.6** | `violations.length === 0` but not the HIGH shape — e.g. intent-preserving structural changes: locator-strategy swaps, data-construction changes | **Propose-only.** Review against the evidence before applying |
| `LOW` | **0.2** | Any violation present | **Do not modify.** Explain-only: the proposal exists to show what would be required; a human decides |

The `rationale` string is generated per tier and states the disposition verbatim; LOW proposals embed the violation list in the rationale. The proposal `id` is `heal-` + first 10 hex chars of SHA-256 over `testId|currentCode|proposedCode`.

## The mechanical policy checks

`buildProposal` runs five checks. Passes append to `policyChecks` (strings quoted below); failures append to `violations` — **any violation forces LOW tier**.

1. **Rule-1 assertion comparator — `changesAssertions(current, proposed)`.** Assertion-relevant lines are extracted with `/^\s*(?:await\s+)?(?:expect|assert|should)[^;]*;?\s*$/` from both sources. A difference in count or any differing line is a violation: `rule-1: assertion expressions differ — weakening detected`. Pass adds `rule-1: assertion expressions unchanged`.
2. **Rule-3 sleep detection.** If the proposal introduces `waitForTimeout|setTimeout|sleep(` where the current code has none: `rule-3: proposal introduces an arbitrary sleep`. Pass adds `rule-3: no new arbitrary sleeps introduced`.
3. **Skip/only/todo detection.** Introducing `.skip(|.only(|.todo(` disables the test: `proposal disables the test (skip/only/todo)`. Pass adds `no skip/only/todo introduced`.
4. **Timeout-increase detection — `raisesTimeoutValue(current, proposed)`.** Numeric timeout values (≥3 digits, matched via `/(?:timeout|TimeOut|testTimeout|setTimeout)\s*[(:=]\s*(\d{3,})/g`) are compared pairwise; any increase is a violation (`proposal increases a timeout — forbidden as first response`). If the count of timeout literals changed, any new value **> 10,000** counts as an increase. Pass adds `no timeout increase`.
5. **Selector-not-observed check (selector kind only).** A `selector`-kind candidate must supply `observedInTarget` (a DOM snapshot or source of truth containing the proposed selector). Missing → violation `proposed selector not observed in any target snapshot — would be guessing`. Present → check `proposed selector observed in target DOM snapshot/source`.

Evidence items are generated from the candidate's `signals` (kind `static_analysis`, label `OBSERVED`) plus one `dom_snapshot` evidence item when `observedInTarget` is present.

## Selector candidate generation from DOM snapshots

`selectorCandidatesFromSnapshot(snapshot, failedSelector)` generates repair candidates from a captured DOM snapshot in a fixed priority order (accessibility-first, matching the triage recommendation to prefer role/label locators):

1. **`data-testid` attributes** — first 5, emitted as `getByTestId('<id>')`.
2. **Semantic roles** — `<button|link|heading|textbox|checkbox>` tags, deduplicated, first 5, emitted as `getByRole('<role>')`.
3. **Accessible labels** — `aria-label` / `alt` values (3–60 chars), first 3, emitted as `getByLabel('<value>')`.

Candidates are deduplicated, the failed selector itself is excluded, and the list is capped at **8**.

## Proposal anatomy and evidence

`HealingProposal` (contract in `packages/core/src/types.ts`) carries everything a reviewer needs without re-running anything:

| Field | Content |
|---|---|
| `id` | `heal-<sha10>` over `testId|currentCode|proposedCode` — stable for an identical proposal |
| `testId`, `filePath`, `kind`, `description` | What is being repaired, where, and in what declared healing kind |
| `currentCode`, `proposedCode` | The exact fragments compared by the policy checks and verified at apply time |
| `tier`, `confidence` | `HIGH` 0.9 / `MEDIUM` 0.6 / `LOW` 0.2 (mechanics above) |
| `evidence` | One `static_analysis` `Evidence` item per candidate `signal`, plus one `dom_snapshot` item when `observedInTarget` was supplied — ids are `ev-<sha8>` of their content |
| `rationale` | Generated per tier; the LOW rationale embeds the violation list verbatim |
| `policyChecks`, `violations` | The exact pass/fail strings quoted in the checks table |

`HealingKind` is the five-value union `selector | assertion | data | timing | locator_strategy` (mirrored by the MCP tool's enum). Only `selector`-kind candidates can reach HIGH tier: for every other kind the selector-observation check is vacuously satisfied (`selectorObserved = true` for non-selector kinds), so a clean assertion/data/timing/locator_strategy change lands at MEDIUM and is propose-only by construction.

## Pipeline position

Healing consumes triage output and produces either a review artifact or a backup-and-patch:

```
triage (SELECTOR_FAILURE 0.9)  →  HealCandidate  →  buildProposal (tier + policy checks)
      →  HIGH: applyProposal (assertAuthorized → drift check → .pre-heal.bak → patch)  →  learning record
      →  MEDIUM/LOW: proposal surfaced for review (MCP propose_test_heal)              →  learning record
```

Inputs: the `HealCandidate` fields are `testId`, `filePath`, `kind`, `description`, `currentCode`, `proposedCode`, optional `observedInTarget` (DOM snapshot/source containing the proposed selector), and free-text `signals` from triage. `HealingAgent.propose` is a thin delegating wrapper over `buildProposal`; `HealingAgent.apply` delegates to `applyProposal` and records the outcome (below).

## applyProposal mechanics

`canApply(proposal)` is exactly `tier === 'HIGH' && violations.length === 0`. `applyProposal(proposal, root, { confirmRisk? })` then:

1. **Refuses non-HIGH tiers** with reason `tier <TIER> is propose-only (violations: <n|review required>)` — verified this session: a MEDIUM proposal returns `{ applied: false, reason: "tier MEDIUM is propose-only (violations: review required)" }`.
2. **Calls `assertAuthorized('heal.apply.high-tier', opts)`** — the action is `LOW_RISK_WRITE` in `ACTION_POLICIES`, so no `--confirm-risk` is needed; the guard exists so that if the classification ever changes, application fails loudly. Note `--confirm-risk` does **not** bypass `canApply`: confirmation only satisfies the safety-class gate, never the tier gate.
3. **Refuses missing files** (`target file missing: <path>`).
4. **Verifies the current fragment:** reads the file and requires `content.includes(proposal.currentCode)`. On mismatch it refuses with `source drifted — currentCode fragment no longer present; refusing blind patch` — blind patching over an already-changed file is never attempted.
5. **Backs up** the original to `<file>.pre-heal.bak` (parent dirs created as needed) — golden rule 13, *preserve evidence*: healing never rewrites history.
6. **Writes** the patched content (first occurrence of `currentCode` replaced by `proposedCode`) and returns `{ applied: true, reason: 'HIGH-tier heal applied with backup at <path>.pre-heal.bak', backupPath }`.

All steps verified by execution this session against a temp repo, including the drift refusal and the `.pre-heal.bak` backup.

## Propose-only discipline for MEDIUM/LOW

- The **MCP surface cannot apply at all**: the 11-tool catalog (`packages/mcp-server/src/tools.ts`) exposes `propose_test_heal` — *proposals only, never applies anything to the repository*. There is no apply tool; application happens only in code that deliberately calls `applyProposal` (e.g. `HealingAgent.apply` in an authorized workflow).
- MEDIUM proposals require a human review step against the recorded evidence; LOW proposals are explanations, not patches.
- `propose_test_heal`'s tool description states the discipline: HIGH may be applied after policy checks; MEDIUM and LOW always require human review; any golden-rule violation forbids application.

## The NEVER list

Enforced mechanically, not by convention:

| Never | Enforced by |
|---|---|
| Weaken an assertion | `changesAssertions` comparator → LOW tier; golden rule 1 |
| Delete a failing test | `classifyDeletionRequest` **always returns `{ allowed: false }`** — duplicates (evidence ≥ 3 + `duplicateOf`) get `recommend MERGE in a proposal; auto-delete requires human approval`; everything else `test deletion requires strong recorded evidence AND human approval (golden rule 7)`. Verified this session. |
| Raise a timeout as first response | `raisesTimeoutValue` → LOW tier; golden rule 3 context (sleeps/timeouts are never the first fix) |
| Heal a real regression into a pass | Triage classifies retry-passes over changed code as `REAL_REGRESSION` (see `docs/failure-triage.md`); healing a regression-shaped failure would require an assertion change, which is already forbidden by rule 1 |
| Introduce sleeps / skip / only / todo | Checks 2–3 above → LOW tier |
| Auto-delete anything | No code path performs deletion; the duplication engine only recommends (golden rule 7's `enforcedBy` in `golden-rules.ts`) |

## Learning-store records

`HealingAgent.apply` (`packages/agents/src/agents/healing.ts`) records every outcome when a `LearningStore` is present — nothing is silent:

- **`healing_applied`** — tags `['healing', kind, tier]`; payload `{ testId, proposalId, kind, tier, reason }`; effect names the patched file, test, kind, tier, and backup path, e.g. `patched tests/checkout.spec.ts for checkout-happy-path (selector, tier HIGH); backup at tests/checkout.spec.ts.pre-heal.bak`.
- **`healing_rejected`** — same shape; effect records the refusal reason, e.g. `proposal <id> for <testId> was NOT applied: source drifted — ...`.

Downstream, `store.rejectedHealingsFor(testId)` lets healing proposals check prior rejections before applying. The store is append-only JSONL (`.theqa/learning.jsonl` by default); see `docs/enterprise-governance.md`.

## Worked example: `.btn-checkout` → `getByTestId`

Scenario: a checkout CTA's test id was renamed in the diff; the e2e test fails with a locator timeout. Triage classifies `SELECTOR_FAILURE` (selector literal in diff, confidence 0.9).

DOM snapshot captured in the failure evidence bundle:

```html
<button data-testid="checkout-cta" aria-label="Proceed to checkout">Checkout</button>
<button>Cancel</button>
```

`selectorCandidatesFromSnapshot(snapshot, ".btn-checkout")` — verified output:

```
["getByTestId('checkout-cta')", "getByRole('button')", "getByLabel('Proceed to checkout')"]
```

(data-testid wins by priority; the role/label candidates are fallbacks for review.)

The heal candidate swaps `await page.click('.btn-checkout');` for `await page.getByTestId('checkout-cta').click();` while leaving `await expect(page.getByText('Order confirmed')).toBeVisible();` untouched, with `observedInTarget` set to the snapshot. Verified `buildProposal` output:

- `tier: HIGH`, `confidence: 0.9`, `violations: []`
- `policyChecks`: `rule-1: assertion expressions unchanged` · `rule-3: no new arbitrary sleeps introduced` · `no skip/only/todo introduced` · `no timeout increase` · `proposed selector observed in target DOM snapshot/source`
- `canApply → true`; `applyProposal` patches the file and writes `tests/checkout.spec.ts.pre-heal.bak` (verified).

If instead the proposal had swapped the assertion line for `toBeVisible({ timeout: 60000 })` or added a `waitForTimeout`, the corresponding violation would force tier LOW (0.2) and the proposal would be explain-only.

### Negative example: timeout raise → LOW

A `timing`-kind candidate that "fixes" a deadline failure by changing `timeout: 30_000` to `timeout: 90_000` (keeping everything else identical) trips `raisesTimeoutValue` (paired-value comparison, `90000 > 30000`): `violations: ['proposal increases a timeout — forbidden as first response']`, so tier LOW, confidence 0.2, rationale beginning `LOW tier: do not modify. Reasons: proposal increases a timeout — ...`. The proposal still has value — it documents the naive fix and the triage recommendation (*profile the slow step; use web-first auto-waiting; only then consider an explicit, justified timeout increase*) names the correct path — but no code path will apply it.

## Safety constraints recap

- `heal.apply.high-tier` is `LOW_RISK_WRITE` with rationale *"Applies only HIGH-tier healing proposals that passed every policy check; original file preserved as .bak alongside."* (`packages/core/src/policies.ts`).
- Tier `LOW` proposals must never be fed to `applyProposal` expecting success — the refusal is by design, and it is recorded.
- Healing never runs against production targets: `test.production` and `deploy` are `HIGH_RISK` actions in the same policy registry.

## Verification

- [ ] Tier table matches `buildProposal`: HIGH 0.9 (selector kind + observed + assertions unchanged + zero violations), MEDIUM 0.6, LOW 0.2 (any violation).
- [ ] The five policy checks and their exact `policyChecks`/`violations` strings match `tiers.ts`.
- [ ] `changesAssertions` extracts `expect|assert|should` lines and compares count + content; `raisesTimeoutValue` compares paired values and flags new values > 10,000 when the literal count changed.
- [ ] `applyProposal` order verified by execution: canApply gate → assertAuthorized → file existence → currentCode fragment verification → drift refusal (exact reason string quoted above) → `.pre-heal.bak` backup → patch.
- [ ] `--confirm-risk` cannot upgrade a MEDIUM/LOW proposal to applicable (`canApply` never consults the flag).
- [ ] The MCP catalog has no apply tool; `propose_test_heal` description states proposals-only discipline.
- [ ] `classifyDeletionRequest` returns `allowed: false` for every input shape (both branches quoted verbatim).
- [ ] `selectorCandidatesFromSnapshot` order data-testid → getByRole → getByLabel with caps 5/5/3, dedupe, total cap 8, failed selector excluded — verified output quoted above.
- [ ] Learning records: `healing_applied`/`healing_rejected` with tags, payload, and a mandatory `effect` string; `rejectedHealingsFor(testId)` queries them.
