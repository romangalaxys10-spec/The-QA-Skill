# selector-change — checkout CTA test id renamed (triage: SELECTOR_FAILURE)

CrateCart's order review panel carries the primary CTA under the test id
`submit-order`. The change under test renames it to `place-order` to match
the new button copy ("Place order"), but the checkout specs were not
updated in the same change set.

Planted defect: `app/ui/checkout.tsx` — commit 2 swaps
`data-testid="submit-order"` for `data-testid="place-order"`; both the
spec (`tests/checkout.spec.ts`) and its page object still target
`submit-order`.

The human observes: `locator.click: Timeout 30000ms exceeded` waiting for
`getByTestId('submit-order')` on two consecutive attempts, while the same
specs passed on the previous five runs. The diff contains the renamed
selector literal, so the failure is a broken test contract, not lost
product behavior.
