import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { EDGE_KINDS, NODE_KINDS, isAttrValue, isEdgeKind, isNodeKind } from './nodes.js';
import type { EdgeKind, GraphEdge, GraphNode, NodeKind } from './nodes.js';

/**
 * @the-qa-skill/graph — the Quality Graph store.
 *
 * A directed attributed graph over the 12 quality node kinds. It answers the
 * two questions every QA orchestrator asks:
 *   1. `traceRequirement` — which features, code, tests, executions, evidence
 *      and defects back a given requirement?
 *   2. `affectedTests` — which tests must run because these files changed?
 */

/** Error thrown for invalid graph operations (unknown kinds, bad payloads, IO). */
export class GraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphError';
  }
}

/** The canonical trace chain produced by `traceRequirement`. */
export interface TraceChain {
  requirement: string;
  features: string[];
  codeUnits: string[];
  tests: string[];
  executions: string[];
  evidence: string[];
  defects: string[];
}

/** Result of `affectedTests`: the tests to run and the reasons why. */
export interface AffectedTestsResult {
  tests: string[];
  reasons: string[];
}

/** Filter accepted by `QualityGraph.neighbors`. */
export interface NeighborFilter {
  /** Which direction to walk. Defaults to 'both'. */
  direction?: 'in' | 'out' | 'both';
  /** Only return neighbor nodes of this node kind. */
  kind?: NodeKind;
  /** Only traverse edges of this edge kind. */
  edgeKind?: EdgeKind;
}

/** Serializable shape used by toJSON/fromJSON/save/load. */
export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface AdjacencyEntry {
  edge: GraphEdge;
  other: string;
}

/**
 * Canonical endpoint kinds per edge kind. When `addEdge` references a missing
 * endpoint, a placeholder node of this kind is created so callers can wire
 * edges before declaring nodes. Ambiguous targets (e.g. `covers` may point at
 * a CodeUnit or a File) default to the kind used by the canonical trace chain;
 * pre-add the node to control the kind explicitly.
 */
const EDGE_ENDPOINT_DEFAULTS: Record<EdgeKind, readonly [NodeKind, NodeKind]> = {
  traces_to: ['Requirement', 'Feature'],
  covers: ['Test', 'CodeUnit'],
  implements: ['Feature', 'CodeUnit'],
  executed_as: ['Test', 'Execution'],
  produced: ['Execution', 'Evidence'],
  caused_by: ['CodeUnit', 'Defect'],
  changed_in: ['Commit', 'File'],
  references: ['Symbol', 'File'],
};

/** Escape a string for safe embedding in a GraphViz quoted identifier. */
function vizEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function pushAdjacency(map: Map<string, AdjacencyEntry[]>, id: string, entry: AdjacencyEntry): void {
  const list = map.get(id);
  if (list) list.push(entry);
  else map.set(id, [entry]);
}

/**
 * The Quality Graph: an idempotent, serializable, attributed digraph over the
 * quality vocabulary. Node ids are unique; adding a node with an existing id
 * replaces its content (last write wins) without duplicating it. Adding an
 * edge whose endpoints are missing auto-creates placeholder nodes.
 */
export class QualityGraph {
  private readonly nodes = new Map<string, GraphNode>();
  private readonly outAdjacency = new Map<string, AdjacencyEntry[]>();
  private readonly inAdjacency = new Map<string, AdjacencyEntry[]>();
  private readonly edgeList: GraphEdge[] = [];

  /**
   * Add (or replace) a node. Idempotent by id: adding the same node twice
   * yields exactly one node. Throws `GraphError` on an unknown node kind,
   * empty id, or non-string label.
   */
  addNode(node: GraphNode): this {
    if (!isNodeKind(node.kind)) {
      throw new GraphError(`unknown node kind '${String(node.kind)}' (expected one of: ${NODE_KINDS.join(', ')})`);
    }
    if (typeof node.id !== 'string' || node.id.length === 0) {
      throw new GraphError('node id must be a non-empty string');
    }
    if (typeof node.label !== 'string') {
      throw new GraphError(`node '${node.id}' label must be a string`);
    }
    this.nodes.set(node.id, { kind: node.kind, id: node.id, label: node.label, attrs: { ...node.attrs } });
    return this;
  }

