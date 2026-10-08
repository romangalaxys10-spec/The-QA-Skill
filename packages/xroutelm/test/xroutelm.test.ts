import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DecisionEngine,
  HeuristicScorer,
  LayaBridgeScorer,
  RouteStats,
  ScorerRegistry,
  SystemOneHarness,
  calibrate,
  defaultTargets,
  discoverPlugins,
  targetsWithPlugins,
} from '../src/index.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'tqs-xroute-'));
}

describe('xRouteLM heuristic scorer (System One questions)', () => {
  const scorer = new HeuristicScorer();

  it('noul: urgent state scores high, placid state scores low', async () => {
    const urgent = await scorer.evaluate(
      'The deploy failed twice and customers are seeing 500s. Can someone look now? This is blocking sales.',
      [{ name: 'urgent', question: { type: 'noul', instructions: 'The message conveys urgency or time-sensitivity', keywords: ['urgent', 'asap', 'blocking', 'now'] } }],
    );
    const calm = await scorer.evaluate(
      'When you have a moment next sprint, could we revisit the naming of the helper function in the docs folder?',
      [{ name: 'urgent', question: { type: 'noul', instructions: 'The message conveys urgency or time-sensitivity', keywords: ['urgent', 'asap', 'blocking', 'now'] } }],
    );
    const u = urgent[0]?.answer.type === 'noul' ? urgent[0].answer.noul : -1;
    const c = calm[0]?.answer.type === 'noul' ? calm[0].answer.noul : -1;
    expect(u).toBeGreaterThan(0.5);
    expect(c).toBeLessThan(0.5);
    expect(u).toBeGreaterThan(c);
    // Evidence is recorded, not invented.
    expect(urgent[0]?.answer.evidence.matches.length).toBeGreaterThan(0);
  });

  it('choice: routing picks the payment-relevant target with recorded evidence', async () => {
    const results = await scorer.evaluate(
      'The checkout total sometimes shows stale prices after a failed payment retry',
      [
        {
          name: 'route',
          question: {
            type: 'choice',
            instructions: 'Which QA engine owns this task?',
            options: [
              { id: 'payment', description: 'Checkout and payment gateway verification', keywords: ['checkout', 'payment', 'charge'] },
              { id: 'ui', description: 'Visual and layout regression checks', keywords: ['layout', 'css', 'screenshot'] },
              { id: 'db', description: 'Database migration and data integrity checks', keywords: ['migration', 'schema', 'sql'] },
            ],
          },
        },
      ],
    );
    const a = results[0]?.answer;
    expect(a?.type).toBe('choice');
    if (a?.type === 'choice') {
      expect(a.selected).toBe('payment');
      const probSum = Object.values(a.probabilities).reduce((x, y) => x + y, 0);
      expect(probSum).toBeGreaterThan(0.9);
      expect(probSum).toBeLessThan(1.1);
    }
  });

  it('score: severity buckets map to the ordered level ladder', async () => {
    const results = await scorer.evaluate(
      'prod is down, checkout broken for all users, revenue loss every minute',
      [
        {
          name: 'severity',
          question: {
            type: 'score',
            instructions: 'How severe is this incident?',
            levels: ['low', 'medium', 'high', 'critical'],
            levelKeywords: [['cosmetic', 'typo'], ['minor bug', 'workaround'], ['major', 'many users'], ['down', 'outage', 'revenue loss', 'all users']],
          },
        },
      ],
    );
    const a = results[0]?.answer;
    expect(a?.type).toBe('score');
    if (a?.type === 'score') {
      expect(a.level).toBe('critical');
      expect(a.score).toBeGreaterThan(0.5);
    }
  });
});

