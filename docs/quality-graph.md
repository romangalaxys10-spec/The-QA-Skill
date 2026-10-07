# Quality Graph

**Audience:** contributors extending traceability and impact analysis.
**Source of truth:** `packages/graph/src/nodes.ts` (vocabulary), `packages/graph/src/graph.ts` (store, `traceRequirement`, `affectedTests`, persistence, GraphViz), `packages/graph/src/builders.ts` (`graphFromContext`, `addExecutionResult`, `connectDefect`), `packages/graph/test/` (behavioral contracts).

The Quality Graph is the traceability backbone: requirements trace to features, features implement code units, tests cover code units, executions produce evidence, and defects are caused by code units. It answers the two questions every QA orchestrator asks — *what backs this requirement?* (`traceRequirement`) and *which tests must run because these files changed?* (`affectedTests`).

## Node kinds (12)

`NodeKind` — canonical order as declared in `nodes.ts`:

| Kind | Represents |
|---|---|
| `Requirement` | A verifiable requirement (typically `REQ-<slug>-<n>` from the requirements agent) |
| `Feature` | A product feature/area (from `ctx.affectedFeatures`, falling back to `ctx.application.type`) |
| `CodeUnit` | A unit of implementation — path-derived ones use the `unit:<path>` id convention |
| `ApiEndpoint` | An API surface element |
| `UiElement` | A UI surface element |
| `Test` | A test (id = testId from inventory/events) |
| `Execution` | One run attempt of a test (`exec:<runId>:<testId>:<retryIndex>`) |
| `Evidence` | One captured artifact (`ev:<runId>:<testId>:<retryIndex>`) |
| `Defect` | A known defect |
| `Commit` | A commit (id = sha; attrs carry branch, range) |
| `File` | A file (id = repo-relative path) |
| `Symbol` | An exported symbol (id = raw symbol name; attrs carry its file) |

Nodes are `{ kind, id, label, attrs }`; `attrs` values are restricted to `string | number | boolean` (`isAttrValue`; `compactAttrs` strips `undefined` before storage).

## Edge kinds (8)

`EdgeKind` — canonical order, with the canonical endpoint kinds per `EDGE_ENDPOINT_DEFAULTS` (used to auto-create placeholder nodes when an edge references a missing endpoint):

| Edge kind | From → To (canonical) | Meaning |
|---|---|---|
| `traces_to` | `Requirement` → `Feature` | requirement is realized by feature |
| `covers` | `Test` → `CodeUnit` (or `File`) | test exercises the unit/file |
| `implements` | `Feature` → `CodeUnit` | feature is implemented here |
| `executed_as` | `Test` → `Execution` | test attempt record |
| `produced` | `Execution` → `Evidence` | attempt produced artifact |
| `caused_by` | `CodeUnit` → `Defect` (also `Test` → `Defect` via `connectDefect`) | defect lives here |
| `changed_in` | `Commit` → `File` | commit provenance |
| `references` | `Symbol` → `File` | symbol lives in file |

## Canonical chains

Two chains are load-bearing:

```
Requirement →traces_to→ Feature →implements→ CodeUnit ←covers← Test →executed_as→ Execution →produced→ Evidence
CodeUnit →caused_by→ Defect
Commit →changed_in→ File;  Symbol →references→ File
```

In words: **Requirement→Feature→CodeUnit←Test→Execution→Evidence**, plus **CodeUnit→Defect** for defect linkage and **Commit→File→Symbol** for provenance. `traceRequirement` walks the first chain; `affectedTests` walks the provenance chains backwards.

## traceRequirement algorithm

`traceRequirement(requirementId)` (`graph.ts`):

