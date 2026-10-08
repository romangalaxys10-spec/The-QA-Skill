# missing-coverage — usage metering endpoint ships with zero test reach (coverage: api)

LedgerLine adds `GET /api/usage`, the subscription usage-metering endpoint
whose totals feed the billing importer (per-call billing plus an HMAC
signature). The only spec in the service targets `app/lib/slugify.ts`, a
filename helper — the new API surface has no test reaching it, directly or
transitively.

Planted defect: `app/api/usage.ts` (commit 2) lands with weighted coverage
pull from zero tests; the only covered module is the unrelated slug
helper. The staging incident record shows what the gap cost: the first
deployed build answered 500 on malformed period dates and nobody's suite
noticed until the manual smoke.

The human observes: the coverage engine reports weightedCoverage collapsing
(only the weight-1 helper is covered, the weight-6 API surface is not) and
a gap on `app/api/usage.ts` with the API/contract-risk reason. Naming
note: the scenario was drafted as `app/api/subscriptions.ts`, but
"subscription" lexically matches the engine's payment-area keywords before
the api pattern fires, so the file is `app/api/usage.ts` to genuinely
exercise the api gap area.
