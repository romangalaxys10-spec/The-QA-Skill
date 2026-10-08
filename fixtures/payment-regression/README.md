# payment-regression — retry path double-charges (risk: critical / triage: REAL_REGRESSION)

TapCharge retries ambiguous processor timeouts. The change under test
("harden retries") mints a *fresh* idempotency key per attempt so the
gateway can no longer deduplicate a replayed capture — exactly when the
first attempt actually captured on the processor side but the client gave
up waiting. One logical charge now becomes two gateway captures.

Planted defect: `app/payments/charge.ts` — `idempotencyKey` includes
`Date.now()` and the attempt number, so a retried capture after an
ambiguous timeout charges the customer twice.

The human observes: "captures exactly once when the first attempt times out
client-side" fails deterministically with `expected 2 to equal 1` on the
ledger entry count (two attempts), previously green for six runs. Because
the change set touches payment logic, the risk engine's documented floor
(businessCriticality ≥ 0.9 → critical) applies regardless of the small
diff, demanding the heavy payment validation suite before merge.
