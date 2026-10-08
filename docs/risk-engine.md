# Risk Engine — The-QA-Skill

> Sponsored by xShredo.dev → https://xshredo.com/promo/anytest

**Audience:** contributors and agent authors. This is the full documented algorithm of
the 8-factor risk engine in `packages/core/src/risk/` (`engine.ts`, `factors.ts`), with
a worked example whose numbers were produced by running the engine on the exact input
shown. Nothing here is invented; the [Verification](#verification) checklist maps every
claim to source.

---

## 1. The algorithm in one line

```
Risk = Σ(weight_i × value_i) × 100
```

where `value_i ∈ [0,1]` is the normalized intensity of factor *i*, derived from
observable signals with recorded reasons. Tiers: `≥80 critical · ≥60 high · ≥35 medium ·
else low`. The output label is `INFERRED`: the score is deterministic given its inputs,
but the inputs are heuristics over the repository, not measurements of production
(module doc, `engine.ts`).

## 2. Weights and thresholds

`DEFAULT_WEIGHTS` (also the Zod defaults in `theqa.config.json` — `risk.weights`, each
value constrained to 0..1):

| Factor | Default weight |
|---|---|
| `businessCriticality` | 0.20 |
| `changeSurface` | 0.15 |
| `userImpact` | 0.15 |
| `defectHistory` | 0.12 |
| `integrationDepth` | 0.12 |
| `codeComplexity` | 0.10 |
| `securitySensitivity` | 0.08 |
| `dataSensitivity` | 0.08 |
| **Sum** | **1.00** |

`DEFAULT_THRESHOLDS = { critical: 80, high: 60, medium: 35 }` (configurable via
`risk.thresholds`). `tierFor(score, thresholds)` evaluates top-down: `>= critical →
'critical'`, `>= high → 'high'`, `>= medium → 'medium'`, else `'low'`.

## 3. The 8 factors: signal extraction

Each factor is computed by `compute<Factor>(input: RiskInput): FactorComputation` in
`factors.ts`, returning `{id, value, reasons[]}` — the engine never produces a number
without a "because". Input fields come from `RiskInput` (`changedFiles` with areas,
`defectHistory?`, `addedLines?`/`removedLines?`, `modulesTouched?`, `criticalPaths?`,
`boundarySignals?`).

Keyword tables are deliberately transparent (auditable, deterministic). All patterns are
case-insensitive; `matchesAny(path, patterns)` returns the first matching regex.

### 3.1 businessCriticality (w 0.20)

Starts at a **0.2 baseline** ("any change carries some business relevance"), then takes
the max of the signals that fire:

| Signal | Value | Reason recorded |
|---|---|---|
| Any path matches `PAYMENT_PATTERNS`: `pay\|billing\|invoice\|checkout\|cart\|subscription\|charge\|refund\|pricing\|stripe\|paypal` | **0.95** | `payment logic changed (<first 3 paths>)` |
| Any file with area `auth` | **0.85** | `authentication boundary touched (N files)` |
| Path contains a configured `criticalPaths` entry | **0.9** | `files matched configured critical paths (N)` |
| Any file with area `db` | **0.7** | `data model files changed` |
| Nothing fires | 0.2 | `no business-critical markers in change set (baseline criticality)` |

### 3.2 changeSurface (w 0.15) — saturating functions

Breadth of the diff. With `fileCount` and `churn = addedLines + removedLines`:

```
byFiles = min(1, fileCount / 12)        // ≥12 files → 1.0
byChurn = min(1, churn / 800)           // ≥800 changed lines → 1.0
value   = fileCount > 0 ? max(byFiles × 0.7 + byChurn × 0.3, 0.1) : 0
```

The `max(…, 0.1)` floor encodes "any non-empty change set has at least 0.1 surface".
Reasons: `N files changed`, `C lines added/removed` (or `empty change set`).

### 3.3 defectHistory (w 0.12) — churn hotspots

`value = max over changed files of defectHistory[path]` (0 when no history recorded for
any changed file). The `defectHistory` map is the normalized churn-hotspot proxy from
`churnHotspots(cwd, maxCommits = 200)` (`core/util/git.ts`):

- walks `git log --max-count=200 --name-only` with `---<hash>|<subject>` separators;
- a commit whose subject matches the fix pattern
  `/(^|\s)(fix|bug|hotfix|patch|regression)(\s|:|$)/i` marks its touched paths with a
  **count of 2 — fix-pattern commits count double**; other commits count 1;
- counts are normalized by the maximum (`count / max`) into 0..1;
- any git failure yields `{}` — history is optional input, never a hard dependency.

Reason: `historically unstable: <up to 2 hottest paths> (churn NN/100)` or
`no defect history recorded for changed files`. (The learning store's
`failureDensityByPath()` is the same shape — the documented alternative source for this
map.)

### 3.4 codeComplexity (w 0.10)

A documented proxy from churn size and module count:

```
value = min(1, churn / 500) × 0.6  +  min(1, modules / 10) × 0.4
```

`modulesTouched` is supplied by `RiskAgent` as the count of distinct containing
directories of changed *source* files (test-shaped files excluded; root-level files
count as one `'(root)'` module). Reasons: `C changed lines across M modules`, plus
`large code churn raises review cost` when churn > 500.

### 3.5 integrationDepth (w 0.12)

Cross-boundary files. `INTEGRATION_PATTERNS`: `api[/\\]`, `client|gateway|proxy|webhook|queue|event|broker|grpc|graphql`.

```
value = hits.length > 0 ? min(1, 0.5 + hits.length × 0.15) : 0.1
```

Reasons: `integration surfaces touched: <first 3 paths>` (or `no integration surface
markers detected`), plus `protected boundaries crossed: <boundarySignals>` when the
routing classifier supplied them.

### 3.6 userImpact (w 0.15)

User-facing surfaces. `USER_FACING_PATTERNS`: `component|page|view|screen|widget|layout|router|navigation|form|checkout|dashboard`; a file with area `ui` also counts as a hit.

```
value = hits.length > 0 ? min(1, 0.4 + hits.length × 0.12) : 0.15
```

Reasons: `user-facing surfaces affected (N files)` or `no user-facing surface detected
in change set`.

### 3.7 securitySensitivity (w 0.08)

Authn/authz/crypto/secret-adjacent changes. `SECURITY_PATTERNS`: `auth`,
`login|session|sso|oauth|jwt|token|credential|password|permission|rbac|acl`,
`secret|vault|crypto|encrypt|hash|salt|csp|csrf|xss|sanitiz`.

```
value = hits.length > 0 ? min(1, 0.6 + hits.length × 0.1) : 0.05
```

Reasons: `security-sensitive code changed: <first 3 paths>` or `no security-sensitive
markers in change set`.

### 3.8 dataSensitivity (w 0.08)

Migrations dominate. `DATA_PATTERNS`: `migrat|schema`, `model|entity|orm`,
`database|db[/\\]`, `backup|restore|seed`.

```
value = migrations present ? 0.95
      : hits.length > 0     ? min(1, 0.5 + hits.length × 0.1)
      :                       0.05
```

where `migrations` = changed files whose path matches `/migrat/i`. Reason for a
migration hit: `database migration files present (N) — data-integrity tests required`.

### 3.9 Area classification feeding the factors

`classifyArea(path)` (`factors.ts`) is a first-match-wins regex table (the same table
documented in [`test-selection.md`](./test-selection.md)): `auth → payment → db → api →
config → test → docs → infra → ui`, else `unknown`. It is shared by the diff parser and
the coverage engine, so the areas on `ChangedFile` are identical everywhere.

## 4. Contribution math

`assessRisk` (`engine.ts`):

```ts
const factors = computeAllFactors(input).map((f) => {
  const w = (weights[f.id] ?? 0) * norm;      // norm: renormalization, see §6
  return { factor: f.id, value: f.value, weight: w,
           contribution: w * f.value * 100, reasons: f.reasons };
});
const score = factors.reduce((acc, f) => acc + f.contribution, 0);
```

- `contribution_i = weight_i × value_i × 100`; the score is the sum (rounded to one
  decimal in the returned assessment: `Math.round(score * 10) / 10`).
- `topContributors` = all factors sorted by contribution, descending.
- Tier from §2, then the floors of §5.

## 5. Tier floors

Certain factor intensities impose a **minimum tier** regardless of the weighted score
(`engine.ts`). The code, with its rationale comment verbatim:

```ts
// Documented tier floors: certain factor intensities impose a minimum tier
// regardless of the weighted score. Rationale: a pure payment or migration
// change can be small in lines yet never acceptable to treat as "low" —
// the spec mandates heavy validation for payment (value ≥0.9) and
// data-integrity attention for migrations (value ≥0.9); auth boundary
// changes (value ≥0.8) and security-sensitive code (value ≥0.85) are at
// least "high".
const floorTier: RiskTier | undefined =
  business >= 0.9 || data >= 0.9 ? 'critical' :
  business >= 0.8 || security >= 0.85 ? 'high' : undefined;
if (floorTier && ORDER.indexOf(tier) < ORDER.indexOf(floorTier)) tier = floorTier;
```

| Floor condition (on computed factor **values**) | Minimum tier |
|---|---|
| `businessCriticality ≥ 0.9` **or** `dataSensitivity ≥ 0.9` | `critical` |
| `businessCriticality ≥ 0.8` **or** `securitySensitivity ≥ 0.85` | `high` |

Floors only raise: `ORDER = ['low','medium','high','critical']`; the floor is applied
when the computed tier ranks below it. A 0.95 business value therefore guarantees
`critical` even on a two-line change — the weighted average alone would undershoot what
the change *is*.

## 6. Weight renormalization — honesty

If configured weights do not sum to ~1, the engine renormalizes instead of failing or
silently mis-scaling:

```ts
// Validate weights sum to ~1; renormalize honestly if not (recorded, not silent).
const sum = FACTOR_IDS.reduce((acc, id) => acc + (weights[id] ?? 0), 0);
const norm = sum > 0 ? 1 / sum : 1;
```

The honesty mechanism: each `RiskFactorValue` in the returned assessment carries the
**effective (normalized) weight** in its `weight` field, so any consumer recomputing or
auditing the score sees exactly the weights that were applied — not the configured ones.
An all-zero weight map yields `norm = 1` (a score of 0 with a 0/0 avoided).

## 7. Config overrides

`theqa.config.json` (validated by `configSchema`; unknown keys rejected):

```jsonc
{
  "risk": {
    "weights": { "businessCriticality": 0.2, "changeSurface": 0.15, "defectHistory": 0.12,
                 "codeComplexity": 0.1, "integrationDepth": 0.12, "userImpact": 0.15,
                 "securitySensitivity": 0.08, "dataSensitivity": 0.08 },   // each 0..1
    "thresholds": { "critical": 80, "high": 60, "medium": 35 }              // each 0..100
  }
}
```

`RiskAgent` passes `config.risk.weights` / `config.risk.thresholds` straight into
`assessRisk`, and `project.criticalPaths` into the `businessCriticality` input. A
partially specified injected config is merged section-wise over `DEFAULT_CONFIG`, so
overriding `risk.weights` alone leaves thresholds at 80/60/35.

## 8. Worked example (run against the engine)

Input (3 changed files; a payment-area change touching an API route):

```ts
assessRisk({
  changedFiles: [
    { path: 'src/payments/checkout.ts', status: 'modified', additions: 31, deletions: 12,
      area: 'payment', language: 'typescript', symbols: ['capturePayment'] },
    { path: 'src/payments/cart.ts',     status: 'modified', additions: 9,  deletions: 5,
      area: 'payment', language: 'typescript', symbols: ['cartTotal'] },
    { path: 'src/api/orders.ts',        status: 'modified', additions: 3,  deletions: 1,
      area: 'api', language: 'typescript', symbols: ['createOrder'] },
  ],
  addedLines: 43, removedLines: 18,   // churn = 61
  modulesTouched: 2,                  // src/payments + src/api
  criticalPaths: [],
  boundarySignals: ['payment'],
})
```

Factor values → contributions (engine output; contributions shown to 3 decimals):

| Factor | Value | × Weight | Contribution | Reason (first) |
|---|---|---|---|---|
| businessCriticality | 0.95 | 0.20 | **19.000** | payment logic changed (src/payments/checkout.ts, src/payments/cart.ts) |
| changeSurface | 0.197875 | 0.15 | **2.968** | 3 files changed / 61 lines added/removed |
| defectHistory | 0 | 0.12 | **0.000** | no defect history recorded for changed files |
| codeComplexity | 0.1532 | 0.10 | **1.532** | 61 changed lines across 2 modules |
| integrationDepth | 0.65 | 0.12 | **7.800** | integration surfaces touched: src/api/orders.ts |
| userImpact | 0.52 | 0.15 | **7.800** | user-facing surfaces affected (1 file) |
| securitySensitivity | 0.05 | 0.08 | **0.400** | no security-sensitive markers in change set |
| dataSensitivity | 0.05 | 0.08 | **0.400** | no data-layer markers in change set |
| **Score** | | | **39.9** | |

Derivation checks: changeSurface = min(1, 3/12)×0.7 + min(1, 61/800)×0.3 = 0.175 +
0.022875 = 0.197875. codeComplexity = (61/500)×0.6 + (2/10)×0.4 = 0.0732 + 0.08 =
0.1532. integrationDepth = 0.5 + 1×0.15 = 0.65 (one `api/` hit). userImpact = 0.4 +
1×0.12 = 0.52 (`checkout` matches the user-facing table).

**Tiering:** raw tier from thresholds is `medium` (35 ≤ 39.9 < 60) — but
`businessCriticality = 0.95 ≥ 0.9` triggers the **critical floor**, so the returned
`tier` is `critical`. This is exactly the floor rationale of §5: a small payment change
must never read as "low". (`label: 'INFERRED'`.)

## 9. `renderExplanation` — output format

```ts
renderExplanation(score, tier, contributors): string
```

Format rules (as coded): first line `Risk: <Math.round(score)>/100 (<tier>)`; then for
the first 5 contributors **with contribution ≥ 3**, up to 2 reasons each, one `+
<reason>` line per reason; finally one `→ <RECOMMENDED_ACTION[tier]>` line. For the
worked example above, the exact rendered string is:

```
Risk: 40/100 (critical)
+ payment logic changed (src/payments/checkout.ts, src/payments/cart.ts)
+ integration surfaces touched: src/api/orders.ts
+ protected boundaries crossed: payment
+ user-facing surfaces affected (1 file)
→ Run full regression of affected areas plus targeted E2E of critical flows before merge; require two reviewers.
```

Note `changeSurface` (2.968) is excluded by the `≥ 3` filter, and `defectHistory`
(0.000) by the same rule. The recommended-action table:

| Tier | Recommended action (verbatim) |
|---|---|
| `critical` | Run full regression of affected areas plus targeted E2E of critical flows before merge; require two reviewers. |
| `high` | Run expanded regression of affected areas plus high-value E2E of the changed flows before merge. |
| `medium` | Run relevant regression of affected areas; E2E only for user-facing flows. |
| `low` | Fast PR suite (unit + lint) is sufficient; nightly suite covers the rest. |

## Verification

- [ ] `engine.ts` module doc states `Risk = Σ(weight_i × value_i) × 100`, the default weights, tiers `≥80/≥60/≥35`, and `label: 'INFERRED'` on the returned assessment.
- [ ] `DEFAULT_THRESHOLDS = { critical: 80, high: 60, medium: 35 }`; `tierFor` evaluates top-down.
- [ ] `factors.ts` contains the saturating functions `min(1, files/12)`, `min(1, churn/800)` (weights 0.7/0.3, floor 0.1), `min(1, churn/500)×0.6 + min(1, modules/10)×0.4`, and the linear saturations `0.5+0.15h` / `0.4+0.12h` / `0.6+0.1h` / `0.5+0.1h` with the floors 0.1/0.15/0.05/0.05.
- [ ] Tier-floor code and rationale comment in `engine.ts` match §5 verbatim (0.9/0.9 → critical; 0.8/0.85 → high; `ORDER.indexOf` comparison).
- [ ] `churnHotspots` in `core/util/git.ts`: `maxCommits = 200` default, fix-pattern regex `(^|\s)(fix|bug|hotfix|patch|regression)(\s|:|$)`, fix commits count 2, max-normalized; git failure → `{}`.
- [ ] Renormalization: `norm = sum > 0 ? 1/sum : 1`; effective weights are visible per factor in `RiskFactorValue.weight`.
- [ ] Re-running the §8 input through `assessRisk` reproduces score 39.9, tier `critical`, and the §9 explanation string (factors 0.95 / 0.197875 / 0 / 0.1532 / 0.65 / 0.52 / 0.05 / 0.05).
- [ ] `renderExplanation`: `contribution >= 3` filter, `slice(0, 5)` contributors, `slice(0, 2)` reasons per contributor, `Risk: <n>/100 (<tier>)` header, `→` action tail.
- [ ] The sponsor line appears in the header blockquote of this document only.
