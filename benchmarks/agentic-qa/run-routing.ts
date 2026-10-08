/**
 * xRouteLM routing benchmark — The-QA-Skill.
 *
 * Measures the heuristic System One router against the routing expectations
 * in routing.json: every case's task text goes through the exact engine the
 * `qa route` command uses (DecisionEngine.route over defaultTargets()), and
 * the selected target is compared with the expected one.
 *
 * Honesty rules:
 *   - The engine runs from packages/xroutelm/src — the same code the CLI,
 *     MCP server, and agents ship. Nothing here re-implements routing.
 *   - A miss is reported as data (target, confidence, top-3 evidence); the
 *     process exits 0. Only harness faults exit non-zero.
 *   - Results are written to results-routing.json / results-routing.md and
 *     referenced from docs/benchmark.md.
 *
 * Run: npx tsx benchmarks/agentic-qa/run-routing.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DecisionEngine, ScorerRegistry, defaultTargets } from '../../packages/xroutelm/src/index.js';

interface RoutingCase {
  task: string;
  expect: string;
}

interface RoutingResult {
  task: string;
  expect: string;
  actual: string;
  confidence: number;
  top3: string[];
  pass: boolean;
  durationMs: number;
}

async function main(): Promise<number> {
  const dir = new URL('.', import.meta.url).pathname;
  const spec = JSON.parse(readFileSync(join(dir, 'routing.json'), 'utf8')) as { cases: RoutingCase[] };
  const engine = new DecisionEngine(ScorerRegistry.withDefaults(), undefined);
  const targets = defaultTargets();

  const results: RoutingResult[] = [];
  for (const c of spec.cases) {
    const started = Date.now();
    const decision = await engine.route(c.task, targets);
    const ranked = Object.entries(decision.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
    results.push({
      task: c.task,
      expect: c.expect,
      actual: decision.target,
      confidence: decision.confidence,
      top3: ranked,
      pass: decision.target === c.expect,
      durationMs: Date.now() - started,
    });
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const meanConfidence = results.reduce((acc, r) => acc + r.confidence, 0) / Math.max(1, total);
  const meanMs = results.reduce((acc, r) => acc + r.durationMs, 0) / Math.max(1, total);

  const json = {
    schemaVersion: 1,
    tool: 'xroutelm-routing-benchmark',
    generatedAt: new Date().toISOString(),
    disclaimer: 'Measured with the xRouteLM heuristic scorer over defaultTargets(). No LLM, no network. Reproducible via npm run benchmark.',
    total,
    passed,
    accuracy: Math.round((passed / Math.max(1, total)) * 1000) / 10,
    meanConfidence: Math.round(meanConfidence * 1000) / 1000,
    meanRuntimeMs: Math.round(meanMs * 100) / 100,
    results,
  };
  writeFileSync(join(dir, 'results-routing.json'), JSON.stringify(json, null, 2) + '\n');

  const lines: string[] = [
    '# xRouteLM routing benchmark results',
    '',
    '> Measured with the xRouteLM heuristic scorer over the default QA targets — the same',
    '> engine `qa route` and the MCP `route_task` tool use. No LLM, no network; reproducible',
    '> via `npx tsx benchmarks/agentic-qa/run-routing.ts`.',
    '',
    `**Accuracy: ${passed}/${total} (${json.accuracy}%)** · mean confidence ${json.meanConfidence} · mean ${json.meanRuntimeMs} ms/case`,
    '',
    '| Task | Expected | Actual | Confidence | Top-3 | Result |',
    '| --- | --- | --- | ---: | --- | --- |',
  ];
  for (const r of results) {
    lines.push(`| ${r.task} | ${r.expect} | ${r.actual} | ${r.confidence} | ${r.top3.join(' → ')} | ${r.pass ? 'PASS' : 'MISS'} |`);
  }
  writeFileSync(join(dir, 'results-routing.md'), lines.join('\n') + '\n');

  console.log(`xRouteLM routing: ${passed}/${total} correct (${json.accuracy}%), mean confidence ${json.meanConfidence}`);
  for (const r of results.filter((x) => !x.pass)) {
    console.log(`  MISS: "${r.task}" → expected ${r.expect}, got ${r.actual} (${r.confidence})`);
  }
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(`harness fault: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
