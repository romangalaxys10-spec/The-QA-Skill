---
name: qa-security
description: Security testing discipline for the 'security' layer — OWASP Top 10 practical checklists, authz matrix methodology, and secret hygiene, executed through the plan-only ZAP adapter. Live scans are external systems (HIGH_RISK, --confirm-risk, human-approved), and security findings are never force-fitted into regression triage categories.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  - runners:zap (ZAPRunner: plan-only — detection, ZapScanPlan, alerts-JSON parsing with '[ZAP]' prefix)
  - core:risk (SECURITY_PATTERNS → securitySensitivity; tier floor elevates to high at 0.85)
  - core:evidence/bundle (scrubSecrets before any artifact write; alert JSON scrubbed)
---

# QA Security

## Purpose

Give an agent a disciplined, non-heroic security-testing practice: enumerate the OWASP Top 10 as concrete, testable checks; methodically verify authorization with a role × resource × action matrix; keep secrets out of every artifact; and route findings correctly — a ZAP alert says "this endpoint exposes X", not "commit C broke test T", so security findings flow to security review, never into the regression triage categories. The platform's ZAP adapter is plan-only by design; this skill respects that boundary absolutely.

## When to activate

- A change set touches auth, sessions, tokens, permissions, crypto, secrets, CSP, or sanitization (the risk engine's SECURITY_PATTERNS).
- You are asked to "run a security scan", "check for IDOR", or "harden this endpoint" — including being asked to run ZAP.
- A ZAP alerts JSON exists and needs parsing into the event pipeline.
- A dependency audit or secret scan failed and the result needs routing.
- A new endpoint ships and its authorization denials were never specified — the authz matrix does not exist yet and must be built.

## Inputs

| Input | Source | Required | Notes |
| --- | --- | --- | --- |
| Diff of change set | `analyzeDiff` | yes | SECURITY_PATTERNS matching elevates risk |
| Scan target description | model phase | yes | URL/host, policies, whether active scan would be needed |
| ZAP alerts JSON | external scan output | when present | `{ site: [ { '@name', alerts: [...] } ] }` document |
| Authz matrix draft | model phase | yes | Roles × resources × actions for the changed surface |
| Dependency manifests | package files | yes | For vulnerability gating |
| Test credentials | env-backed fixtures only | yes | Never real user secrets, never committed |

## Preconditions

- The scan target is a non-production environment you are explicitly authorized to test; production targets require written authorization plus `--confirm-risk`.
- ZAP execution happens OUTSIDE this platform: the adapter builds the plan (`ZapScanPlan`, `mode: 'plan-only'`), a human or approved pipeline stage runs the real binary, and the resulting alerts JSON is brought back for parsing. The executor refuses to spawn plan-only runners — there is no scan command to build.
- Secrets used by any check come from environment variables or a secret store; the evidence writer scrubs known secret shapes (Bearer tokens, api keys, Stripe/AWS key shapes, private key blocks) before writing artifacts.
- The authz matrix for the changed surface is enumerable — if roles/resources/actions cannot be listed, that enumeration is the first deliverable.

## Decision rules

1. If a live scan is requested → build the `ZapScanPlan` (target, policies — default `['baseline']`, activeScan, spider) and stop: execution is external, human-approved, and classified HIGH_RISK (`external.systems`); require `--confirm-risk` before any such step and never execute it yourself.
2. If an alerts JSON is provided → parse each alert into a TestEvent: status `failed`, name `[ZAP] <alert name>`, errorType `riskcode=<0..3>` (ZAP scale: 0 informational … 3 high), filePath from the alert URL — and leave `failureCategory` UNSET so triage classifies UNKNOWN and routes to security review; never force REAL_REGRESSION.
3. If changed files match SECURITY_PATTERNS (`auth|login|session|sso|oauth|jwt|token|credential|password|permission|rbac|acl`, `secret|vault|crypto|encrypt|hash|salt|csp|csrf|xss|sanitiz`) → securitySensitivity ≥ 0.6 with per-file reasons; at 0.85 the risk engine's tier floor elevates the change to high regardless of the raw score.
4. If an endpoint takes a resource id → include an IDOR check: request user A's resource under user B's session and expect 403/404, not the payload.
5. If an authz matrix cell (role × resource × action) has no check → enumerate it; privilege escalation means a LOW cell (should-deny) returning success — test the denial, not just the grant.
6. If a check would embed a secret in code, fixtures, or expected outputs → stop and restructure around env-backed fixtures (golden rule 8); scrubbing is the safety net, not the design.
7. If the OWASP category has no automated check available (e.g. business-logic abuse, SSRF via internal metadata services) → record it as a documented manual protocol with label NOT_RUN; a gap must be visible, never silently green.
8. If a dependency vulnerability gate fails → treat as a blocking security finding routed to security review; it is not a regression category and does not enter the REAL_REGRESSION vs TEST_DEFECT table.
9. If a finding requires validating exploitability against live systems → escalate to the human security team; agents enumerate and reproduce in safe environments, they do not prove exploits in production.
10. If CI security configuration (permissions, secrets, runners) must change to enable scanning → HIGH_RISK (`ci.security.change`): requires `--confirm-risk` and human ownership of the trust boundary.
11. If a test needs a privileged account → use a dedicated test principal with the minimum scopes that exercise the check; privileged shared credentials are a hygiene violation even inside CI.
12. If a finding's fix lands → the closing re-run must exercise the SAME check that failed, not a sibling; closing findings on unrelated green runs fabricates closure (golden rule 4).

Risk elevation mechanics (from the core risk engine, cited so the escalation is explainable):

| Mechanic | Behavior |
| --- | --- |
| SECURITY_PATTERNS match on changed paths | securitySensitivity = 0.6 + 0.1 × hits (capped at 1); 0.05 when no match |
| Pattern keywords | `auth`, `login/session/sso/oauth/jwt/token/credential/password/permission/rbac/acl`, `secret/vault/crypto/encrypt/hash/salt/csp/csrf/xss/sanitiz` |
| Tier floors | business or data ≥ 0.9 → critical; business ≥ 0.8 OR security ≥ 0.85 → high |
| Explanations | factor reasons name the matched paths; the label stays INFERRED (heuristics over the repo, not production measurements) |

## Workflow (12-phase lifecycle)

1. **DISCOVER** — detect ZAP configuration (zap*/.zap files) and security-sensitive paths; read dependency manifests.
2. **MODEL** — run the risk factors: securitySensitivity from SECURITY_PATTERNS, dataSensitivity for PII-adjacent storage; sketch the authz matrix for changed surfaces.
3. **PLAN** — produce the ZAP scan plan (plan-only) and the manual checklist per OWASP category below; decide which checks are automatable in CI vs human protocols.
4. **GENERATE** — scaffold authz-matrix tests (denial checks per cell), IDOR probes against test tenants, and input-validation tests for injection/XSS shapes using inert payloads in test environments.
5. **VALIDATE** — quality pass on generated tests: assertions check denials and status contracts; no secrets inline; payloads are inert and tenant-scoped.
6. **EXECUTE** — run the automatable checks through framework adapters against the authorized test environment only.
7. **OBSERVE** — write evidence bundles; scrub secrets from console/network artifacts before write (golden rule 8).
8. **TRIAGE** — parsed alerts stay UNKNOWN by design (category unset at the adapter); they surface at the gate as open unknowns and are routed to security review with the alert JSON.
9. **HEAL** — security findings are never auto-healed; the only admissible healing is fixing test-side credentials/selector hygiene, never weakening a security assertion (golden rule 1).
10. **VERIFY** — re-run the specific check after a fix; a finding closes only with OBSERVED evidence of the fixed behavior, confirmed by the security owner.
11. **MEASURE** — track findings per category and per surface over time; track the ratio of automated vs manual protocol coverage.
12. **LEARN** — record findings and escalations; recurring categories (e.g. repeated missing authz checks on new endpoints) become generation-time checks.

### OWASP Top 10 practical checklist (per category — consumed by PLAN/GENERATE/EXECUTE)

- **A01 Broken access control / authz** — the role × resource × action matrix; every should-deny cell asserted; IDOR probes on every id-bearing endpoint.
- **A02 Cryptographic failures** — secrets not logged (scrub check), transport security config asserted, no plaintext sensitive fields in payloads/fixtures.
- **A03 Injection** — parameterized queries verified at the data layer; inert payloads in test envs; output encoding for reflected input.
- **A04 Insecure design** — manual protocol: abuse cases per critical flow (negative-quantity orders, self-referral loops); NOT_RUN-labeled when unautomated.
- **A05 Security misconfiguration** — CSP/security headers asserted; debug endpoints absent; default credentials refused by config checks.
- **A06 Vulnerable components** — dependency gate: manifests scanned in CI; block on known-vulnerable direct deps.
- **A07 Authn failures** — session lifecycle: fixation, expiry, logout invalidation; credential endpoints rate-limited (assert 429 shape).
- **A08 Integrity failures** — CI trust boundary: unsigned artifacts, unpinned actions flagged (ci.security.change rules apply).
- **A09 Logging/monitoring failures** — assert security events are logged without secrets (scrubbed-log check) for auth and authz denials.
- **A10 SSRF** — manual protocol for URL-fetching features (internal metadata ranges must be unreachable); automated only with isolated egress in test envs.

## Anti-patterns

- Running an active scan against production because "the target URL was in the config" — production testing is HIGH_RISK (`test.production`) and requires explicit authorization plus `--confirm-risk` (golden rule 9).
- Forcing ZAP alerts into REAL_REGRESSION to make gates behave — the adapter deliberately leaves the category unset; corrupting that would fake regression semantics.
- Committing credentials "just for the test" — golden rule 8 is absolute; fixtures read env, artifacts get scrubbed, source never holds secrets.
- Treating one green baseline scan as security clearance — scans snapshot one surface at one time; the authz matrix and manual protocols carry the rest.
- Auto-healing a security test by loosening its assertion (accepting 200 where 403 was asserted) — the definition of golden-rule-1 violation.
- Enumerating exploits against live systems without a security team — escalation exists for exactly this; stop at the boundary.
- Silently skipping a category that cannot be automated instead of recording NOT_RUN with a manual protocol.
- Security theater: scheduled scans whose findings have no owner and no route — an alert nobody receives is noise with a dashboard.

## Failure handling

- Alerts JSON unparseable → no events; report the parse failure explicitly (never pretend zero alerts means zero findings).
- Alert lacks riskcode → errorType records `riskcode=unknown`; the alert still surfaces with `[ZAP]` prefix; severity is the reviewer's call, not the parser's.
- Authz test hits environment noise (connection refused shapes) → ENVIRONMENT_FAILURE path; fix env, re-run; do not record the cell as verified.
- Scan plan rejected by the security team → record the decision, keep the plan artifact; do not seek execution paths around a refusal.
- Credential fixture missing → checks are NOT_RUN for authn-dependent cells; do not run unauthenticated and present it as coverage.

## Evidence requirements

- Parsed alerts: one TestEvent each with `[ZAP]` name, `riskcode=` errorType, alert description/solution in the error fields; the source alerts JSON is attached to the bundle after `scrubSecrets`.
- Labels: OBSERVED for parsed alerts with artifacts and for executed checks with captures; CONFIRMED only when the security owner closes a finding; INFERRED for risk-elevation reasoning (patterns over paths); NOT_RUN for unautomated OWASP categories and missing fixtures; NOT_VERIFIED for findings awaiting human triage.
- Every bundle's metadata carries environment and target identity — a finding without its target and commit context is not actionable.
- Triage mapping is fixed: security alerts → UNKNOWN + security review; dependency gate failures → security review; only conventional functional failures enter the 12-category regression table.

## Safety constraints

- READ_ONLY: `discover`, `plan` (the ZapScanPlan is a declarative object — no network calls, no processes), `risk`, `report`.
- LOW_RISK_WRITE: `generate` of security test scaffolds (generated-tests directory only).
- HIGH_RISK (all require `--confirm-risk`): `external.systems` (live scans, any third-party security service), `test.production`, `ci.security.change`, `notify.external` (posting findings to chat/ticketing reaches humans outside the loop).
- The two-step rule for scans: the agent may always PLAN; the agent may never EXECUTE a live scan — that step is human or an explicitly approved pipeline stage outside the platform.
- Golden rules in force: 1 (never weaken security assertions), 4 (no verification claims without execution evidence), 7 (never delete a failing security test without strong recorded evidence), 8 (secrets never in test artifacts — enforced by data/mask + bundle scrubbing), 9 (no destructive/unauthorized actions), 10 (security findings are not product-vs-test regressions; they are their own route), 14 (every verdict explained with evidence and assumptions).

## Output contract

```json
{
  "schemaVersion": "qa.security.v1",
  "data": {
    "scanPlan": {
      "target": "https://staging.example-app.test",
      "policies": ["baseline"],
      "activeScan": false,
      "spider": true,
      "mode": "plan-only",
      "note": "Plan only — execute ZAP externally with human approval; this repo never runs live scans."
    },
    "findings": [
      { "testId": "zap/alerts.json::[ZAP] Cross-Domain Misconfiguration",
        "status": "failed", "errorType": "riskcode=2",
        "category": "UNKNOWN", "route": "security-review",
        "summary": "Alert parsed from external scan output; riskcode 2 of 0..3 scale" }
    ],
    "authzMatrix": { "cellsEnumerated": 12, "cellsVerified": 9, "missingCells": ["support-role × invoices × write"] },
    "evidence": [
      { "id": "ev-2b3c4d5e", "kind": "log_line",
        "location": ".theqa/artifacts/run-2026-01-15/zap/alerts.json",
        "summary": "External ZAP alerts JSON parsed; 3 alerts; secrets scrubbed before bundling",
        "collectedAt": "2026-01-15T13:05:00Z", "label": "OBSERVED" }
    ],
    "assumptions": ["scan executed externally against staging by an authorized human", "test tenants isolated"]
  },
  "label": "OBSERVED"
}
```

## Examples

**Walkthrough 1 — plan-only scan, parsed alerts.** A change touches `app/auth/session.ts`, so SECURITY_PATTERNS elevate risk (securitySensitivity ≥ 0.6, tier floored to high). The skill builds a ZapScanPlan for the staging target (baseline policy, spider on, activeScan off) and hands it to the security owner, who runs ZAP externally and drops back an alerts JSON with two alerts. Parsing yields two TestEvents (`[ZAP] ...`, `riskcode=1` and `riskcode=2`), categories left unset → UNKNOWN → security review. The release gate sees open unknowns, not fake regressions; the security owner triages one as a real header misconfiguration and closes it with a re-run as OBSERVED evidence.

**Walkthrough 2 — IDOR via the authz matrix.** Modeling `/api/invoices/{id}` yields roles customer, support, admin × actions read, write. The generated denial check "customer B requests customer A's invoice" receives 200 with the payload — a deterministic failure over the changed handler code. Because this is an assertion failure over changed code it blocks the merge like any regression, but its route is security review with the matrix cell named in the bundle. The fix (ownership check in the handler) is verified by re-running the matrix suite: all 6 cells green, matrix recorded in the learning store for the next change to that surface.

## Verification checklist

- [ ] No live scan was executed by the platform; a ZapScanPlan exists and execution was external and authorized.
- [ ] Every parsed alert carries the `[ZAP]` prefix, riskcode, and an unset category routed to security review.
- [ ] Every should-deny cell of the authz matrix has a denial assertion, or is listed as a missing cell.
- [ ] No secrets in source, fixtures, or artifacts; bundles were scrubbed (golden rule 8).
- [ ] Unautomated OWASP categories are recorded NOT_RUN with a manual protocol named.
- [ ] Dependency gate ran and its result was routed, not silenced.
- [ ] No security assertion was weakened, suppressed, or auto-healed.
- [ ] Findings were closed by re-running the exact failing check with the security owner's confirmation.
- [ ] Every changed auth-sensitive surface has an enumerated authz matrix, not just spot checks.
- [ ] Escalations to the human security team are recorded with their evidence bundles.
