---
name: qa-accessibility
description: Accessibility testing strategy for the 'a11y' layer — axe-core injection inside Playwright specs, WCAG 2.2 A/AA scoping, severity gating, and the synergy between accessible queries and resilient selectors. Automated scans find what is automatable; this skill also defines exactly what still requires human verification and how that gap is labeled honestly.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  - runners:playwright (axe-core injected in specs; results flow back as Playwright TestEvents)
  - core:quality ('accessibility' is one of the 17 scored quality dimensions)
  - core:triage (selector discipline; getByRole/getByLabel literals feed detectSelectorChange)
---

# QA Accessibility

## Purpose

Make accessibility checks a first-class, gated layer of the QA lifecycle instead of a one-off audit. The skill defines the practical split between what axe-core can catch automatically (DOM-derivable violations) and what only keyboard walks, screen-reader passes, and contrast-in-context checks can catch — and attaches WCAG 2.2 A/AA criterion references to every finding so triage, gating, and suppression are all evidence-based.

## When to activate

- A change set touches UI components, forms, navigation, or any markup rendered to users.
- You are asked to "add a11y tests", "fix axe violations", or "make CI check accessibility".
- A regression looks like a renamed accessible name or ARIA attribute (the platform ships a fixture for exactly this shape).
- You are building CI gates and need to decide which a11y severities block.
- A design-system component changes and every consumer surface inherits its accessibility behavior at once.

## Inputs

| Input | Source | Required | Notes |
| --- | --- | --- | --- |
| Pages/components under test | Playwright specs | yes | Inject axe-core per page or per component mount |
| axe-core ruleset | `withTags(['wcag2a','wcag2aa','wcag22aa'])` or equivalent | yes | Pin the tag set in the repo; do not rely on defaults |
| Diff of change set | `analyzeDiff` | yes | Establishes whether the failing component is in the change set |
| Known-false-positive list | repo docs | no | Each entry needs a written justification and review date |
| Keyboard/screen-reader protocol | manual checklist | no | Required for the manual half of the split |
| Evidence bundle | `writeEvidenceBundle` | on failure | DOM snapshot and console.log carry the violation JSON |

## Preconditions

- Playwright is detected (`@playwright/test` dependency or `playwright.config.*`); axe-core is an explicit project dependency, injected in specs (the platform parses Playwright output; it does not bundle axe itself).
- The axe ruleset tag set is pinned and versioned with the tests, so a rule update is a reviewed change, not a silent gate flip.
- Selectors in the suite prefer accessible queries (`getByRole`, `getByLabel`) — both for resilience and because those literals are what the triage engine's `detectSelectorChange` tracks.
- The change-set diff is available so `coversChangedCode` and `selectorChangedInDiff` can be computed.
- The audit scope per surface is written down: component-level audits for design-system primitives (fast, local, fixable once), page-level audits for composition effects (heading order, landmark nesting, focus order). The split is a decision, not an accident.
- The manual half is scheduled somewhere real: keyboard traversal and screen-reader passes need a named owner and a cadence, or they silently become "automated coverage" in reports.

## Decision rules

1. If an automated scan reports a critical or serious violation on a component covered by the change set → block; the finding must carry its WCAG 2.2 A/AA criterion reference (e.g. "color-contrast — WCAG 1.4.3") in the violation summary.
2. If a violation is a documented false positive (known axe limitation) → suppress only with a written justification naming the rule, the reason, and a review date; silent or blanket suppression is forbidden.
3. If tests reach elements via CSS/XPath where a role or label query exists → convert to `getByRole`/`getByLabel` first; accessible queries fail loudly when the accessible name breaks, which is itself an a11y signal.
4. If a test fails with a locator-wait signature (`TimeoutError ... waiting for getByLabel('Open settings')`) and that literal appears in the product diff → SELECTOR_FAILURE at 0.9: an accessible-name change broke the test; fix the name or update the query intentionally.
5. If the same locator failure occurs and the literal is NOT in the diff → confidence drops (rule 3 falls through to SELECTOR_FAILURE at 0.6 in the engine): inspect the DOM snapshot; either the product removed the name or the test was already stale.
6. If a contrast violation depends on runtime background (images, gradients) → the automated flag is INFERRED; a human in-context check upgrades it to OBSERVED or marks it a false positive with justification.
7. If component-level audits pass but page-level composition fails (heading order, landmark nesting) → fix at page level; component audits never compose transitively.
8. If keyboard traversal or screen-reader announcement is the question → run the manual protocol; the agent records it as a manual layer item and never auto-closes it from an axe result.
9. If the a11y suite cannot fit the PR window → schedule it on `pre_merge`/`nightly`, and keep the layer honestly NOT_RUN in the gate rather than skipping silently.
10. If a violation over changed code is deterministic → treat as a product regression (same rule-10 logic as functional failures); a11y regressions are regressions.
11. If a change only adds decorative imagery → assert it is hidden from the accessibility tree (empty alt / aria-hidden) at generation time; decoration is not an audit backlog item.
12. If a violation originates in a shared design-system component → fix the component once; per-surface suppressions of a shared component's violation are forbidden.

