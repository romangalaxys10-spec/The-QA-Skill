---
name: qa-visual
description: Visual regression discipline for the 'visual' test layer — baseline strategy, diff review, and flakiness controls for screenshot comparisons run through the Playwright runner. Every visual verdict cites its evidence bundle and no baseline is ever updated without a human confirming the change was intentional.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  - runners:playwright (framework 'playwright'; JSON reporter; one TestEvent per attempt)
  - core:evidence/bundle (screenshot.png and trace.zip copied into run-<date>/<testId>/)
  - core:triage (layer 'visual'; assertion-shaped deterministic failures → rule 10)
---

# QA Visual

## Purpose

Define how visual regression tests are authored, executed, triaged, and baselined inside The-QA-Skill. Visual tests assert what functional assertions cannot: rendered geometry, theme, and layout. That power is also their cost — every baseline is a frozen expectation that goes stale — so this skill's core rule is that pixels are evidence, never authority: a screenshot diff proves *that* rendering changed, and only a human decides whether the change was intended.

The skill exists because visual suites fail in a characteristic way: they fail correctly (the render really did change) while being wrong about blame (the change was intentional). Everything below — baselines as versioned artifacts, human-owned diff review, staleness-aware triage — exists to keep the signal while making the blame decision explicit, cheap, and recorded.

## When to activate

- A change set modifies UI components, layout, theming, or CSS (`ChangeArea 'ui'`), and rendering regressions would ship silently.
- A visual suite already exists (specs with screenshot comparisons, layer `visual` in the test inventory).
- You are asked to "add snapshot tests", "fix flaky screenshots", or "review this visual diff".
- A release gate flags visual failures and someone wants to bulk-update baselines — activate and apply the discipline below instead.
- Dark-mode, RTL, or responsive-breakpoint behavior shipped and rendering must be verified per matrix dimension, not per one lucky cell.
- A new design-system component lands and you must decide what (if anything) deserves a baseline before it ships.

## Inputs

| Input | Source | Required | Notes |
| --- | --- | --- | --- |
| Visual spec files | test inventory, layer `visual` | yes | Detected via `@playwright/test` dependency or `playwright.config.*` |
| Baseline matrix | per browser × device × viewport × theme | yes | One baseline per matrix cell; no borrowing across cells |
| Diff of change set | `analyzeDiff` | yes | Establishes `coversChangedCode` for triage |
| Dynamic-region list | config/model phase | yes | Regions to mask (clocks, avatars, counters) |
| Evidence bundle | `writeEvidenceBundle` | on failure | screenshot.png, trace.zip, metadata.json, console.log |
| Prior baselines | version control | yes | Baselines live in the repo, reviewed like code |
| Flake history | flake scorer records | no | Cells with prior visual flake get a determinism review before any baseline talk |
| Reviewer decision | PR review record | on diff | The human confirmation that upgrades a verdict to CONFIRMED |

Baseline matrix example (each cell is a committed file; a missing file is NOT_RUN):

| Browser | Viewport | Theme | Direction | Baseline |
| --- | --- | --- | --- | --- |
| chromium | desktop 1280×720 | dark | ltr | home-hero-desktop-dark-ltr.png |
| chromium | mobile 390×844 | light | rtl | home-hero-mobile-light-rtl.png |

The matrix is the coverage map: dark mode, RTL locales, and each responsive breakpoint are separate dimensions — a dark/RTL cell with no baseline is NOT_RUN, and mirroring or theme bugs are only catchable by the cell that renders them.

## Preconditions

- Playwright is installed and `playwright.config.*` exists; the runner is detected (`PlaywrightRunner.detect`).
- Baselines are committed and identifiable per matrix cell (browser, device, viewport, theme encoded in filename or path).
- Animations can be disabled and fonts are locally available or preloaded — otherwise the run is declared unstable before it starts, not after failures.
- The change-set diff is available so triage can relate failures to changed code.
- The spec declares which matrix cells it covers; spec-declared cells minus committed baselines is the gap list, reviewed per PR.
- Diff review is reachable: a named human or team owns baseline confirmation for each surface; anonymous or CI-owned approval does not exist.
- Artifacts directory is writable for evidence bundles; artifacts are untracked and append-only.

