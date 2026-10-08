# auth-bug — expired hard-cap rejects live sessions (triage: REAL_REGRESSION)

LedgerDesk issues 7-day sessions for remembered devices. The change under
test ("harden session lifetime") anchors a new hard deadline to the wrong
constant: `verifySession` now compares `now` against `issuedAt + 5 minutes`
(`HARD_SESSION_CAP_MS`) instead of the 7-day TTL, so every session older
than five minutes is silently rejected.

Planted defect: `app/lib/session.ts` — the expiry check uses
`HARD_SESSION_CAP_MS` as a hard deadline, invalidating live sessions
(middleware answers 401 for a 2-day-old, otherwise-valid token).

The human observes: CI fails deterministically on
`keeps a remembered device session valid for the full 7 day window` with
`expected 401 to equal 200` on two consecutive attempts, while the same test
passed on the previous four runs. `tests/auth.spec.ts` imports the changed
module, so the failure covers changed code.
