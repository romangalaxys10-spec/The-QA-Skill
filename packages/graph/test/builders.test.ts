import { describe, expect, it } from 'vitest';

import { buildContext } from '@the-qa-skill/core';

import { addExecutionResult, connectDefect, graphFromContext } from '../src/index.js';
import { QualityGraph } from '../src/index.js';
import type { TestEvent } from '@the-qa-skill/core';

const context = buildContext({
  generatedAt: '2026-10-07T10:00:00Z',
  root: '/repo',
  application: { type: 'webshop', language: 'typescript' },
  requirements: [
    {
      id: 'REQ-1',
      title: 'Checkout totals are correct',
      priority: 'must',
      status: 'agreed',
      criteria: ['total equals sum of line items minus discounts'],
      source: 'JIRA-42',
    },
  ],
  affectedFeatures: ['checkout'],
  changedFiles: [
    {
      path: 'src/checkout/cart.ts',
      status: 'modified',
      additions: 12,
      deletions: 3,
      area: 'ui',
      language: 'typescript',
      symbols: ['computeTotal'],
    },
  ],
  existingTests: [
    {
      testId: 'cart-total.spec',
      name: 'computes cart total',
      filePath: 'tests/cart-total.spec.ts',
      layer: 'unit',
      framework: 'vitest',
      covers: ['src/checkout/cart.ts'],
    },
  ],
  knownDefects: [
    { id: 'BUG-7', title: 'total ignores discounts', paths: ['src/checkout/cart.ts'], severity: 'major', status: 'open' },
  ],
  provenance: { discovery: 'manual', commit: 'abc1234', branch: 'feat/cart' },
});

const event: TestEvent = {
  runId: 'run-1',
  testId: 'cart-total.spec',
  name: 'computes cart total',
  timestamp: '2026-10-07T10:01:00Z',
  status: 'failed',
  durationMs: 120,
  framework: 'vitest',
  environment: 'ci',
  retryIndex: 0,
  failureCategory: 'ASSERTION_FAILURE',
  filePath: 'tests/cart-total.spec.ts',
  errorType: 'AssertionError',
  errorMessage: 'expected 30 to equal 27',
};

describe('graph builders — graphFromContext', () => {
  it('maps a sample context onto the canonical graph vocabulary', () => {
    const g = graphFromContext(context);

    expect(g.getNode('REQ-1')?.kind).toBe('Requirement');
    expect(g.getNode('REQ-1')?.attrs['priority']).toBe('must');
    expect(g.getNode('checkout')?.kind).toBe('Feature');
    expect(g.getNode('src/checkout/cart.ts')?.kind).toBe('File');
    expect(g.getNode('computeTotal')?.kind).toBe('Symbol');
    expect(g.getNode('unit:src/checkout/cart.ts')?.kind).toBe('CodeUnit');
    expect(g.getNode('abc1234')?.kind).toBe('Commit');
    expect(g.getNode('cart-total.spec')?.kind).toBe('Test');
    expect(g.getNode('BUG-7')?.kind).toBe('Defect');

    // Edges: requirement → feature, symbol → file, commit → file, test → unit, unit → defect.
    expect(g.neighbors('REQ-1', { edgeKind: 'traces_to', kind: 'Feature' }).map((n) => n.id)).toEqual(['checkout']);
    expect(g.neighbors('src/checkout/cart.ts', { direction: 'in', edgeKind: 'references' }).map((n) => n.id)).toEqual(['computeTotal']);
    expect(g.neighbors('src/checkout/cart.ts', { direction: 'in', edgeKind: 'changed_in' }).map((n) => n.id)).toEqual(['abc1234']);
    expect(g.neighbors('unit:src/checkout/cart.ts', { direction: 'in', edgeKind: 'covers' }).map((n) => n.id)).toEqual(['cart-total.spec']);
    expect(g.neighbors('BUG-7', { direction: 'in', edgeKind: 'caused_by' }).map((n) => n.id)).toEqual(['unit:src/checkout/cart.ts']);
    // Feature implements the path code unit by name match.
    expect(g.neighbors('checkout', { direction: 'out', edgeKind: 'implements' }).map((n) => n.id)).toContain('unit:src/checkout/cart.ts');
  });

  it('traces the context requirement through feature, unit, test and defect', () => {
    const chain = graphFromContext(context).traceRequirement('REQ-1');
    expect(chain.requirement).toBe('REQ-1');
    expect(chain.features).toEqual(['checkout']);
    expect(chain.codeUnits).toEqual(['unit:src/checkout/cart.ts']);
    expect(chain.tests).toEqual(['cart-total.spec']);
    expect(chain.defects).toEqual(['BUG-7']);
    expect(chain.executions).toEqual([]);
    expect(chain.evidence).toEqual([]);
  });

  it('answers affectedTests on the context-derived graph', () => {
    const result = graphFromContext(context).affectedTests(['src/checkout/cart.ts']);
    expect(result.tests).toEqual(['cart-total.spec']);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.reasons.some((r) => r.includes("commit 'abc1234'"))).toBe(true);
  });
});

