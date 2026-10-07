import type { QAContext, TestEvent } from '@the-qa-skill/core';

import { QualityGraph } from './graph.js';
import { compactAttrs } from './nodes.js';
import type { GraphNode } from './nodes.js';

/**
 * @the-qa-skill/graph — builders that populate a QualityGraph from platform
 * data structures: the shared QAContext, runner TestEvents, and defect reports.
 *
 * Conventions used by these builders (documented, deterministic):
 *  - Path-derived CodeUnit nodes use the id `unit:<path>` so they never clash
 *    with File nodes that share the same path string.
 *  - Symbol nodes use the raw symbol name as id and reference their file via
 *    the `references` edge.
 *  - Test `covers` edges target a `unit:<path>` CodeUnit when one exists,
 *    otherwise the File node itself.
 */

/** Loose defect description accepted by `connectDefect`. */
export interface DefectInput {
  id: string;
  title?: string;
  severity?: string;
  status?: string;
  /** Extra graph attrs copied onto the Defect node verbatim. */
  attrs?: Record<string, string | number | boolean>;
}

/** Basename of a POSIX or Windows path — used for compact node labels. */
function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Truncate a string to `max` chars, appending an ellipsis when cut. */
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Heuristically map a flat QAContext onto the canonical trace chain.
 *
 * Deterministic rules (in order):
 *  1. Requirement nodes come from `ctx.requirements`; Feature nodes from
 *     `ctx.affectedFeatures` (falling back to `ctx.application.type`).
 *  2. Requirement -traces_to-> Feature edges: with a single requirement all
 *     features attach to it; with several, a feature attaches to the first
 *     requirement whose title/criteria mention it, else to the first
 *     requirement.
 *  3. Every changed file becomes a File node plus a `unit:<path>` CodeUnit
 *     (carrying its exported symbols); symbols become Symbol nodes with
 *     `references` edges; the provenance commit gets `changed_in` edges.
 *  4. Known defects become Defect nodes with `caused_by` edges from their
 *     path's code unit.
 *  5. Existing tests become Test nodes whose `covers` edges target the
 *     `unit:<path>` CodeUnit when present, else a File node (created if
 *     missing).
 *  6. Feature -implements-> CodeUnit edges connect by name match (the code
 *     unit's path/id contains the feature name); when there is exactly one
 *     feature, unmatched units attach to it.
 */
export function graphFromContext(ctx: QAContext): QualityGraph {
  const graph = new QualityGraph();

  // 1 — Features
  const features = ctx.affectedFeatures.length > 0 ? ctx.affectedFeatures : [ctx.application.type];
  for (const feature of features) {
    graph.addNode({ kind: 'Feature', id: feature, label: feature, attrs: {} });
  }

  // 2 — Requirements + traces_to
  for (const requirement of ctx.requirements) {
    graph.addNode({
      kind: 'Requirement',
      id: requirement.id,
      label: requirement.title,
      attrs: compactAttrs({
        priority: requirement.priority,
        status: requirement.status,
        source: requirement.source,
        criteriaCount: requirement.criteria.length,
      }),
    });
  }
  if (ctx.requirements.length === 1) {
    const only = ctx.requirements[0];
    if (only) for (const feature of features) graph.addEdge({ from: only.id, to: feature, kind: 'traces_to' });
  } else if (ctx.requirements.length > 1) {
    const lower = (s: string): string => s.toLowerCase();
    for (const feature of features) {
      const needle = lower(feature);
      const match = ctx.requirements.find(
        (r) => lower(r.title).includes(needle) || r.criteria.some((c) => lower(c).includes(needle)),
      );
      const target = match ?? ctx.requirements[0];
      if (target) graph.addEdge({ from: target.id, to: feature, kind: 'traces_to' });
    }
  }

  // 3 — Files, code units, symbols, commit provenance
  for (const file of ctx.changedFiles) {
    graph.addNode({
      kind: 'File',
      id: file.path,
      label: basename(file.path),
      attrs: compactAttrs({ area: file.area, status: file.status, additions: file.additions, deletions: file.deletions, language: file.language }),
    });
    const unitId = `unit:${file.path}`;
    graph.addNode({
      kind: 'CodeUnit',
      id: unitId,
      label: basename(file.path),
      attrs: compactAttrs({ path: file.path, symbols: file.symbols.length > 0 ? file.symbols.join(',') : undefined }),
    });
    for (const symbol of file.symbols) {
      graph.addNode({ kind: 'Symbol', id: symbol, label: symbol, attrs: { file: file.path } });
      graph.addEdge({ from: symbol, to: file.path, kind: 'references' });
    }
  }
  if (ctx.provenance.commit) {
    graph.addNode({ kind: 'Commit', id: ctx.provenance.commit, label: ctx.provenance.commit, attrs: compactAttrs({ branch: ctx.provenance.branch, range: ctx.provenance.range }) });
    for (const file of ctx.changedFiles) {
      graph.addEdge({ from: ctx.provenance.commit, to: file.path, kind: 'changed_in' });
    }
  }

  // 4 — Known defects
  for (const defect of ctx.knownDefects) {
    graph.addNode({
      kind: 'Defect',
      id: defect.id,
      label: defect.title,
      attrs: { severity: defect.severity, status: defect.status },
    });
    for (const path of defect.paths) {
      const unitId = `unit:${path}`;
      if (!graph.hasNode(unitId)) {
        graph.addNode({ kind: 'CodeUnit', id: unitId, label: basename(path), attrs: { path } });
      }
      graph.addEdge({ from: unitId, to: defect.id, kind: 'caused_by' });
    }
  }

  // 5 — Existing tests: covers edges prefer the path code unit, else the file.
  for (const test of ctx.existingTests) {
    graph.addNode({
      kind: 'Test',
      id: test.testId,
      label: test.name,
      attrs: compactAttrs({ layer: test.layer, framework: test.framework, filePath: test.filePath, flakeScore: test.flakeScore }),
    });
    for (const covered of test.covers) {
      const unitId = `unit:${covered}`;
      if (graph.hasNode(unitId)) {
        graph.addEdge({ from: test.testId, to: unitId, kind: 'covers' });
        continue;
      }
      if (!graph.hasNode(covered)) {
        // Covered paths outside the diff are still files — declare them as
        // such instead of letting addEdge auto-create a CodeUnit placeholder.
        graph.addNode({ kind: 'File', id: covered, label: basename(covered), attrs: {} });
      }
      graph.addEdge({ from: test.testId, to: covered, kind: 'covers' });
    }
  }

  // 6 — Feature implements CodeUnit (name-in-path match, single-feature fallback).
  const units = graph.allNodes().filter((n: GraphNode) => n.kind === 'CodeUnit');
  for (const unit of units) {
    const lookup = `${String(unit.attrs['path'] ?? '')} ${unit.id}`.toLowerCase();
    const matched = features.find((feature) => lookup.includes(feature.toLowerCase()));
    if (matched) {
      graph.addEdge({ from: matched, to: unit.id, kind: 'implements' });
    } else if (features.length === 1) {
      const only = features[0];
      if (only) graph.addEdge({ from: only, to: unit.id, kind: 'implements' });
    }
  }

  return graph;
}

/** One-line human summary of a test event, used as the Evidence node summary. */
function executionSummary(event: TestEvent): string {
  const base = `test '${event.testId}' ${event.status} in ${event.durationMs}ms on ${event.environment}`;
  if (event.errorType) return `${base} — ${event.errorType}: ${truncate(event.errorMessage ?? '', 160)}`;
  return base;
}

/**
 * Record one test execution attempt in the graph: an Execution node (attrs
 * carry run metadata), an Evidence node (kind 'test_output'), and the
 * `executed_as` / `produced` edges. The Test node is created when missing;
 * existing nodes are never clobbered. Retries are distinguished by
 * `retryIndex` in the execution/evidence ids.
 */
export function addExecutionResult(graph: QualityGraph, event: TestEvent): void {
  if (!graph.hasNode(event.testId)) {
    graph.addNode({
      kind: 'Test',
      id: event.testId,
      label: event.name,
      attrs: compactAttrs({ framework: event.framework, filePath: event.filePath }),
    });
  }
  const execId = `exec:${event.runId}:${event.testId}:${event.retryIndex}`;
  const evidenceId = `ev:${event.runId}:${event.testId}:${event.retryIndex}`;
  graph.addNode({
    kind: 'Execution',
    id: execId,
    label: `${event.name} → ${event.status}`,
    attrs: compactAttrs({
      runId: event.runId,
      status: event.status,
      durationMs: event.durationMs,
      framework: event.framework,
      environment: event.environment,
      timestamp: event.timestamp,
      retryIndex: event.retryIndex,
      browser: event.browser,
      device: event.device,
      commit: event.commit,
      branch: event.branch,
      failureCategory: event.failureCategory,
      errorType: event.errorType,
    }),
  });
  graph.addNode({
    kind: 'Evidence',
    id: evidenceId,
    label: 'test_output',
    attrs: compactAttrs({
      evidenceKind: 'test_output',
      status: event.status,
      capturedAt: event.timestamp,
      location: event.filePath,
      summary: executionSummary(event),
    }),
  });
  graph.addEdge({ from: event.testId, to: execId, kind: 'executed_as' });
  graph.addEdge({ from: execId, to: evidenceId, kind: 'produced' });
}

/**
 * Attach a defect to the tests that reproduce it: creates (or reuses) the
 * Defect node and links every test id with a Test -caused_by-> Defect edge.
 * Missing Test nodes are auto-created as placeholders. The idempotent
 * `addEdge` semantics make repeated calls safe.
 */
export function connectDefect(graph: QualityGraph, defect: DefectInput, testIds: readonly string[]): void {
  if (!graph.hasNode(defect.id)) {
    graph.addNode({
      kind: 'Defect',
      id: defect.id,
      label: defect.title ?? defect.id,
      attrs: compactAttrs({ severity: defect.severity, status: defect.status, ...defect.attrs }),
    });
  }
  for (const testId of testIds) {
    if (!graph.hasNode(testId)) {
      graph.addNode({ kind: 'Test', id: testId, label: testId, attrs: { placeholder: true } });
    }
    graph.addEdge({ from: testId, to: defect.id, kind: 'caused_by' });
  }
}
