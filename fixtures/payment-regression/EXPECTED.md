# Expected
- engine: risk
- expect_category: REAL_REGRESSION
- expect_min_confidence: 0.85
- expect_risk_tier: critical
- notes: Dual-engine fixture; primary engine is risk. Risk side: the change set contains app/payments/charge.ts, whose path matches the payment keyword table (/pay/ in "payments", /charge/ in "charge.ts"), so businessCriticality evaluates to 0.95 and the risk engine's documented tier floor (payment value >= 0.9 forces critical regardless of the weighted score) makes expect_risk_tier critical even though the diff is ~25 lines — the weighted score alone would sit near medium, which is exactly why the floor exists. Triage side: failures.json records two attempts failing with the identical assertion "expected 2 to equal 1" (ledger entry count), deterministic (2/2), with tests/charge.spec.ts importing the changed module so coversChangedCode=true and recentRuns all passed; walking classifyFailure, rules 1-7 find no dependency/config/selector/env/network/data/timeout shapes, rule 8/9 need passAfterRetry which is false, and rule 10 returns REAL_REGRESSION at 0.92 >= 0.85.
