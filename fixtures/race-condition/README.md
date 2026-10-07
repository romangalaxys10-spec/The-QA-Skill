# race-condition — concurrent completions stamp duplicate event ids (triage: FLAKE)

SwiftLabel's print queue was parallelized ("parallel label rendering
workers", commit 2). The event publisher stamps completion sequence numbers
before the microtask that commits the counter, so two jobs whose renders
resolve in the same timer tick both read `eventSeq === 0` and emit the
same `eventId`; the delivery bus collapses duplicates by id, so a
subscriber misses one notification.

Planted defect: `app/jobs/queue.ts` `publishJobCompleted` — sequence read
and commit are split across a microtask boundary; under concurrency the
read races (the defect landed in the earlier parallelization commit, not
in today's change set).

The human observes: "delivers one completion event per finished job" failed
attempt 1 with `AssertionError: expected 1 to equal 2 events` and passed
attempt 2, with recent-run history passed,failed,passed,failed and no
changed code in today's run — the classic nondeterministic signature. The
concurrency source is documented: same-tick render completions reading a
sequence counter whose update is deferred to a microtask.
