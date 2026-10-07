# Test Selection — The-QA-Skill

> Sponsored by xShredo.dev → https://xshredo.com/promo/anytest

**Audience:** contributors and agent authors. This document specifies the
smallest-high-confidence-set algorithm in `packages/core/src/impact/` (`diff.ts`,
`select.ts`) exactly as implemented, ending with a worked example whose output was
produced by running `classifyRouting` + `selectTests` on the exact inputs shown.

---

## 1. Algorithm overview

From the module doc of `impact/select.ts`:

1. Build the import graph: for every test file, resolve relative/aliased imports
   transitively (bounded depth) to the source files it covers (`computeCoverage`).
2. Map changed files → tests that cover them (direct or transitive).
3. Rank by risk: payment/auth/db-adjacent covered files raise priority
   (`riskTierForCoveredFiles`).
4. Apply pyramid intelligence: if the same covered file is also covered by lower-layer
   tests, E2E tests are demoted (reason recorded, not deleted).
5. Apply routing policy from the change classification (`classifyRouting`).
6. Every selected test carries explicit file-level reasons.

The pipeline is deterministic: identical change set + inventory + options → identical
`SelectionResult`. The result label is `'INFERRED'` — selection reasons are derived
from file paths and import edges, not from observed executions.

## 2. Diff parsing (`analyzeDiff`)

```ts
analyzeDiff(cwd: string, range: string): Promise<DiffParseResult>
// DiffParseResult = { files: ChangedFile[], addedLines, removedLines, range }
```

Three git commands, machine-parsed (no diff-text scraping):

| Command | Used for |
|---|---|
| `git diff --name-status <range>` | path + status (`A`→added, `D`→deleted, `R…`→renamed with the new path taken from the third column, else modified) |
| `git diff --numstat <range>` | additions/deletions per path; rename paths normalized (`old => new`, braces stripped); `-` binary counters read as 0 |
| `git diff --unified=0 <range> -- *.ts *.tsx *.js *.jsx *.mjs *.cjs *.py *.go *.java` | symbol extraction source |

**Symbol extraction** (`symbolsFromDiff`) scans only lines starting with `+` (excluding
`+++`) for exported/declared symbols:

```
export (async)? (function|class|const|let|var|interface|type|enum) NAME
export { A, B as C }        def NAME (python)      class NAME
func NAME (go)              public (async)? T NAME(   (java/kt/cs-shaped)
```

Results are cleaned (`as`-renames resolved), validated against
`/^[A-Za-z_$][\w$]*$/`, deduplicated, and capped at **20 symbols per file**. Language is
derived from the extension (`languageFor`: ts/tsx → typescript, py → python, …, unknown →
`other`). Each `ChangedFile` gets its `area` from `classifyArea` (§3).

## 3. Area classification — precedence table

`classifyArea(path)` (`risk/factors.ts`) applies regex tables in a fixed order; **first
match wins**, and one file gets exactly one area:

| Precedence | Area | Patterns (case-insensitive) |
|---|---|---|
| 1 | `auth` | `auth`, `login\|logout\|session\|sso\|oauth\|jwt\|token\|credential\|password` |
| 2 | `payment` | `pay\|billing\|invoice\|checkout\|cart\|subscription\|charge\|refund\|pricing\|stripe\|paypal` |
| 3 | `db` | `migrat\|schema\|model\|entity\|repositor\|orm\|sql\|query\|database`, `db[/\\]` |
| 4 | `api` | `api[/\\]`, `route\|controller\|endpoint\|graphql\|resolvers?\|handlers?` |
| 5 | `config` | `config\|\.env\|settings\|tsconfig\|webpack\|vite\|rollup\|babel\|eslint\|tslint\|dockerfile`, `\.ya?ml$` |
| 6 | `test` | `(^|[/\\])(test\|tests\|spec\|__tests__\|e2e)[/\\]`, `\.(test\|spec)\.[jt]sx?$` |
| 7 | `docs` | `\.md$`, `(^|[/\\])docs?[/\\]` |
| 8 | `infra` | `(^|[/\\])\.github[/\\]`, `(^|[/\\])\.gitlab`, `jenkinsfile`, `(^|[/\\])infrastructure[/\\]`, `terraform\|cloudformation\|helm` |
| 9 | `ui` | `component\|page\|view\|screen\|widget\|layout\|css\|scss\|style`, `\.tsx$` |
| 10 | `unknown` | *(no match)* |

