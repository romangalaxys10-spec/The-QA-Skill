# false-negative — the coupon suite cannot fail, so the bug ships green (quality: 71/100)

Cartwheel's checkout honors campaign coupon codes. The suite in
`tests/coupon.test.ts` is green on every run — and can prove almost
nothing: of three cases, only one carries an assertion at all, and that
assertion is `expect(outcome.totalCents).toBeGreaterThan(0)`, which any
pricing outcome satisfies. The other two cases fire the engine and log to
the console.

In the same change set, `app/checkout/coupon.ts` was rewritten to accept
codes case-insensitively — and the rewrite dropped the expiry guard, so
the long-expired `SPRING10` campaign still discounts live orders.

Planted defect: `app/checkout/coupon.ts` (commit 2) no longer enforces
`expiresAt`; the always-green suite in `tests/coupon.test.ts` is the false
negative that let it ship.

The human observes: every CI run is green, yet the promotions team
redeems `SPRING10` weeks after the campaign ended — the staged order
import shows a 10% discount on orders placed after 2026-06-30. The suite
could not flag it because `applyCoupon` cannot throw and every outcome
has a positive total, so the case in `failures.json` passes on every
attempt while recording the escape.