  /**
   * Add a directed edge. Unknown edge kinds throw `GraphError`. Missing
   * endpoints are auto-created as placeholder nodes with the canonical kind
   * for the edge (see EDGE_ENDPOINT_DEFAULTS). Duplicate edges (same
   * from/to/kind) are idempotent no-ops that keep the first attrs.
   */
  addEdge(edge: GraphEdge): this {
    if (!isEdgeKind(edge.kind)) {
      throw new GraphError(`unknown edge kind '${String(edge.kind)}' (expected one of: ${EDGE_KINDS.join(', ')})`);
    }
    if (
      typeof edge.from !== 'string' || edge.from.length === 0 ||
      typeof edge.to !== 'string' || edge.to.length === 0
    ) {
      throw new GraphError(`edge '${edge.kind}' endpoints must be non-empty strings`);
    }
    if (!this.nodes.has(edge.from)) this.autoCreateEndpoint(edge.from, EDGE_ENDPOINT_DEFAULTS[edge.kind][0]);
    if (!this.nodes.has(edge.to)) this.autoCreateEndpoint(edge.to, EDGE_ENDPOINT_DEFAULTS[edge.kind][1]);
    const duplicate = (this.outAdjacency.get(edge.from) ?? []).some(
      (entry) => entry.edge.kind === edge.kind && entry.other === edge.to,
    );
    if (duplicate) return this;
    const stored: GraphEdge = {
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      ...(edge.attrs !== undefined ? { attrs: { ...edge.attrs } } : {}),
    };
    this.edgeList.push(stored);
    pushAdjacency(this.outAdjacency, edge.from, { edge: stored, other: edge.to });
    pushAdjacency(this.inAdjacency, edge.to, { edge: stored, other: edge.from });
    return this;
  }

  /** True when a node with this id exists. */
  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /** Look up a node by id, or undefined. The returned node must be treated as read-only. */
  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Number of nodes in the graph. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Number of edges in the graph. */
  get edgeCount(): number {
    return this.edgeList.length;
  }

  /** All nodes in insertion order. */
  allNodes(): GraphNode[] {
    return [...this.nodes.values()];
  }

  /** All edges in insertion order. */
  allEdges(): GraphEdge[] {
    return [...this.edgeList];
  }