## Decision rules

1. If a visual failure is deterministic (fails on all attempts), assertion-shaped, and the test covers changed code → treat as a REAL_REGRESSION candidate (triage rule 10, confidence 0.92); block merge until the diff is reviewed against design intent.
2. If a visual failure reproduces but the test covers no changed code → triage lands on TEST_DEFECT (confidence 0.7); suspect a stale baseline or an always-wrong expectation; verify against the current spec before touching the baseline.
3. If a human reviewer confirms the diff shows an intentional change → update the baseline in the SAME pull request, with a written rationale next to the baseline file; never update baselines from CI output alone.
4. If the only differing region is a known-dynamic region (timestamp, avatar, ad slot) → fix the mask configuration; do not re-baseline, and do not widen masks to make noise disappear.
5. If the failure appears on exactly one browser/device/viewport cell and other cells are green → treat as a rendering-engine difference; verify that cell's own baseline exists before concluding anything.
6. If no baseline exists for a matrix cell → that cell is NOT_RUN for visual purposes; never borrow another cell's baseline as a substitute.
7. If a spec "stabilizes" screenshots with `waitForTimeout` or sleeps → reject it: the quality scorer's determinism dimension penalizes arbitrary waits (golden rule 3); disable animations and wait on real state instead.
8. If a diff needs human confirmation and no reviewer decision is recorded → the verdict stays NOT_VERIFIED; the agent never self-approves its own baseline update.
9. If visual suite runtime breaks the PR budget → move the matrix expansion to `pre_merge` or `nightly` orchestration; never delete coverage to save time (golden rule 15: optimize for signal, not test count).
10. If a visual test failed and later passed on retry with relevant code changed → retry does NOT wash it out (golden rule 2); re-run on a clean environment and re-triage.
11. If the product supports dark mode, RTL, or responsive breakpoints → each dimension gets its own baseline cells; a changed component that affects one breakpoint gets its breakpoint cell re-verified, not just the desktop default.
12. If a reviewer wants a smaller review surface → prefer component-level baselines for design-system primitives and page-level baselines for composition; smaller diffs carry clearer intent and review faster.

## Workflow (12-phase lifecycle)

1. **DISCOVER** — inventory visual specs (layer `visual`); confirm Playwright detection (package dep or config file).
2. **MODEL** — identify UI surfaces in the diff (`userImpact` factor rises on component/page/layout paths); list dynamic regions and matrix cells actually in use.
3. **PLAN** — decide which cells run on `pr` (smoke cell) vs `pre_merge`/`nightly` (full matrix); state the baseline-update protocol up front.
    Placement follows runtime: the smoke cell must fit the PR budget with headroom; everything else is scheduled, not squeezed.
4. **GENERATE** — scaffold visual specs with role/testid locators, one screenshot assertion per state, mask config for dynamic regions, animations disabled.
5. **VALIDATE** — run test-quality analysis: determinism dimension must be clean (no sleeps), assertionStrength must assert on the screenshot comparison itself.
6. **EXECUTE** — run through the Playwright runner (`npx playwright test --reporter=json`; retries only when the execution policy allows them).
7. **OBSERVE** — on failure, write the evidence bundle: screenshot.png, trace.zip, metadata.json (commit, branch, browser, retryIndex) under `run-<date>/<testId>/`.
    The bundle is written per attempt so retry history stays observable, not overwritten by the last try.
8. **TRIAGE** — apply the decision rules; the screenshot-diff error text is assertion-shaped, so deterministic failures over changed code classify REAL_REGRESSION at 0.92.
9. **HEAL** — only selector/locator healing proposals are admissible; healing may never "fix" a visual failure by accepting a new baseline.
10. **VERIFY** — human reviews the diff; intentional → baseline updated with rationale in the same PR; regression → product fix; re-run to green afterwards.
    Review outcomes are recorded per cell: one intentional change may leave sibling cells (dark/RTL/other breakpoints) still failing until reviewed separately.