describe('decision engine + journal', () => {
  it('every decision lands in the JSONL journal with its evidence', async () => {
    const dir = tmp();
    const journalPath = join(dir, 'xroutelm', 'decisions.jsonl');
    const engine = new DecisionEngine(ScorerRegistry.withDefaults(), journalPath);
    const set = await engine.decide('tests fail intermittently on retry', [
      { name: 'flaky', question: { type: 'noul', instructions: 'The described failure looks flaky', keywords: ['intermittent', 'flaky', 'retry', 'sometimes'] } },
    ]);
    expect(set.label).toBe('INFERRED');
    expect(set.decisions).toHaveLength(1);
    const raw = readFileSync(journalPath, 'utf8').trim().split('\n');
    expect(raw).toHaveLength(1);
    const entry = JSON.parse(raw[0] ?? '{}') as { kind: string; stateHash: string };
    expect(entry.kind).toBe('decision');
    expect(entry.stateHash).toBe(set.stateHash);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('router', () => {
  it('routes QA tasks to the right engine with a fallback chain', async () => {
    const dir = tmp();
    const engine = new DecisionEngine(ScorerRegistry.withDefaults(), join(dir, 'j.jsonl'));
    const d = await engine.route('flaky login test passes on second attempt', defaultTargets());
    expect(d.target).toBe('qa-flake-detection');
    expect(d.fallback.length).toBeGreaterThan(0);
    expect(d.fallback).not.toContain(d.target);
    expect(d.label).toBe('INFERRED');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Laya bridge (feature-detected, honest)', () => {
  it('reports itself unavailable off macOS/arm64 with the real reason', () => {
    const bridge = new LayaBridgeScorer();
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      expect(bridge.available || bridge.unavailableReason !== undefined).toBe(true);
    } else {
      expect(bridge.available).toBe(false);
      expect(bridge.unavailableReason).toBeDefined();
    }
  });

  it('registry falls back to the heuristic scorer when the bridge is unavailable', async () => {
    const registry = ScorerRegistry.withDefaults();
    const { scorer, fallbacksUsed } = registry.resolve('xroutelm/laya-bridge');
    // On non-macOS CI the bridge is unavailable → heuristic resolves.
    if (process.platform !== 'darwin') {
      expect(scorer.id).toBe('xroutelm/heuristic');
      expect(fallbacksUsed.join('; ')).toContain('laya-bridge');
      expect(fallbacksUsed.join('; ')).toContain('requires macOS');
    }
  });
});

describe('System One harness (agent-loop middleware)', () => {
  it('gate blocks when a noul question is below threshold, passes above', async () => {
    const dir = tmp();
    const engine = new DecisionEngine(ScorerRegistry.withDefaults(), join(dir, 'j.jsonl'));
    const harness = new SystemOneHarness(engine, new HeuristicScorer());
    const questions = [{ name: 'needs_attention', question: { type: 'noul' as const, instructions: 'This needs immediate attention', keywords: ['urgent', 'down', 'blocked', 'asap'] } }];

    const hot = await harness.gate('production is down, checkout blocked for all users', questions, { threshold: 0.5 });
    const cold = await harness.gate('docs typo fix proposal for next month', questions, { threshold: 0.5 });
    expect(hot.proceed).toBe(true);
    expect(cold.proceed).toBe(false);
    expect(hot.reasons.join('\n')).toContain('pass');
    expect(cold.reasons.join('\n')).toContain('block');
    rmSync(dir, { recursive: true, force: true });
  });

  it('model routing middleware picks fast vs powerful and honors the fallback floor', async () => {
    const dir = tmp();
    const engine = new DecisionEngine(ScorerRegistry.withDefaults(), join(dir, 'j.jsonl'));
    const harness = new SystemOneHarness(engine, new HeuristicScorer());
    const config = {
      choices: [
        { id: 'fast', criteria: 'Direct lookups, extraction, and localized changes', keywords: ['lookup', 'rename', 'docs', 'typo'] },
        { id: 'powerful', criteria: 'Complex debugging, concurrency, architecture changes', keywords: ['race', 'deadlock', 'architecture', 'debug'] },
      ],
      minConfidence: 0.35,
      fallback: 'default-model',
    };
    const simple = await harness.routeModel('rename a variable in the docs generator', config);
    const complex = await harness.routeModel('fix a deadlock between the worker queue and the rate limiter', config);
    expect(simple.model).toBe('fast');
    expect(complex.model).toBe('powerful');
    expect(simple.usedFallback).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('route stats learning', () => {
  it('demotes targets below 0.3 success and promotes those above 0.7', () => {
    const dir = tmp();
    const stats = new RouteStats(join(dir, 'stats.jsonl'));
    for (let i = 0; i < 6; i++) stats.record('bad-target', false, 'misroute');
    for (let i = 0; i < 6; i++) stats.record('good-target', true, 'solved');
    const targets = [
      { id: 'neutral', description: 'n' },
      { id: 'bad-target', description: 'b' },
      { id: 'good-target', description: 'g' },
    ];
    const adjusted = stats.apply(targets);
    expect(adjusted[0]?.id).toBe('good-target');
    expect(adjusted[adjusted.length - 1]?.id).toBe('bad-target');
    // Rates are readable for reporting.
    const rates = stats.rates();
    expect(rates.get('bad-target')?.rate).toBe(0);
    expect(rates.get('good-target')?.rate).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('plugin system', () => {
  it('discovers local plugin manifests and namespaces their target ids', () => {
    const dir = tmp();
    const pluginDir = join(dir, 'xroutelm.plugins', 'deploy');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'xroutelm.plugin.json'),
      JSON.stringify({ name: 'deploy', description: 'Deploy gates', targets: [{ id: 'canary', description: 'Canary rollout checks', keywords: ['deploy', 'canary'] }] }),
    );
    const plugins = discoverPlugins(dir);
    expect(plugins).toHaveLength(1);
    const { targets, errors } = targetsWithPlugins(defaultTargets(), plugins, dir);
    expect(errors).toHaveLength(0);
    expect(targets.some((t) => t.id === 'deploy:canary')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('malformed manifests produce visible errors, never silent skips', () => {
    const dir = tmp();
    const pluginDir = join(dir, 'xroutelm.plugins', 'broken');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'xroutelm.plugin.json'), '{ "name": "" }');
    const plugins = discoverPlugins(dir);
    expect(plugins[0]?.errors.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('calibration curve', () => {
  it('maps measured similarity to bounded probabilities without hardcoding outcomes', () => {
    expect(calibrate(0)).toBeLessThan(0.1);
    expect(calibrate(0.32)).toBeCloseTo(0.5, 1);
    expect(calibrate(1)).toBeGreaterThan(0.9);
    expect(calibrate(1)).toBeLessThanOrEqual(0.98);
  });
});
