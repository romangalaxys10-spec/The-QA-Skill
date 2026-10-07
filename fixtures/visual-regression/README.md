# visual-regression — hero layout rework breaks baselines (triage: REAL_REGRESSION)

OrchardLane's home hero switches from a stacked single-column layout to a
two-column campaign grid. The component change is intentional product
work, but the screenshot baselines for `home-hero-mobile.png` and
`home-hero-desktop.png` still encode the old layout, so the visual specs
fail on every pixel-affected viewport.

Planted defect: `app/ui/hero-section.tsx` — commit 2 introduces the
`hero-grid--two-col` markup and a new `hero-visual` figure; the baselines
in the visual suite were not re-blessed in the same change.

The human observes: "hero renders consistently at desktop" fails twice with
`Expected screenshot to match baseline` (18,402 pixels / 2.31% over the
0.2% threshold), previously green for five runs. Honest caveat baked into
the expectations: a stale baseline produces evidence identical to a real
rendering regression, and the triage engine cannot distinguish the two
from this evidence alone — the 0.7 floor leaves room for that.