describe('graph builders — addExecutionResult', () => {
  it('adds Execution + Evidence nodes with executed_as/produced edges and attrs', () => {
    const g = new QualityGraph();
    addExecutionResult(g, event);

    const execId = 'exec:run-1:cart-total.spec:0';
    expect(g.getNode('cart-total.spec')?.kind).toBe('Test');
    expect(g.getNode(execId)?.kind).toBe('Execution');
    expect(g.getNode(execId)?.attrs['status']).toBe('failed');
    expect(g.getNode(execId)?.attrs['durationMs']).toBe(120);
    expect(g.getNode(execId)?.attrs['failureCategory']).toBe('ASSERTION_FAILURE');
    expect(g.getNode('ev:run-1:cart-total.spec:0')?.kind).toBe('Evidence');
    expect(g.getNode('ev:run-1:cart-total.spec:0')?.attrs['evidenceKind']).toBe('test_output');
    expect(g.neighbors('cart-total.spec', { direction: 'out', edgeKind: 'executed_as' }).map((n) => n.id)).toEqual([execId]);
    expect(g.neighbors(execId, { direction: 'out', edgeKind: 'produced' }).map((n) => n.id)).toEqual(['ev:run-1:cart-total.spec:0']);
    // The evidence summary carries the failure, not just a bare status.
    expect(String(g.getNode('ev:run-1:cart-total.spec:0')?.attrs['summary'])).toContain('AssertionError');
  });

  it('distinguishes retries by retryIndex and never clobbers the Test node', () => {
    const g = new QualityGraph();
    addExecutionResult(g, event);
    addExecutionResult(g, { ...event, retryIndex: 1, status: 'passed', durationMs: 90 });
    expect(g.nodeCount).toBe(5); // Test + 2 executions + 2 evidence
    expect(g.neighbors('cart-total.spec', { direction: 'out', edgeKind: 'executed_as' }).map((n) => n.id).sort()).toEqual([
      'exec:run-1:cart-total.spec:0',
      'exec:run-1:cart-total.spec:1',
    ]);
    expect(g.getNode('cart-total.spec')?.attrs['framework']).toBe('vitest');
  });
});

describe('graph builders — connectDefect', () => {
  it('links tests that reproduce the defect, creating placeholders as needed', () => {
    const g = new QualityGraph();
    g.addNode({ kind: 'Test', id: 'known.spec', label: 'known test', attrs: {} });
    connectDefect(g, { id: 'BUG-9', title: 'rounding drift', severity: 'major', status: 'open' }, ['known.spec', 'unknown.spec']);

    expect(g.getNode('BUG-9')?.kind).toBe('Defect');
    expect(g.getNode('BUG-9')?.label).toBe('rounding drift');
    expect(g.neighbors('BUG-9', { direction: 'in', edgeKind: 'caused_by' }).map((n) => n.id).sort()).toEqual([
      'known.spec',
      'unknown.spec',
    ]);
    // Placeholder test nodes are marked as such; existing nodes are untouched.
    expect(g.getNode('unknown.spec')?.attrs['placeholder']).toBe(true);
    expect(g.getNode('known.spec')?.attrs['placeholder']).toBeUndefined();

    // Re-connecting is idempotent.
    connectDefect(g, { id: 'BUG-9' }, ['known.spec']);
    expect(g.edgeCount).toBe(2);
  });
});