1. Look up the node; throw `GraphError` if absent or `kind !== 'Requirement'`.
2. `features` = out-neighbors via `traces_to`.
3. `codeUnits` = out-neighbors of every feature via `implements` (deduped, insertion order kept).
4. `tests` = in-neighbors of every code unit via `covers`, filtered to `kind === 'Test'` nodes.
5. `executions` = out-neighbors of tests via `executed_as`; `evidence` = out-neighbors of executions via `produced`.
6. `defects` = out-neighbors of code units via `caused_by`.

Result shape `TraceChain`: `{ requirement, features, codeUnits, tests, executions, evidence, defects }` — all id lists deduplicated, insertion order preserved. This is exactly the data the per-requirement traceability section needs (below).

## affectedTests routes

`affectedTests(changedFilePaths)` returns `{ tests: string[], reasons: string[] }`. Per changed path, four routes (all documented in `reasons`):

1. **Direct file coverage** — `Test -covers-> File(path)`.
2. **Code-unit coverage** — tests covering the `unit:<path>` CodeUnit **or** a bare path-keyed CodeUnit.
3. **Symbol coverage** — `Symbol -references-> File(path)` in-edge; then CodeUnits named after the symbol **or declaring it** via `attrs.symbol` / comma-separated `attrs.symbols`; tests covering those units.
4. **Commit provenance** — `Commit -changed_in-> File(path)` in-edges add a reason (`commit '<id>' changed '<path>'`) even when no test is implicated — provenance is context, not a test signal.

Untracked paths yield the reason `path '<p>' is not tracked in the quality graph` — never a silent empty result. `neighbors()` likewise throws for unknown ids ("silent empty results hide wiring bugs") and composes direction/kind/edgeKind filters.

## Id conventions

- Path-derived CodeUnits: **`unit:<path>`** — never collides with the `File` node sharing the same path string. Test `covers` edges prefer the `unit:<path>` CodeUnit when it exists, else the `File` node itself (out-of-diff covered paths are declared as `File` nodes rather than letting `addEdge` auto-create a CodeUnit placeholder).
- Executions: **`exec:<runId>:<testId>:<retryIndex>`**; Evidence: **`ev:<runId>:<testId>:<retryIndex>`** — `retryIndex` distinguishes retry attempts so no attempt clobbers another.
- Symbols: the raw symbol name as id, with `references` edges to their file and `attrs.file` carrying the path.
- Graph ids are globally unique across kinds; `addNode` is idempotent (last write wins, no duplicates); duplicate edges (same from/to/kind) are no-ops keeping the first attrs.

## Persistence

- `toJSON()` returns a defensive `GraphPayload { nodes, edges }`.
- `QualityGraph.fromJSON(payload)` rebuilds, **validating everything**: unknown node/edge kinds, empty ids, non-string labels, and non-`string|number|boolean` attr values each throw `GraphError` with the payload path (`nodes[3]: ...`). Edges referencing missing endpoints auto-create placeholders, matching `addEdge` semantics.
- `save(filePath)` pretty-prints JSON (creating parent dirs); `QualityGraph.load(filePath)` reads and parses, wrapping IO/JSON failures in `GraphError`. Round-tripping is lossless because attrs values are JSON-native scalars by construction.

## GraphViz export

`toGraphViz()` emits a `digraph quality { ... }` with one line per node (`"id" [label="label", kind="Kind"];`) and per edge (`"from" -> "to" [label="edgeKind"];`), with backslash/quote escaping for safe quoted identifiers. Pipe it to `dot` for review diagrams of a requirement's chain.

## Builders

**`graphFromContext(ctx)`** maps a flat `QAContext` onto the canonical chain with six documented, ordered rules:

1. Features from `ctx.affectedFeatures` (fallback `[ctx.application.type]`).
2. Requirements from `ctx.requirements` (attrs: priority/status/source/criteriaCount); `traces_to` edges — single requirement attaches all features; multiple requirements attach a feature to the first requirement whose title/criteria mention it, else the first requirement.
3. Every changed file becomes a `File` node (attrs: area/status/additions/deletions/language) + a `unit:<path>` CodeUnit (attrs: path, `symbols` as a comma-joined list); symbols become `Symbol` nodes with `references` edges; the provenance commit gets `changed_in` edges to every changed file.
4. `ctx.knownDefects` become `Defect` nodes with `caused_by` edges from each path's `unit:<path>`.
5. `ctx.existingTests` become `Test` nodes whose `covers` edges target `unit:<path>` when present, else the `File` node (declared if missing).
6. `implements` edges connect by name match (feature name appears in the unit's path/id); with exactly one feature, unmatched units attach to it.

**`addExecutionResult(graph, event)`** records one attempt: creates the `Test` node when missing (never clobbers), adds the `exec:` Execution node (attrs: runId, status, durationMs, framework, environment, timestamp, retryIndex, browser, device, commit, branch, failureCategory, errorType) and the `ev:` Evidence node (`evidenceKind: 'test_output'`), then wires `executed_as` and `produced`.

**`connectDefect(graph, defect, testIds)`** creates-or-reuses the `Defect` node (attrs: severity/status + extras) and links every test id with `Test -caused_by-> Defect`, auto-creating placeholder Test nodes; idempotent by `addEdge` semantics.

## How the graph feeds requirements traceability reporting

A per-requirement traceability section is a direct projection of `traceRequirement(id)`:

| Report row | Source field |
|---|---|
| Requirement (title, priority, status) | the `Requirement` node itself |
| Acceptance criteria count | `attrs.criteriaCount` (set by the builder) |
| Features realizing it | `chain.features` |
| Code implementing it | `chain.codeUnits` (each `unit:<path>` maps back to a file) |
| Tests covering it | `chain.tests` |
| Executions (runs, statuses, retries) | `chain.executions` (attrs carry status/durationMs/retryIndex) |
| Evidence artifacts | `chain.evidence` (locations map to bundle paths) |
| Open defects | `chain.defects` |

The honest-reporting rule applies downstream too: a requirement with no tests shows an empty `tests` list — *traceability gaps are reported as gaps*, never interpolated. Combined with `affectedTests`, the same graph also powers impact selection and the PR "scope of testing" summaries in the reporting package.

## Worked example (hand-verified this session)

Minimal payload wiring one requirement through the full canonical chain (10 nodes, 8 edges):

```json
{
  "nodes": [
    { "kind": "Requirement", "id": "REQ-101", "label": "Usage metering per tenant",
      "attrs": { "priority": "must", "status": "approved" } },
    { "kind": "Feature", "id": "usage-metering", "label": "usage-metering", "attrs": {} },
    { "kind": "File", "id": "app/api/usage.ts", "label": "usage.ts", "attrs": { "area": "api" } },
    { "kind": "CodeUnit", "id": "unit:app/api/usage.ts", "label": "usage.ts",
      "attrs": { "path": "app/api/usage.ts", "symbols": "meterUsage" } },
    { "kind": "Symbol", "id": "meterUsage", "label": "meterUsage", "attrs": { "file": "app/api/usage.ts" } },
    { "kind": "Test", "id": "usage-api-metering", "label": "meters every successful request",
      "attrs": { "layer": "api", "framework": "vitest" } },
    { "kind": "Execution", "id": "exec:run-9f2c1d:usage-api-metering:0",
      "label": "meters every successful request → failed",
      "attrs": { "runId": "run-9f2c1d", "status": "failed", "durationMs": 812, "environment": "ci" } },
    { "kind": "Evidence", "id": "ev:run-9f2c1d:usage-api-metering:0", "label": "test_output",
      "attrs": { "evidenceKind": "test_output" } },
    { "kind": "Defect", "id": "DEF-77", "label": "double-metered retries",
      "attrs": { "severity": "major", "status": "open" } },
    { "kind": "Commit", "id": "9f2c1de", "label": "9f2c1de", "attrs": { "branch": "feat/usage-metering" } }
  ],
  "edges": [
    { "from": "REQ-101", "to": "usage-metering", "kind": "traces_to" },
    { "from": "usage-metering", "to": "unit:app/api/usage.ts", "kind": "implements" },
    { "from": "meterUsage", "to": "app/api/usage.ts", "kind": "references" },
    { "from": "usage-api-metering", "to": "unit:app/api/usage.ts", "kind": "covers" },
    { "from": "usage-api-metering", "to": "exec:run-9f2c1d:usage-api-metering:0", "kind": "executed_as" },
    { "from": "exec:run-9f2c1d:usage-api-metering:0", "to": "ev:run-9f2c1d:usage-api-metering:0", "kind": "produced" },
    { "from": "unit:app/api/usage.ts", "to": "DEF-77", "kind": "caused_by" },
    { "from": "9f2c1de", "to": "app/api/usage.ts", "kind": "changed_in" }
  ]
}
```

Executed against the real engine (`QualityGraph.fromJSON` shape, built node-by-node + `addEdge`):

- `traceRequirement('REQ-101')` → `{ requirement: 'REQ-101', features: ['usage-metering'], codeUnits: ['unit:app/api/usage.ts'], tests: ['usage-api-metering'], executions: ['exec:run-9f2c1d:usage-api-metering:0'], evidence: ['ev:run-9f2c1d:usage-api-metering:0'], defects: ['DEF-77'] }`
- `affectedTests(['app/api/usage.ts'])` → tests `['usage-api-metering']` with reasons for route 2 (`covers code unit 'unit:app/api/usage.ts'`), route 3 (symbol `meterUsage` referenced by the changed file and covered by the test), and route 4 (`commit '9f2c1de' changed 'app/api/usage.ts'`). Route 1 did not fire because the `covers` edge targets the CodeUnit — matching the builder convention.
- `nodeCount === 10`, `edgeCount === 8`; `toGraphViz()` renders all nodes with `kind` attributes and all edges labeled by kind.

## Extension notes

1. New node/edge kinds require updating `NODE_KINDS`/`EDGE_KINDS` **and** `EDGE_ENDPOINT_DEFAULTS` together — the validation unions and the placeholder defaults must not drift.
2. Consumers (gate, reporting, MCP) switch on the canonical chains; keep `traceRequirement`'s chain membership semantics stable or version the payload.
3. Builders are deterministic by contract: same `QAContext`/`TestEvent` in, same graph out — no timestamps or randomness in node/edge construction (ids derive from paths, runIds, testIds, retryIndex).

## Verification

- [ ] The 12 node kinds and 8 edge kinds above match `nodes.ts` canonical arrays in order; attrs restricted to `string | number | boolean`.
- [ ] `EDGE_ENDPOINT_DEFAULTS` pairs match the edge-kind table; missing endpoints auto-create placeholders with `placeholder: true`.
- [ ] `traceRequirement` steps verified against `graph.ts` (throws for unknown/non-Requirement ids; dedup + insertion order).
- [ ] All four `affectedTests` routes verified, including the symbol route's `attrs.symbol` / comma-separated `attrs.symbols` lookup and the commit-provenance context reason; untracked paths produce an explicit reason.
- [ ] Id conventions verified in `builders.ts`: `unit:<path>`, `exec:runId:testId:retryIndex`, `ev:runId:testId:retryIndex`, raw symbol names.
- [ ] `fromJSON` validation throws `GraphError` with payload paths for unknown kinds / bad ids / non-attr values; `save`/`load` round-trip lossless.
- [ ] Worked example executed against `packages/graph` this session with the exact trace/affectedTests/node/edge results quoted above.
- [ ] Builder rules 1–6 in `graphFromContext` match the numbered doc-comment contract in `builders.ts`.
- [ ] Traceability projection table's fields exist on the nodes/chain (criteriaCount, severity/status, run metadata attrs).
