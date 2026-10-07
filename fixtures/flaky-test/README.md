# flaky-test — cold-runner per-test timeout on dashboard hydration (triage: FLAKE)

PulseBoard's exec dashboard spec navigates to `/dashboard` and asserts on
the six-card KPI grid. The metrics bundle is compiled lazily, so on a cold
CI runner the first paint can blow the 30s per-test budget while a warm
retry sails through — the spec is nondeterministic, not the product.

Planted defect: `tests/dashboard.spec.ts` "shows all six KPI cards" —
the run waits on bundle hydration with no changed product code; attempt 1
died with the Playwright per-test timeout, attempt 2 passed, and the
recent-run history for this case is passed,failed,passed.

The human observes: a lone red X on an otherwise green run, green on
retry, nothing in the diff. Note: the scenario was originally drafted with
a `page.waitForSelector` timeout error, but that phrasing matches the
triage engine's selector-wait patterns and would classify as TIMING_FAILURE
(0.7); the error was adjusted to Playwright's genuine per-test timeout
string ("Test timeout of 30000ms exceeded") so the ordered rules land on
FLAKE at 0.88 via the documented rule-7 exception (retry-pass, no changed
code, intermittent history).