The automated vs manual split, concretely:

| axe catches (automated) | Humans catch (manual protocol) |
| --- | --- |
| Missing alt text, form labels, button names | Whether the flow makes sense through a screen reader |
| ARIA role/property validity, duplicate ids | Focus order in practice, visible focus under real use |
| Contrast against a static computed background | Contrast-in-context over images, gradients, animations |
| Landmark and heading structure presence | Keyboard traps in complex widgets, drag alternatives |
| Language attributes, viewport zoom allowances | Cognitive load, error-message clarity, timing pressure |

Every automated finding cites its criterion; every manual criterion is a checklist line with an owner — the table above is the boundary between the layer's two halves and the reason neither is claimed as the other.

## Workflow (12-phase lifecycle)

1. **DISCOVER** — inventory UI surfaces and existing a11y specs; confirm Playwright detection and axe dependency.
2. **MODEL** — map the change set to components; identify user-facing paths (`userImpact` factor) and the severity profile that should gate.
    Note which surfaces are component-scoped vs page-scoped so the audit split stays deliberate.
3. **PLAN** — choose component-level vs page-level audits per surface; define the severity gate matrix (below); state the manual protocol scope.
4. **GENERATE** — scaffold specs that inject axe-core, assert `violations` filtered to the pinned tag set, and use `getByRole`/`getByLabel` for all interactions.
5. **VALIDATE** — test-quality pass: every assertion checks the violations array with criterion refs, not just "axe ran"; no sleeps.
6. **EXECUTE** — run through the Playwright runner (`--reporter=json`); one TestEvent per attempt.
7. **OBSERVE** — on failure, capture the violations JSON, DOM snapshot, and console output into the evidence bundle.
8. **TRIAGE** — apply decision rules; locator-wait failures route through SELECTOR_PATTERNS with `detectSelectorChange` deciding 0.9 vs 0.6 confidence.
9. **HEAL** — selector healing may propose updated accessible-name queries; it may never suppress a violation to make a test pass (golden rule 1).
10. **VERIFY** — re-run green; false-positive suppressions reviewed; manual protocol results recorded with OBSERVED labels.
11. **MEASURE** — track violations-over-time per component and the quality dimension `accessibility` score for test files.
12. **LEARN** — record suppression decisions and healed selectors as learning records; feed recurring violation patterns back into generation templates.

### Severity mapping (the gate matrix the PLAN phase commits to)

| axe impact | Over changed code | Elsewhere | Gate behavior |
| --- | --- | --- | --- |
| critical | block | block | Release gate blocking finding |
| serious | block | warn + ticket | Merge blocked until fixed or justified |
| moderate | warn | backlog | Warning in report; tracked |
| minor | backlog | backlog | No gate; trend-monitored |

## Anti-patterns

- Treating "axe passed" as "the page is accessible" — axe catches the automatable subset only; keyboard and screen-reader behavior remain manual.
- Running a11y only as a pre-release audit — violations found months later are the most expensive kind; gate at PR level for changed surfaces.
- Suppressing violations by rule name globally — a suppression is always scoped to a page/component plus a written reason.
- Weakening an assertion from "zero critical violations" to "zero critical violations that we know about" without the false-positive list (golden rule 1).
- Writing tests with `page.locator('.btn-primary')` while the component has a perfectly good role and name — brittle AND blind to a11y breakage.
- Fixing a violation by hiding the element from the accessibility tree (`aria-hidden`) — this trades a finding for a worse, invisible one.
- Claiming CONFIRMED on manual WCAG criteria that nobody manually verified (golden rule 4).
- Auditing only the pages someone complained about — the surface list is the coverage map; cherry-picked audits fake gate compliance.
- Treating the axe score as a pass/fail oracle for judgment calls — axe reports what is computable; the human protocol exists for what is not.

## Failure handling

- Suite-level Playwright error → synthetic `__suite__` failure event; triage as CONFIGURATION_FAILURE.
- axe fails to inject (script load error) → NOT_RUN for a11y on that surface; the gate must not read it as passing.
- Violation JSON exceeds artifact size → store the summarized violations (rule id, impact, nodes count) plus full JSON path reference; never truncate silently.
- Deterministic failure over unchanged code → TEST_DEFECT path (stale expectation); verify against the current component contract.
- Manual protocol unavailable this cycle → record NOT_RUN for the manual scope; the automated half may still gate.
- Violations appear only at page level after component audits passed → composition defect; add a page-level audit for that surface so the class is caught by the suite next time.

## Evidence requirements