Precedence matters: `src/auth/payment-gateway.ts` is `auth` (not payment);
`migrations/2024_users.sql` is `db` — but `src/auth/session.ts` beats the `api` pattern
that would match nothing there anyway. Because `auth` outranks `payment`, a checkout page
under an auth directory is treated as an auth-boundary file.

## 4. Routing classification (`classifyRouting`)

```ts
classifyRouting(files: ChangedFile[]): ChangeRouting
// ChangeRouting = { cssOnly, paymentRelated, migrationRelated, authRelated, docsOnly, testOnly, boundarySignals }
```

`substantive` = files whose area is not `docs`. The booleans:

| Field | True when |
|---|---|
| `cssOnly` | `substantive.length > 0` and every substantive path matches `\.(css\|scss\|sass\|less\|styl)$` or contains `style` |
| `paymentRelated` | any substantive file has area `payment` |
| `migrationRelated` | any substantive file has area `db` |
| `authRelated` | any substantive file has area `auth` |
| `docsOnly` | `substantive.length === 0 && files.length > 0` |
| `testOnly` | every substantive file has area `test` (and `files.length > 0`) |
| `boundarySignals` | `auth` / `payment` / `database` for the matching areas, plus `webhook` (path contains `webhook`) and `messaging` (path contains `queue\|broker\|event`) |

These feed both the selection hints (§7) and the risk engine's
`integrationDepth` boundary reasons.

## 5. Import-closure coverage (`computeCoverage`)

```ts
computeCoverage(testFilePath, allFiles: Set<string>,
                pathAliases: Array<{prefix: string; target: string}> = [],
                maxDepth = 12): string[]
```

BFS over import edges starting at the test file. **Resolution rules** (`resolveImport`):

- Specifiers not starting with `.`, `@/`, or `~/` are external packages — never followed.
- Relative specifiers resolve against the importing file's directory; alias specifiers
  resolve through the first `pathAliases` entry whose `prefix` matches (`@/` and `~/`
  are handled via the same list — a repo using them supplies e.g. `{prefix: '@/',
  target: 'src'}`).
- Candidate set tried in order: the raw path, then `.ts .tsx .js .jsx .mjs .cjs`
  extensions, then `/index.ts`, `/index.js` (first hit in `allFiles` wins).
- The test file itself is excluded from its own closure; each resolved file is visited
  once (`seen`); traversal stops at `maxDepth` (default **12**) edges.
- Files are read relative to `process.cwd()`; unreadable files terminate that branch
  silently.

`import { analyzeCoverage }` note: the *suite-level* coverage report is a separate core
engine (`coverage/analyze.ts`); `computeCoverage` is the per-test closure used to build
`TestInventoryEntry.covers`.

## 6. Selection scoring

```ts
selectTests(changedFiles: ChangedFile[], inventory: TestInventoryEntry[],
            routing?: ChangeRouting,
            opts: { routing?; alwaysInclude?: string[]; maxPrE2E?: number;
                    policy?: 'pr' | 'pre_merge' | 'nightly' | 'release' | 'post_deploy' } = {})
  : SelectionResult
```

### 6.1 Membership — why a test is selected at all

A test is a *candidate* only when it has at least one reason:

- **direct hit**: `test.covers ∩ changedPaths ≠ ∅` → reason `covers changed file[s]: <first 3>`;
- **alwaysInclude**: `test.filePath` or any covered path contains one of the configured
  patterns → reason `matched alwaysInclude pattern from config`.

