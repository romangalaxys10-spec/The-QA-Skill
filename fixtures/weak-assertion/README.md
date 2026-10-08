# weak-assertion — assertions traded for a green checkmark (quality: 62/100)

RateCard's pricing suite was "temporarily" weakened during a tier-schema
rework: the case that used to pin `quoteTotal(3)` to the published rate now
runs `expect(true).toBe(true)`, the boundary case at exactly fifty units
was dropped, and the remaining cases only `console.log` their results. In
the same commit, the tier lookup in `app/pricing/rate-card.ts` picked up an
off-by-one (`units > candidate.minUnits` instead of `>=`), so an order of
exactly 50 units is priced at the 10-unit rate — $21,200 instead of
$18,450 — and the suite stays green.

Planted defect: `tests/pricing.test.ts` (tautological assertion, no
negative or boundary cases, 3 of 4 cases unverified) hiding the
`app/pricing/rate-card.ts` inclusive-tier regression shipped in the same
change set.

The human observes: every CI run is green, yet the staging regression pack
fails on `tiered discount at the volume boundary` with `expected 21200 to
equal 18450` — the suite could not fail for the right reason because it
cannot fail at all.
