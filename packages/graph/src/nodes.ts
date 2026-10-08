/**
 * @the-qa-skill/graph — node & edge vocabulary of the Quality Graph.
 *
 * The quality graph is the traceability backbone of the platform: requirements
 * trace to features, features implement code units, tests cover code units and
 * files, executions produce evidence, and defects are caused by code units.
 * This module defines the exact vocabulary; `graph.ts` implements the store.
 */

/** The 12 node kinds tracked by the Quality Graph. */
export type NodeKind =
  | 'Requirement'
  | 'Feature'
  | 'CodeUnit'
  | 'ApiEndpoint'
  | 'UiElement'
  | 'Test'
  | 'Execution'
  | 'Evidence'
  | 'Defect'
  | 'Commit'
  | 'File'
  | 'Symbol';

/** The 8 edge kinds that connect Quality Graph nodes. */
export type EdgeKind =
  | 'traces_to'
  | 'covers'
  | 'implements'
  | 'executed_as'
  | 'produced'
  | 'caused_by'
  | 'changed_in'
  | 'references';

/** A single node in the Quality Graph. `id` is unique across the graph. */
export interface GraphNode {
  kind: NodeKind;
  id: string;
  label: string;
  attrs: Record<string, string | number | boolean>;
}

/** A directed edge between two nodes, identified by their ids. */
export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  attrs?: Record<string, string | number | boolean>;
}

/** All valid node kinds, in canonical order — used for validation and docs. */
export const NODE_KINDS: readonly NodeKind[] = [
  'Requirement',
  'Feature',
  'CodeUnit',
  'ApiEndpoint',
  'UiElement',
  'Test',
  'Execution',
  'Evidence',
  'Defect',
  'Commit',
  'File',
  'Symbol',
];

/** All valid edge kinds, in canonical order — used for validation and docs. */
export const EDGE_KINDS: readonly EdgeKind[] = [
  'traces_to',
  'covers',
  'implements',
  'executed_as',
  'produced',
  'caused_by',
  'changed_in',
  'references',
];

/** Type guard: is `value` one of the 12 known node kinds? */
export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === 'string' && (NODE_KINDS as readonly string[]).includes(value);
}

/** Type guard: is `value` one of the 8 known edge kinds? */
export function isEdgeKind(value: unknown): value is EdgeKind {
  return typeof value === 'string' && (EDGE_KINDS as readonly string[]).includes(value);
}

/** Type guard: is `value` a legal graph attribute value (string | number | boolean)? */
export function isAttrValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Build an attrs record from a sparse object, dropping `undefined` values.
 * Graph attrs may only hold string | number | boolean, so optional fields
 * must be stripped before a node is stored.
 */
export function compactAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