Everything else lands in `unaffected` — selection never pads the run with
"might as well" tests.

### 6.2 Priority — `riskTierForCoveredFiles`

Priority comes from the areas of the changed files the test covers:

| Covered changed-file areas | Priority |
|---|---|
| `payment` or `auth` | `critical` |
| `db` or `api` | `high` |
| any changed file covered (other areas) | `medium` |
| *(only alwaysInclude matched)* | `low` |

### 6.3 Modifiers

| Rule | Effect |
|---|---|
| `routing.paymentRelated` and priority `critical` | adds reason `payment area change → heavy validation per routing policy` |
| `routing.authRelated` and layer ≠ `unit` | adds reason `auth boundary change → risk priority elevated` |
| `routing.cssOnly` and layer ∉ {`e2e`, `visual`} | priority forced to `low`, reason `css-only change set → deprioritized` (visual + e2e smoke stay untouched) |
| `routing.migrationRelated` and test name/path matches `/data\|integrity\|migrat/i` | priority forced to `critical`, reason `migration change → data-integrity validation elevated` |
| **Pyramid demotion** (e2e only): another inventory test of lower layer (`layerRank`: unit < integration < contract < api < a11y < visual < e2e < security < performance < manual) covers one of the same changed files | adds reason `lower-layer tests already cover this changed file — E2E retained only because the flow is business-critical` |
| **E2E budget** (layer `e2e`): running count exceeds `maxPrE2E` **and `policy === 'pr'`** | priority forced to `low`, reason `PR policy e2e budget (<N>) exhausted → deferred to pre-merge suite` |
| **Flake-aware warning**: `test.flakeScore >= 70` | adds reason `known flaky (score <NN>) → run isolated, do not block merge on first failure` |

`maxPrE2E` defaults to **25** (matching `selection.maxPrE2E` in `theqa.config.json`,
minimum 1). The budget exists because e2e is the most expensive, most flake-prone layer:
beyond 25 e2e tests in a PR run, the rest are *deferred, not deleted* — the reason string
records the deferral and the pre-merge suite picks them up. The budget applies only to
the `pr` policy; `pre_merge`/`nightly`/`release`/`post_deploy` runs are exactly where
deferred e2e belongs.

Final ordering: priority rank (critical → high → medium → low), then `avgDurationMs`
ascending — the fastest high-signal tests first.

## 7. Output contract

```ts
interface SelectionResult {
  selected: SelectedTest[];            // { test, priority: RiskTier, reasons: string[] }
  unaffected: TestInventoryEntry[];
  routing: RoutingHint[];              // { rule, triggered, action, reason }
  summary: string;
  label: 'INFERRED';
}
```

- `selected[]` — every entry carries **per-test file-level reasons**; a reason-less
  selection is a bug by construction.
- `unaffected[]` — inventory tests with no coverage relationship to the change set.
- `routing[]` — always the full 6-hint table with `triggered` flags, so consumers see
  which policies fired *and* which did not:

| Rule | Triggered by | Action (verbatim) |
|---|---|---|
| `css-only-change` | `routing.cssOnly` | Skip API/DB regression suites; run visual + component smoke only. |
| `payment-change` | `routing.paymentRelated` | Heavy validation: payment unit + API + contract + high-value E2E. |
| `db-migration` | `routing.migrationRelated` | Run data-integrity + migration tests; verify rollback path. |
| `auth-change` | `routing.authRelated` | Elevate authz matrix tests, session lifecycle, token expiry tests. |
| `docs-only` | `routing.docsOnly` | No test execution required; link-check docs if CI has it. |
| `test-only` | `routing.testOnly` | Run affected test files; no product regression expected. |

- `summary` — when nothing covers the change set:
  `No inventory test covers the change set — coverage gap; generate tests for the
  affected files.` Otherwise: `<S> of <I> inventory tests selected (smallest
  high-confidence set); <U> unaffected.`
