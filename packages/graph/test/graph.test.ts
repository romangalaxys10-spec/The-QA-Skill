import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  EDGE_KINDS,
  GraphError,
  NODE_KINDS,
  QualityGraph,
  isEdgeKind,
  isNodeKind,
} from '../src/index.js';
import type { GraphEdge, GraphNode } from '../src/index.js';

const node = (kind: GraphNode['kind'], id: string, label = id): GraphNode => ({ kind, id, label, attrs: {} });

/** Build the canonical end-to-end chain for one requirement. */
function buildTraceGraph(): QualityGraph {
  const g = new QualityGraph();
  g.addNode(node('Requirement', 'req-1', 'Checkout totals are correct'));
  g.addNode(node('Feature', 'feat-1', 'Cart totals'));
  g.addNode(node('CodeUnit', 'cu-1', 'computeTotal'));
  g.addNode(node('CodeUnit', 'cu-2', 'applyDiscount'));
  g.addNode(node('Test', 'test-1', 'totals add up'));
  g.addNode(node('Test', 'test-2', 'discount applied'));
  g.addNode(node('Execution', 'exec-1'));
  g.addNode(node('Evidence', 'ev-1'));
  g.addNode(node('Defect', 'bug-1', 'discount ignored'));
  g.addEdge({ from: 'req-1', to: 'feat-1', kind: 'traces_to' });
  g.addEdge({ from: 'feat-1', to: 'cu-1', kind: 'implements' });
  g.addEdge({ from: 'feat-1', to: 'cu-2', kind: 'implements' });
  g.addEdge({ from: 'test-1', to: 'cu-1', kind: 'covers' });
  g.addEdge({ from: 'test-2', to: 'cu-2', kind: 'covers' });
  g.addEdge({ from: 'test-1', to: 'exec-1', kind: 'executed_as' });
  g.addEdge({ from: 'exec-1', to: 'ev-1', kind: 'produced' });
  g.addEdge({ from: 'cu-2', to: 'bug-1', kind: 'caused_by' });
  return g;
}

describe('quality graph — store', () => {
  it('adds nodes idempotently by id (replace, never duplicate)', () => {
    const g = new QualityGraph();
    g.addNode(node('File', 'src/a.ts', 'first'));
    g.addNode(node('File', 'src/a.ts', 'second'));
    expect(g.nodeCount).toBe(1);
    expect(g.getNode('src/a.ts')?.label).toBe('second');
  });

  it('rejects unknown node kinds and empty ids', () => {
    const g = new QualityGraph();
    expect(() => g.addNode({ kind: 'Unicorn' as GraphNode['kind'], id: 'x', label: 'x', attrs: {} })).toThrow(GraphError);
    expect(() => g.addNode(node('File', ''))).toThrow(GraphError);
    expect(isNodeKind('Test')).toBe(true);
    expect(isNodeKind('Testy')).toBe(false);
    expect(NODE_KINDS).toHaveLength(12);
  });

  it('auto-creates missing endpoints with canonical kinds', () => {
    const g = new QualityGraph();
    g.addEdge({ from: 'test-9', to: 'exec-9', kind: 'executed_as' });
    expect(g.hasNode('test-9')).toBe(true);
    expect(g.getNode('test-9')?.kind).toBe('Test');
    expect(g.getNode('test-9')?.attrs['placeholder']).toBe(true);
    expect(g.getNode('exec-9')?.kind).toBe('Execution');
  });

  it('throws on unknown edge kinds and validates EDGE_KINDS list', () => {
    const g = new QualityGraph();
    expect(() => g.addEdge({ from: 'a', to: 'b', kind: 'loves' as GraphEdge['kind'] })).toThrow(/unknown edge kind/);
    expect(() => g.addEdge({ from: '', to: 'b', kind: 'covers' })).toThrow(GraphError);
    expect(isEdgeKind('caused_by')).toBe(true);
    expect(isEdgeKind('related_to')).toBe(false);
    expect(EDGE_KINDS).toHaveLength(8);
  });

  it('treats duplicate edges as idempotent no-ops', () => {
    const g = new QualityGraph();
    g.addEdge({ from: 'a', to: 'b', kind: 'traces_to' });
    g.addEdge({ from: 'a', to: 'b', kind: 'traces_to', attrs: { note: 'dup' } });
    expect(g.edgeCount).toBe(1);
  });

  it('neighbors honors direction, node kind and edge kind filters', () => {
    const g = buildTraceGraph();
    const out = g.neighbors('feat-1', { direction: 'out', edgeKind: 'implements' });
    expect(out.map((n) => n.id).sort()).toEqual(['cu-1', 'cu-2']);
    const inboundTests = g.neighbors('cu-1', { direction: 'in', edgeKind: 'covers', kind: 'Test' });
    expect(inboundTests.map((n) => n.id)).toEqual(['test-1']);
    const both = g.neighbors('test-1', { direction: 'both' });
    expect(both.map((n) => n.id).sort()).toEqual(['cu-1', 'exec-1']);
    expect(() => g.neighbors('missing', {})).toThrow(GraphError);
  });
});

