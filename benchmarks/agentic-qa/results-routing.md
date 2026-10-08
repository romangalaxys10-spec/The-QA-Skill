# xRouteLM routing benchmark results

> Measured with the xRouteLM heuristic scorer over the default QA targets — the same
> engine `qa route` and the MCP `route_task` tool use. No LLM, no network; reproducible
> via `npx tsx benchmarks/agentic-qa/run-routing.ts`.

**Accuracy: 12/12 (100%)** · mean confidence 0.869 · mean 0.58 ms/case

| Task | Expected | Actual | Confidence | Top-3 | Result |
| --- | --- | --- | ---: | --- | --- |
| tests fail intermittently on retry without any code change | qa-flake-detection | qa-flake-detection | 0.428 | qa-flake-detection → qa-impact-analysis → qa-risk-analysis | PASS |
| payment total is wrong after applying a discount coupon at checkout | qa-risk-analysis | qa-risk-analysis | 0.97 | qa-risk-analysis → qa-failure-triage → qa-enterprise | PASS |
| fix the deadlock between the worker queue and the rate limiter | qa-risk-analysis | qa-risk-analysis | 0.97 | qa-risk-analysis → qa-test-healing → qa-enterprise | PASS |
| select the smallest test set for this pull request diff | qa-impact-analysis | qa-impact-analysis | 0.97 | qa-impact-analysis → qa-enterprise → qa-failure-triage | PASS |
| the login locator broke after the navbar redesign and the test cannot find the button | qa-test-healing | qa-test-healing | 0.297 | qa-test-healing → qa-failure-triage → qa-test-generation | PASS |
| 87 tests failed in the nightly run, cluster them and find the primary root cause | qa-failure-triage | qa-failure-triage | 0.97 | qa-failure-triage → qa-flake-detection → qa-impact-analysis | PASS |
| generate test cases for the new refund feature spec | qa-test-generation | qa-test-generation | 0.97 | qa-test-generation → qa-risk-analysis → qa-impact-analysis | PASS |
| decide whether release 2.4.0 can ship to production | qa-release-gate | qa-release-gate | 0.97 | qa-release-gate → qa-enterprise → qa-impact-analysis | PASS |
| run the full QA lifecycle for this repository before the release | qa-enterprise | qa-enterprise | 0.97 | qa-enterprise → qa-release-gate → qa-flake-detection | PASS |
| score how risky this database migration change is | qa-risk-analysis | qa-risk-analysis | 0.97 | qa-risk-analysis → qa-flake-detection → qa-impact-analysis | PASS |
| this element is not found sometimes when the page loads slowly | qa-flake-detection | qa-flake-detection | 0.97 | qa-flake-detection → qa-enterprise → qa-impact-analysis | PASS |
| which tests cover the changed session module in this commit | qa-impact-analysis | qa-impact-analysis | 0.97 | qa-impact-analysis → qa-flake-detection → qa-test-healing | PASS |
