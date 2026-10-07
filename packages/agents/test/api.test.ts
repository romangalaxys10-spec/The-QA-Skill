import { describe, expect, it } from 'vitest';
import * as agents from '../src/index.js';

/**
 * API conformance: the mandatory public surface other packages compile
 * against. Renames or removals break the monorepo — this test fails first.
 */
describe('public API conformance', () => {
  it('exports every mandated symbol', () => {
    const requiredFunctions = [
      'routeIntent',
      'computeGate',
      'detectPrimaryCascade',
      'parseMarkdownSpec',
      'slugify',
      'isTestShaped',
    ];
    const requiredClasses = [
      'DiscoveryAgent',
      'RequirementsAgent',
      'RiskAgent',
      'GenerationAgent',
      'ReviewAgent',
      'ExecutionAgent',
      'DefaultRunnerAdapter',
      'TriageAgent',
      'HealingAgent',
      'Orchestrator',
    ];
    for (const name of [...requiredFunctions, ...requiredClasses]) {
      expect(agents, `export ${name}`).toHaveProperty(name);
    }
    for (const name of requiredFunctions) {
      expect(typeof (agents as Record<string, unknown>)[name], `${name} is a function`).toBe('function');
    }
    for (const name of requiredClasses) {
      expect(typeof (agents as Record<string, unknown>)[name], `${name} is a class`).toBe('function');
    }
  });

  it('agent constructors accept the documented option shapes', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'api-shape-'));
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', devDependencies: { vitest: '^2' } }));
    writeFileSync(join(root, 'tests', 'a.test.ts'), "import { it } from 'vitest';\nit('a', () => {});\n");

    expect(new agents.DiscoveryAgent(root)).toBeInstanceOf(agents.DiscoveryAgent);
    expect(new agents.RequirementsAgent(root)).toBeInstanceOf(agents.RequirementsAgent);
    expect(new agents.RiskAgent(root)).toBeInstanceOf(agents.RiskAgent);
    expect(new agents.GenerationAgent(root)).toBeInstanceOf(agents.GenerationAgent);
    expect(new agents.ReviewAgent(root)).toBeInstanceOf(agents.ReviewAgent);
    expect(new agents.ExecutionAgent(root, { spawner: async () => ({ stdout: '', stderr: '', code: 0 }) })).toBeInstanceOf(agents.ExecutionAgent);
    expect(new agents.TriageAgent(root)).toBeInstanceOf(agents.TriageAgent);
    expect(new agents.HealingAgent(root)).toBeInstanceOf(agents.HealingAgent);
    expect(new agents.Orchestrator(root, { spawner: async () => ({ stdout: '', stderr: '', code: 0 }) })).toBeInstanceOf(agents.Orchestrator);
  });
});