describe('quality graph — trace & impact', () => {
  it('traces a requirement end-to-end across the canonical chain', () => {
    const chain = buildTraceGraph().traceRequirement('req-1');
    expect(chain).toEqual({
      requirement: 'req-1',
      features: ['feat-1'],
      codeUnits: ['cu-1', 'cu-2'],
      tests: ['test-1', 'test-2'],
      executions: ['exec-1'],
      evidence: ['ev-1'],
      defects: ['bug-1'],
    });
  });

  it('throws for unknown or non-requirement trace ids', () => {
    const g = buildTraceGraph();
    expect(() => g.traceRequirement('req-missing')).toThrow(GraphError);
    expect(() => g.traceRequirement('test-1')).toThrow(/not a Requirement/);
  });

  it('affectedTests finds direct-file, code-unit and symbol coverage with reasons', () => {
    const g = new QualityGraph();
    g.addNode(node('File', 'src/cart/total.ts'));
    g.addNode({ kind: 'CodeUnit', id: 'unit:src/cart/total.ts', label: 'total.ts', attrs: { path: 'src/cart/total.ts', symbols: 'computeTotal' } });
    g.addNode(node('Symbol', 'computeTotal'));
    g.addNode(node('Commit', 'c1'));
    g.addNode(node('Test', 'math.spec'));
    g.addNode(node('Test', 'cart.spec'));
    g.addEdge({ from: 'computeTotal', to: 'src/cart/total.ts', kind: 'references' });
    g.addEdge({ from: 'c1', to: 'src/cart/total.ts', kind: 'changed_in' });
    g.addEdge({ from: 'math.spec', to: 'src/cart/total.ts', kind: 'covers' });
    g.addEdge({ from: 'cart.spec', to: 'unit:src/cart/total.ts', kind: 'covers' });

    const result = g.affectedTests(['src/cart/total.ts']);
    expect(result.tests.sort()).toEqual(['cart.spec', 'math.spec']);
    expect(result.reasons.some((r) => r.includes("covers changed file 'src/cart/total.ts'"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("symbol 'computeTotal' is referenced"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("commit 'c1' changed"))).toBe(true);
  });

  it('affectedTests routes through symbols into symbol-named code units', () => {
    const g = new QualityGraph();
    g.addNode(node('File', 'src/cart/total.ts'));
    // Canonical convention: a CodeUnit named after the exported symbol plays
    // the Symbol role and references the file it lives in.
    g.addNode(node('CodeUnit', 'computeTotal', 'computeTotal()'));
    g.addNode(node('Test', 'symbol.spec'));
    g.addEdge({ from: 'computeTotal', to: 'src/cart/total.ts', kind: 'references' });
    g.addEdge({ from: 'symbol.spec', to: 'computeTotal', kind: 'covers' });
    const result = g.affectedTests(['src/cart/total.ts']);
    expect(result.tests).toEqual(['symbol.spec']);
    expect(result.reasons.some((r) => r.includes("covers symbol 'computeTotal'"))).toBe(true);
  });

  it('affectedTests reports untracked paths instead of failing', () => {
    const g = new QualityGraph();
    const result = g.affectedTests(['src/ghost.ts']);
    expect(result.tests).toEqual([]);
    expect(result.reasons).toEqual(["path 'src/ghost.ts' is not tracked in the quality graph"]);
  });
});

describe('quality graph — serialization', () => {
  it('round-trips through JSON with full equality and behavior', () => {
    const g = buildTraceGraph();
    const restored = QualityGraph.fromJSON(g.toJSON());
    expect(restored.toJSON()).toEqual(g.toJSON());
    expect(restored.nodeCount).toBe(g.nodeCount);
    expect(restored.edgeCount).toBe(g.edgeCount);
    expect(restored.traceRequirement('req-1')).toEqual(g.traceRequirement('req-1'));
  });

  it('fromJSON rejects malformed payloads', () => {
    expect(() => QualityGraph.fromJSON({ nodes: 'nope', edges: [] })).toThrow(GraphError);
    expect(() => QualityGraph.fromJSON({ nodes: [{ kind: 'Wizard', id: 'x', label: 'x', attrs: {} }], edges: [] })).toThrow(GraphError);
    expect(() => QualityGraph.fromJSON({ nodes: [], edges: [{ from: 'a', to: 'b', kind: 'loves' }] })).toThrow(GraphError);
    expect(() => QualityGraph.fromJSON({ nodes: [{ kind: 'File', id: 'a', label: 'a', attrs: { n: null } }], edges: [] })).toThrow(GraphError);
  });

  it('saves to disk and loads back identically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-graph-'));
    try {
      const filePath = join(dir, 'nested', 'graph.json');
      const g = buildTraceGraph();
      g.save(filePath);
      const loaded = QualityGraph.load(filePath);
      expect(loaded.toJSON()).toEqual(g.toJSON());
      expect(() => QualityGraph.load(join(dir, 'missing.json'))).toThrow(GraphError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders GraphViz containing node ids and edge kinds', () => {
    const viz = buildTraceGraph().toGraphViz();
    expect(viz.startsWith('digraph quality {')).toBe(true);
    for (const id of ['req-1', 'feat-1', 'cu-1', 'test-1', 'exec-1', 'ev-1', 'bug-1']) {
      expect(viz).toContain(`"${id}"`);
    }
    expect(viz).toContain('-> "feat-1" [label="traces_to"]');
    expect(viz).toContain('[label="caused_by"]');
  });
});