- Policy modes: `pr` (default) keeps the set minimal (e2e budget enforced);
  `pre_merge`, `nightly`, `release`, `post_deploy` expand — the budget is a PR-only
  constraint, and per-policy command flags are a documented hook point in the execution
  agent.

## 8. Worked example (run against the engine)

**Change set (3 files):**

| Path | Status | +/− | Area |
|---|---|---|---|
| `src/payments/checkout.ts` | modified | 31/12 | `payment` |
| `src/styles/theme.css` | modified | 6/2 | `ui` |
| `docs/payments.md` | modified | 12/0 | `docs` |

**Routing:** `{cssOnly: false, paymentRelated: true, migrationRelated: false,
authRelated: false, docsOnly: false, testOnly: false, boundarySignals: ['payment']}` —
`checkout.ts` keeps `cssOnly` false even though a stylesheet changed (not *every*
substantive file is CSS), and the docs file is excluded from substantive entirely.

**Inventory (5 tests)** with `covers` as shown below; `policy: 'pr'`, `maxPrE2E: 25`.

**Engine output** (`selectTests(...)`):

| Selected test | Layer | Priority | Reasons (verbatim, in order) |
|---|---|---|---|
| `tests/payments.test.ts` | unit | `critical` | `covers changed file: src/payments/checkout.ts` · `payment area change → heavy validation per routing policy` |
| `tests/checkout.spec.ts` | e2e | `critical` | `covers changed file: src/payments/checkout.ts` · `payment area change → heavy validation per routing policy` · `lower-layer tests already cover this changed file — E2E retained only because the flow is business-critical` |
| `tests/theme.test.ts` | unit | `medium` | `covers changed file: src/styles/theme.css` |

Ordering note: the unit tests precede the 42-second e2e spec (priority tie broken by
`avgDurationMs`). `tests/theme.test.ts` is `medium` (not high/critical): `ui` is not in
the payment/auth/db/api escalation set.

| Unaffected | Why |
|---|---|
| `tests/api/orders.test.ts` (covers `src/api/orders.ts`) | no covered path changed |
| `tests/utils/date.test.ts` (covers `src/utils/date.ts`) | no covered path changed |

`summary`: `3 of 5 inventory tests selected (smallest high-confidence set); 2
unaffected.` — `label: 'INFERRED'`. The `payment-change` routing hint is the only one
with `triggered: true`.

## Verification

- [ ] `analyzeDiff` uses `--name-status`, `--numstat`, and `--unified=0` (code extensions only); rename normalization and the 20-symbol cap are in `impact/diff.ts`.
- [ ] `AREA_PATTERNS` order in `risk/factors.ts` matches §3 exactly (auth → payment → db → api → config → test → docs → infra → ui → unknown); `classifyArea` returns the first match.
- [ ] `classifyRouting` computes `substantive` by excluding `docs`, defines `cssOnly` over every substantive file, and `docsOnly` as `substantive.length === 0 && files.length > 0`.
- [ ] `computeCoverage`: relative + `@/` + `~/` specifiers only, alias list, 9-extension/index candidate order, self-exclusion, `maxDepth = 12`, reads via `process.cwd()`.
- [ ] `riskTierForCoveredFiles`: payment/auth → critical; db/api → high; any hit → medium; else low.
- [ ] The pyramid demotion reason string, e2e budget reason string, and flake reason string match the source verbatim; `maxPrE2E` default 25 applies only when `policy === 'pr'`; sorting is priority rank then `avgDurationMs`.
- [ ] `buildRoutingHints` returns all 6 rules with the verbatim actions of §7; `label` is `'INFERRED'`; the empty-selection summary string matches §7.
- [ ] Re-running the §8 inputs reproduces the exact selections, priorities, reasons, and summary.
- [ ] The sponsor line appears in the header blockquote of this document only.
