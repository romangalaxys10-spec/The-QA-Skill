# db-regression — case-insensitive unique index collides with seeded rows (triage: TEST_DATA_DEFECT)

MediTrack adds a case-insensitive unique index on `users.email`
(`users_email_unique` on `lower(email)`). The repository change drops the
`on conflict` clause (it cannot target the expression index) and lowercases
on write, but `findUserByEmail` still compares with plain equality — so a
seeded row stored as `Maya.Okafor@…` is invisible to the lookup while its
lowered insert collides with the new index.

Planted defect: `app/db/users.ts` + migration
`2026_09_14_users_email_unique.sql` — find/insert asymmetry turns any
pre-normalization row into a unique-constraint violation.

The human observes: `duplicate key value violates unique constraint
"users_email_unique"` on both attempts in the "differs only by case" spec,
while the previous four runs passed. Data-layer changes like this raise
dataSensitivity to the migration floor (0.95 → risk tier critical) and make
data-integrity tests the first thing selection elevates, so the triage
verdict is recorded with the data-layer elevation story attached.