  /**
   * Direct neighbors of a node. Throws `GraphError` when the node does not
   * exist (silent empty results hide wiring bugs). Filters compose: direction
   * (default 'both'), neighbor node kind, and traversed edge kind.
   */
  neighbors(id: string, filter: NeighborFilter = {}): GraphNode[] {
    this.assertNode(id, `neighbors('${id}')`);
    const direction = filter.direction ?? 'both';
    const collect = (entries: AdjacencyEntry[]): GraphNode[] => {
      const result: GraphNode[] = [];
      for (const entry of entries) {
        if (filter.edgeKind !== undefined && entry.edge.kind !== filter.edgeKind) continue;
        const node = this.nodes.get(entry.other);
        if (!node) continue;
        if (filter.kind !== undefined && node.kind !== filter.kind) continue;
        result.push(node);
      }
      return result;
    };
    const seen = new Set<string>();
    const result: GraphNode[] = [];
    const sources: AdjacencyEntry[][] = [];
    if (direction !== 'in') sources.push(this.outAdjacency.get(id) ?? []);
    if (direction !== 'out') sources.push(this.inAdjacency.get(id) ?? []);
    for (const entries of sources) {
      for (const node of collect(entries)) {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          result.push(node);
        }
      }
    }
    return result;
  }

  /**
   * Trace a requirement through the canonical chain:
   * Requirement -traces_to-> Feature -implements-> CodeUnit,
   * Test -covers-> CodeUnit, Test -executed_as-> Execution,
   * Execution -produced-> Evidence, CodeUnit -caused_by-> Defect.
   * All id lists are deduplicated and keep insertion order. Throws
   * `GraphError` when the id is unknown or not a Requirement node.
   */
  traceRequirement(requirementId: string): TraceChain {
    const node = this.nodes.get(requirementId);
    if (!node) {
      throw new GraphError(`traceRequirement: no node '${requirementId}' exists in the graph`);
    }
    if (node.kind !== 'Requirement') {
      throw new GraphError(`traceRequirement: node '${requirementId}' is a ${node.kind}, not a Requirement`);
    }
    const features = this.uniqueIds(this.adjacentIds(requirementId, 'traces_to', 'out'));
    const codeUnits = this.uniqueIds(features.flatMap((f) => this.adjacentIds(f, 'implements', 'out')));
    const tests = this.uniqueIds(codeUnits.flatMap((cu) => this.adjacentIds(cu, 'covers', 'in')));
    const executions = this.uniqueIds(tests.flatMap((t) => this.adjacentIds(t, 'executed_as', 'out')));
    const evidence = this.uniqueIds(executions.flatMap((e) => this.adjacentIds(e, 'produced', 'out')));
    const defects = this.uniqueIds(codeUnits.flatMap((cu) => this.adjacentIds(cu, 'caused_by', 'out')));
    return { requirement: requirementId, features, codeUnits, tests, executions, evidence, defects };
  }

  /**
   * Impact analysis: which tests must run because these files changed, and why.
   *
   * Routes (all documented in `reasons`):
   *  1. direct coverage — Test -covers-> File(path)
   *  2. code-unit coverage — Test -covers-> CodeUnit whose id is the path or
   *     the conventional `unit:<path>` id
   *  3. symbol coverage — Symbol -references-> File(path), then a CodeUnit
   *     named after the symbol or declaring it via attrs.symbol/attrs.symbols
   *  4. commit provenance — Commit -changed_in-> File(path) records a reason
   *     even when no test is implicated.
   */
  affectedTests(changedFilePaths: readonly string[]): AffectedTestsResult {
    const tests = new Set<string>();
    const reasons = new Set<string>();
    for (const path of changedFilePaths) {
      const fileNode = this.nodes.get(path);
      if (!fileNode) {
        reasons.add(`path '${path}' is not tracked in the quality graph`);
        continue;
      }
      // Route 1 — direct test coverage of the file.
      for (const testId of this.coveringTests(path)) {
        tests.add(testId);
        reasons.add(`test '${testId}' covers changed file '${path}'`);
      }
      // Route 2 — tests covering a code unit derived from the file
      // (conventional 'unit:<path>' id, or a bare path-keyed CodeUnit).
      for (const unitId of [`unit:${path}`, path]) {
        const unit = this.nodes.get(unitId);
        if (!unit || unit.kind !== 'CodeUnit') continue;
        for (const testId of this.coveringTests(unitId)) {
          tests.add(testId);
          reasons.add(`test '${testId}' covers code unit '${unitId}' derived from changed file '${path}'`);
        }
      }
      // Route 3 — symbols referenced by the changed file. The referencing
      // node is usually a Symbol-kind node, but symbol-named CodeUnits
      // participate identically (canonical chain convention).
      for (const symbolId of this.adjacentIds(path, 'references', 'in')) {
        reasons.add(`symbol '${symbolId}' is referenced by changed file '${path}'`);
        for (const unitId of this.codeUnitsForSymbol(symbolId)) {
          for (const testId of this.coveringTests(unitId)) {
            tests.add(testId);
            reasons.add(`test '${testId}' covers symbol '${symbolId}' referenced by changed file '${path}'`);
          }
        }
      }
      // Route 4 — commit provenance (context, not a test signal).
      for (const commitId of this.adjacentIds(path, 'changed_in', 'in')) {
        const commit = this.nodes.get(commitId);
        if (commit && commit.kind === 'Commit') {
          reasons.add(`commit '${commitId}' changed '${path}'`);
        }
      }
    }
    return { tests: [...tests], reasons: [...reasons] };
  }

  /**
   * Render the graph as a GraphViz digraph. Node lines carry id, label and
   * kind; edge lines carry the edge kind as their label.
   */
  toGraphViz(): string {
    const lines: string[] = ['digraph quality {'];
    for (const node of this.nodes.values()) {
      lines.push(`  "${vizEscape(node.id)}" [label="${vizEscape(node.label)}", kind="${node.kind}"];`);
    }
    for (const edge of this.edgeList) {
      lines.push(`  "${vizEscape(edge.from)}" -> "${vizEscape(edge.to)}" [label="${edge.kind}"];`);
    }
    lines.push('}');
    return lines.join('\n');
  }

  /** Serialize the graph to a plain JSON-ready payload (defensive copies). */
  toJSON(): GraphPayload {
    return {
      nodes: this.allNodes().map((node) => ({ ...node, attrs: { ...node.attrs } })),
      edges: this.edgeList.map((edge) => ({ ...edge, ...(edge.attrs !== undefined ? { attrs: { ...edge.attrs } } : {}) })),
    };
  }

  /**
   * Rebuild a graph from a payload produced by `toJSON`. Structural problems
   * (unknown kinds, non-attr values, missing fields) throw `GraphError`.
   * Edges referencing missing endpoints auto-create placeholders, matching
   * `addEdge` semantics.
   */
  static fromJSON(data: unknown): QualityGraph {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new GraphError('graph payload must be a JSON object with "nodes" and "edges" arrays');
    }
    const record = data as Record<string, unknown>;
    const rawNodes = record['nodes'];
    const rawEdges = record['edges'];
    if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) {
      throw new GraphError('graph payload must contain "nodes" and "edges" arrays');
    }
    const graph = new QualityGraph();
    rawNodes.forEach((raw, index) => {
      const node = QualityGraph.parseNode(raw, `nodes[${index}]`);
      graph.addNode(node);
    });
    rawEdges.forEach((raw, index) => {
      const edge = QualityGraph.parseEdge(raw, `edges[${index}]`);
      graph.addEdge(edge);
    });
    return graph;
  }

  /** Write the graph to disk as pretty-printed JSON (creates parent dirs). */
  save(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(this.toJSON(), null, 2)}\n`, 'utf8');
  }

  /** Load a graph previously written by `save`. Throws `GraphError` on IO or payload failure. */
  static load(filePath: string): QualityGraph {
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (e) {
      throw new GraphError(`cannot read graph file '${filePath}': ${(e as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new GraphError(`graph file '${filePath}' is not valid JSON: ${(e as Error).message}`);
    }
    return QualityGraph.fromJSON(parsed);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private autoCreateEndpoint(id: string, kind: NodeKind): void {
    this.nodes.set(id, { kind, id, label: id, attrs: { placeholder: true } });
  }

  private assertNode(id: string, context: string): void {
    if (!this.nodes.has(id)) {
      throw new GraphError(`${context}: no node '${id}' exists in the graph`);
    }
  }

  /** Ids of adjacent nodes across edges of the given kind and direction. */
  private adjacentIds(id: string, edgeKind: EdgeKind, direction: 'in' | 'out'): string[] {
    const entries = direction === 'out'
      ? this.outAdjacency.get(id) ?? []
      : this.inAdjacency.get(id) ?? [];
    return entries.filter((entry) => entry.edge.kind === edgeKind).map((entry) => entry.other);
  }

  private uniqueIds(ids: string[]): string[] {
    return [...new Set(ids)];
  }

  /** Test nodes with an incoming 'covers' edge into `targetId`. */
  private coveringTests(targetId: string): string[] {
    const result: string[] = [];
    for (const id of this.adjacentIds(targetId, 'covers', 'in')) {
      const node = this.nodes.get(id);
      if (node && node.kind === 'Test') result.push(id);
    }
    return result;
  }

  /**
   * CodeUnit nodes associated with a symbol: a CodeUnit whose id equals the
   * symbol name, or one declaring the symbol via attrs.symbol / a
   * comma-separated attrs.symbols list.
   */
  private codeUnitsForSymbol(symbolId: string): string[] {
    const result: string[] = [];
    const direct = this.nodes.get(symbolId);
    if (direct && direct.kind === 'CodeUnit') result.push(symbolId);
    for (const node of this.nodes.values()) {
      if (node.kind !== 'CodeUnit' || node.id === symbolId) continue;
      const single = node.attrs['symbol'];
      const list = node.attrs['symbols'];
      if (single === symbolId) {
        result.push(node.id);
        continue;
      }
      if (typeof list === 'string' && list.split(',').map((s) => s.trim()).includes(symbolId)) {
        result.push(node.id);
      }
    }
    return [...new Set(result)];
  }

  private static parseNode(raw: unknown, at: string): GraphNode {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new GraphError(`${at}: node must be an object`);
    }
    const record = raw as Record<string, unknown>;
    if (!isNodeKind(record['kind'])) throw new GraphError(`${at}: unknown node kind '${String(record['kind'])}'`);
    if (typeof record['id'] !== 'string' || record['id'].length === 0) throw new GraphError(`${at}: node id must be a non-empty string`);
    if (typeof record['label'] !== 'string') throw new GraphError(`${at}: node '${String(record['id'])}' label must be a string`);
    const attrs = QualityGraph.parseAttrs(record['attrs'], at);
    return { kind: record['kind'], id: record['id'], label: record['label'], attrs };
  }

  private static parseEdge(raw: unknown, at: string): GraphEdge {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new GraphError(`${at}: edge must be an object`);
    }
    const record = raw as Record<string, unknown>;
    if (!isEdgeKind(record['kind'])) throw new GraphError(`${at}: unknown edge kind '${String(record['kind'])}'`);
    if (typeof record['from'] !== 'string' || record['from'].length === 0) throw new GraphError(`${at}: edge 'from' must be a non-empty string`);
    if (typeof record['to'] !== 'string' || record['to'].length === 0) throw new GraphError(`${at}: edge 'to' must be a non-empty string`);
    if (record['attrs'] === undefined) return { from: record['from'], to: record['to'], kind: record['kind'] };
    return { from: record['from'], to: record['to'], kind: record['kind'], attrs: QualityGraph.parseAttrs(record['attrs'], at) };
  }

  private static parseAttrs(raw: unknown, at: string): Record<string, string | number | boolean> {
    if (raw === undefined) return {};
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new GraphError(`${at}: attrs must be an object of string | number | boolean`);
    }
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!isAttrValue(value)) {
        throw new GraphError(`${at}: attrs['${key}'] must be string | number | boolean, got ${typeof value}`);
      }
      out[key] = value;
    }
    return out;
  }
}
