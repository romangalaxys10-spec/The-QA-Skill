# api-regression — invalid drafts answered with 200 instead of 400 (triage: REAL_REGRESSION)

FleetFolio's order API historically rejected invalid `POST /api/orders`
drafts with 400 and a problems list. The change under test introduces the
"recoverable draft" contract: validation problems are now acknowledged
with status 200 and `accepted: false`, a client-visible API regression
that flips failure into success at the status-code layer.

Planted defect: `app/api/orders.ts` — the rejection branch of
`handleCreateOrder` returns 200 with the problems payload instead of 400,
so any draft without line items (or with a malformed customer id) is
reported as an accepted request.

The human observes: the supertest-style suite fails deterministically on
`rejects a draft without line items with 400` with
`expected 200 to equal 400` on two consecutive attempts; the same case
passed on the previous five runs, and the failing test imports the changed
handler directly.