- Violations are evidence items (`kind: 'dom_snapshot'` or `'test_output'`) and must include: rule id, impact, WCAG criterion reference, selector of the first offending node, and the help URL.
- Labels: OBSERVED for captured violation JSON with artifacts; INFERRED for automated contrast flags pending in-context check; CONFIRMED only after human review (or manual protocol) is recorded; NOT_VERIFIED for findings awaiting triage; NOT_RUN for surfaces the scan never reached.
- Real fixture shape (fixture `a11y-regression`): a prop rename (`ariaLabel` → `label`) changes the accessible name, the spec's `getByLabel('Open settings')` times out on both attempts, the literal appears on both sides of the diff, and `domVerified` is true — triage returns SELECTOR_FAILURE at 0.9; the fixture's floor is 0.8 to force the harness to prove the diff signal was found.
- Suppressions are records too: appended to the learning store with type `review_feedback` and an explicit effect string.
- Gate math is explicit: the automated layer reports violations with severities and criteria; the release gate consumes classifications, not vibes — an unclassified a11y claim has no place in a gate input.

## Safety constraints

- `test` (running a11y suites) → READ_ONLY; `generate` (scaffolding specs) → LOW_RISK_WRITE; neither touches product state.
- Scanning a production URL → HIGH_RISK (`test.production`); requires `--confirm-risk`; prefer staging.
- Any integration that posts a11y reports to external systems (ticketing, chat) → HIGH_RISK (`external.systems`/`notify.external`); requires `--confirm-risk`.
- Golden rules in force: 1 (never weaken assertions, including violation filters), 2 (no retry-washing), 3 (no sleeps before axe runs — wait for real readiness), 4 (no unverified claims), 8 (secrets never in artifacts — a11y scans of authed pages must scrub session tokens from captured DOM/headers), 10 (product defect vs test defect distinction), 14 (explain the gate decision).

## Output contract

```json
{
  "schemaVersion": "qa.a11y.v1",
  "data": {
    "testId": "tests/settings.a11y.spec.ts::settings page axe audit",
    "layer": "a11y",
    "scan": { "engine": "axe-core", "tags": ["wcag2a", "wcag2aa", "wcag22aa"], "scope": "page" },
    "verdict": "REAL_REGRESSION",
    "confidence": 0.9,
    "violations": [
      { "ruleId": "button-name", "impact": "critical", "wcag": "WCAG 4.1.2",
        "selector": "button#save", "summary": "Button has no accessible name" }
    ],
    "suppressed": [],
    "manualScopePending": ["keyboard traversal of settings dialog"],
    "evidence": [
      { "id": "ev-9f8e7d6c", "kind": "dom_snapshot",
        "location": ".theqa/artifacts/run-2026-01-15/settings_a11y/dom.json",
        "summary": "DOM captured at failure; button rendered without accessible name",
        "collectedAt": "2026-01-15T10:12:00Z", "label": "OBSERVED" }
    ],
    "assumptions": ["axe tag set pinned in repo", "scan executed against staging"]
  },
  "label": "OBSERVED"
}
```

## Examples

**Walkthrough 1 — accessible-name regression caught as a selector failure.** A change renames a button component's prop from `ariaLabel="Open settings"` to `label="Open settings"`; the forwarding breaks, so the rendered button loses its accessible name. The a11y spec's `getByLabel('Open settings')` times out on both attempts. The literal `Open settings` appears on both sides of the diff, so `detectSelectorChange` is true and rule 4 fires: SELECTOR_FAILURE at 0.9. Action: fix the component to forward the accessible name (the real defect), re-run green, and keep the test's accessible query — it is doing its job.

**Walkthrough 2 — gating a page with a false positive.** A page-level audit reports `color-contrast` on a gradient hero. The component is in the change set, so rule 1 would block — but the automated value is INFERRED (runtime background). A human checks the rendered contrast in context (rule 6), confirms it passes, and records a scoped suppression with justification and review date. The suite goes green with the suppression visible in the output contract's `suppressed` array, and the learning store records the review. Nothing was silenced; everything is traceable.

## Verification checklist

- [ ] axe ruleset tags are pinned in version control, not left to defaults.
- [ ] Every blocking violation cites its WCAG 2.2 A/AA criterion.
- [ ] All suppressions are scoped, justified in writing, and carry a review date.
- [ ] Specs use `getByRole`/`getByLabel` wherever an accessible query exists.
- [ ] The automated-vs-manual split is explicit; manual criteria are labeled NOT_RUN until actually performed.
- [ ] Failures produced evidence bundles with violation JSON and DOM snapshots.
- [ ] Gate behavior follows the severity matrix; no severity was re-mapped after a failure to unblock a merge.
- [ ] Retry-passes over changed code were re-triaged, not accepted.
- [ ] Component-level and page-level audit scopes are written down per surface.
- [ ] Shared-component violations were fixed at the component, not suppressed per surface.