11. **MEASURE** — flake score per visual test; track diff-noise rate (how often masks fail) and baseline staleness age.
12. **LEARN** — append learning records for healing applied/rejected and baseline updates (type `healing_applied`, `healing_rejected`, `review_feedback`) with explicit effects.

## Anti-patterns

- Auto-accepting every diff to get CI green — this converts the visual suite into a tautology (golden rule 1 in pixel form).
- Snapshotting whole pages at every cell "just in case" — massive redundant baselines maximize review cost and noise (golden rule 5's spirit at the visual layer).
- Cranking the diff threshold until tests pass — a budget loosened after a failure hides exactly the regression it existed for.
- Masking everything dynamic *and* everything that recently failed — masks must stay minimal and documented, or coverage silently shrinks.
- Borrowing or copying baselines between matrix cells — fabricates coverage that does not exist (the label would be a lie).
- Retrying visual failures until they pass — retries hide real rendering regressions (golden rule 2).
- Baseline updates committed by CI with no rationale — destroys the audit trail (golden rules 13, 14).
- Bulk baseline updates at release time — the rationale decays the moment it is separated from the diff that caused it.
- Reading only the diff image and skipping the trace — the trace.zip and DOM snapshot usually show WHY the layout shifted (font not loaded, missing container), which the pixel map cannot.
- Deleting a visual test because its surface is "covered by design review" — design review is not a regression gate; if the test exists it protects, and deletion needs the strong-evidence bar (golden rule 7).
- Storing baselines outside version control (shared drives, CI caches) — unreviewable, unrestorable, and invisible to the PR that must justify their change.

## Failure handling

- Missing baseline → cell reported NOT_RUN, never skipped silently; add the baseline in the same PR as the feature.
- Suite-level Playwright error before tests ran → the adapter emits a synthetic failed event (`__suite__`); triage as CONFIGURATION_FAILURE, not per-test noise.
- Flaky visual (intermittent diff) → suspect animations, web fonts, or viewport instability; fix determinism first, then re-measure with the flake scorer; quarantine only if recurrence blocks CI.
- Trace or screenshot artifact missing on failure → evidence is incomplete; the verdict stays INFERRED/NOT_VERIFIED and the release gate sees `evidenceComplete: false`.
- Baseline file corrupted or unparseable → treat as configuration failure; restore from version control, never regenerate from the current (possibly broken) render.
- Diff review stalls (no reviewer available) → the cell stays red and the merge stays blocked; time-out-approving a diff is a fabricated confirmation and is forbidden.
- Viewport/OS update changes every cell at once → treat as an environment migration PR: re-baseline explicitly with a rationale that names the platform change, never silently inside feature PRs.
- Screenshot captured before fonts/hydration settle → the diff is meaningless; wait on the documented ready state, and treat repeat offenders as determinism defects.

## Evidence requirements

- Every failure carries a bundle: metadata.json (run identity, `label: OBSERVED`), console.log, network.json, plus screenshot.png/trace.zip when the runner produced them. Secrets are scrubbed before write (golden rule 8).
- Label discipline: OBSERVED = the diff was captured and the artifacts exist; CONFIRMED = additionally a human review decision is recorded; INFERRED = classification from error shape without artifacts; NOT_VERIFIED = diff exists but no reviewer decision; NOT_RUN = no baseline for the cell.
- Baseline updates must reference the bundle path and the reviewer decision — the PR is the evidence link, append-only (golden rule 13).
- Multi-dimension changes (theme, RTL, breakpoint) cite one bundle per affected cell; a single-cell screenshot never stands in for the whole matrix.
- A green run after a baseline update is evidence of consistency with the NEW baseline, not evidence the original defect never existed — the review record carries that distinction.
- Real benchmark scenario (fixture `visual-regression`): two attempts fail with the identical screenshot-diff signature (`Expected screenshot to match baseline "home-hero-desktop.png" ... 18402 pixels (2.31%) differ`), the spec imports `HERO_VIEWPORTS` from the changed `app/ui/hero-section.tsx`, so triage rule 10 returns REAL_REGRESSION at 0.92 — the fixture's expected floor is deliberately lower (0.7) as an honesty margin, because static triage cannot separate "product renders wrong" from "baseline encodes the old UI".

## Safety constraints

- `test` (running the visual suite) → READ_ONLY: it does not modify tracked sources; artifacts go to untracked dirs.
- `generate` (scaffolding visual specs) → LOW_RISK_WRITE: writes only under the generated-tests directory; never overwrites without `--force`.
- Deleting or mass-replacing baseline data → HIGH_RISK (policy `coverage.delete`: destroying baseline data destroys verification history); requires `--confirm-risk` and is normally refused — baselines are updated one diff at a time.
- Running visual tests against production → HIGH_RISK (`test.production`); requires `--confirm-risk` and explicit authorization (golden rule 9).
- Golden rules in force: 1 (never weaken an assertion — a loosened diff threshold is a weakened assertion), 2 (no retry-washing), 3 (no sleeps), 4 (no claimed verification without execution evidence), 8 (no secrets in artifacts), 12 (reproducibility metadata), 13 (append-only evidence), 14 (explained decisions), 15 (signal over count).

## Output contract

```json
{
  "schemaVersion": "qa.visual.v1",
  "data": {
    "testId": "tests/home.visual.spec.ts::home hero renders",
    "layer": "visual",
    "matrixCell": { "browser": "chromium", "viewport": "1280x720", "theme": "dark" },
    "verdict": "REAL_REGRESSION",
    "confidence": 0.92,
    "baselineAction": "keep",
    "humanReview": "pending",
    "evidence": [
      { "id": "ev-1a2b3c4d", "kind": "screenshot",
        "location": ".theqa/artifacts/run-2026-01-15/tests_home_visual_spec_ts__home_hero_renders/screenshot.png",
        "summary": "Diff image: hero section renders stacked instead of side-by-side vs baseline",
        "collectedAt": "2026-01-15T09:30:00Z", "label": "OBSERVED" }
    ],
    "assumptions": ["animations disabled via config", "fonts served from bundled assets"]
  },
  "label": "OBSERVED"
}
```

## Examples

**Walkthrough 1 — real layout regression.** A change rewrites `app/ui/hero-section.tsx`. The visual spec fails twice with the same baseline-diff signature; the spec imports `HERO_VIEWPORTS` from that file, so `coversChangedCode` is true. Rule 1 fires: REAL_REGRESSION candidate at 0.92 (fixture floor 0.7 as the honesty margin). Action: block merge, attach the bundle (screenshot + trace), let a human compare the diff against the design ticket. The rendered layout is genuinely stacked → product fix, baseline untouched.

**Walkthrough 2 — intentional redesign, stale baseline.** Same failure shape, but the change set *is* the redesign ticket. Rule 3 fires after human review confirms intent: update `home-hero-desktop.png` in the same PR, rationale line in the commit ("hero stacked layout per DESIGN-142; diff reviewed"), re-run → green. Label escalates to CONFIRMED only because execution evidence (green run on the new baseline) plus the recorded review decision both exist. The learning store records a `review_feedback` entry noting the baseline age so staleness is measured, not discovered.

## Verification checklist

- [ ] Every visual failure has an evidence bundle with screenshot.png and trace.zip (or an explicit reason they are absent).
- [ ] No baseline was updated without a human review decision recorded in the same PR.
- [ ] Every matrix cell has its own baseline; no cell is green because a neighbor's baseline was reused.
- [ ] No spec relies on `waitForTimeout`/sleeps for stability; animations are disabled via config.
- [ ] Dynamic regions are masked minimally, and the mask list is documented.
- [ ] Triage categories follow the decision table (REAL_REGRESSION vs TEST_DEFECT vs SELECTOR_FAILURE), never forced.
- [ ] Retry-passes over changed code were re-triaged, not accepted (golden rule 2).
- [ ] PR/nightly placement reflects suite runtime, and nothing was deleted to fit the budget.
- [ ] Dark-mode, RTL, and breakpoint dimensions each have their own baselines where the product supports them.
- [ ] Verdicts used the full bundle (trace/DOM context), not the diff image alone.
