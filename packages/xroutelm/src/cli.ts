#!/usr/bin/env node
/**
 * xroutelm — command line for the System One decision engine.
 *
 *   xroutelm decide --state "..." --q urgent:noul:"Does this need attention now?"[:kw1,kw2]
 *   xroutelm route  "task text" [--json] [--scorer xroutelm/heuristic]
 *   xroutelm doctor              (scorer availability + plugin report)
 *   xroutelm plugins list
 *
 * Every command supports --json. Exit codes: 0 ok · 1 refusal/blocked · 2 error.
 */
import { DecisionEngine, RouteStats, defaultTargets } from './engine.js';
import { discoverPlugins, targetsWithPlugins } from './plugins.js';
import { ScorerRegistry } from './scorers.js';
import type { QuestionRequest } from './types.js';

interface Parsed {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq > 2) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const name = tok.slice(2);
        const next = argv[i + 1];
        if (name === 'q' || name === 'scorer' || name === 'stats' || name === 'journal' || name === 'state') {
          flags[name] = next ?? '';
          i += 1;
        } else {
          flags[name] = true;
        }
      }
      continue;
    }
    if (command === undefined) command = tok;
    else positionals.push(tok);
  }
  return { command, positionals, flags };
}

/** Parse `name:noul:"instructions":kw1,kw2` style question specs (quotes optional). */
export function parseQuestionSpec(spec: string): QuestionRequest {
  const m = /^([a-zA-Z0-9_-]+):(noul|choice|score):([\s\S]*?)(?::([a-z0-9_,\s]+))?$/i.exec(spec);
  if (m === null) {
    throw new Error(`bad --q spec "${spec}" — expected name:type:text[:keywords]`);
  }
  const name = m[1];
  const kind = m[2];
  const text = m[3];
  const kw = m[4];
  if (name === undefined || kind === undefined || text === undefined) {
    throw new Error(`bad --q spec "${spec}" — expected name:type:text[:keywords]`);
  }
  const keywords = kw !== undefined ? kw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  if (kind === 'noul') {
    return { name, question: { type: 'noul', instructions: text, keywords } };
  }
  throw new Error(`question type "${kind}" via CLI currently supports noul only (use route for choice)`);
}

async function main(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parse(argv);
  const json = flags['json'] === true;
  const registry = ScorerRegistry.withDefaults();
  const journalPath = typeof flags['journal'] === 'string' ? flags['journal'] : '.xroutelm/decisions.jsonl';
  const engine = new DecisionEngine(registry, journalPath);
  const state = typeof flags['state'] === 'string' ? flags['state'] : positionals.join(' ');

  try {
    if (command === 'decide') {
      const specs = ([] as string[]).concat(flags['q'] !== undefined && flags['q'] !== true ? [String(flags['q'])] : [], positionals);
      const requests = specs.map(parseQuestionSpec);
      if (requests.length === 0) {
        console.error('error: no questions given — use --q name:noul:"instructions"[:keywords]');
        return 2;
      }
      const set = await engine.decide(state, requests, typeof flags['scorer'] === 'string' ? flags['scorer'] : undefined);
      if (json) console.log(JSON.stringify(set, null, 2));
      else {
        console.log(`scorer: ${set.scorer}`);
        for (const d of set.decisions) {
          if (d.answer.type === 'noul') {
            console.log(`${d.name}: noul=${d.answer.noul} confidence=${d.answer.confidence}`);
            for (const m of d.answer.evidence.matches.slice(0, 3)) console.log(`  + ${m.token} (${m.source}, ${m.weight})`);
          }
        }
      }
      return 0;
    }

    if (command === 'route') {
      if (!state) {
        console.error('error: provide a task description');
        return 2;
      }
      const plugins = discoverPlugins(process.cwd());
      const merged = targetsWithPlugins(defaultTargets(), plugins, process.cwd());
      const stats = new RouteStats(typeof flags['stats'] === 'string' ? flags['stats'] : '.xroutelm/route-stats.jsonl');
      const targets = stats.apply(merged.targets);
      const decision = await engine.route(state, targets, typeof flags['scorer'] === 'string' ? flags['scorer'] : undefined);
      if (json) console.log(JSON.stringify({ ...decision, pluginErrors: merged.errors }, null, 2));
      else {
        console.log(`route → ${decision.target} (confidence ${decision.confidence}, scorer ${decision.scorer})`);
        console.log(`fallback chain: ${decision.fallback.join(' → ') || 'none'}`);
        for (const m of decision.evidence.matches.slice(0, 4)) console.log(`  + ${m.token} (${m.source})`);
      }
      return 0;
    }

    if (command === 'doctor') {
      const plugins = discoverPlugins(process.cwd());
      const report = {
        scorers: registry.list().map((s) => ({ id: s.id, available: s.available, reason: s.unavailableReason, description: s.description, costWeight: s.costWeight })),
        plugins: plugins.map((p) => ({ name: p.manifest.name, path: p.path, errors: p.errors })),
      };
      if (json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const s of report.scorers) {
          console.log(`${s.available ? 'AVAILABLE' : 'UNAVAILABLE'}  ${s.id}${s.reason ? ` — ${s.reason}` : ''}`);
        }
        console.log(`plugins: ${report.plugins.length === 0 ? 'none discovered' : ''}`);
        for (const p of report.plugins) console.log(`  ${p.name} (${p.path})${p.errors.length > 0 ? ` errors: ${p.errors.join('; ')}` : ''}`);
      }
      return 0;
    }

    if (command === 'plugins' && positionals[0] === 'list') {
      const plugins = discoverPlugins(process.cwd());
      if (json) console.log(JSON.stringify(plugins.map((p) => ({ name: p.manifest.name, path: p.path, targets: p.manifest.targets ?? [], errors: p.errors })), null, 2));
      else if (plugins.length === 0) console.log('no plugins discovered (looked in ./xroutelm.plugins/, ~/.xroutelm/plugins/)');
      else for (const p of plugins) console.log(`${p.manifest.name} — ${p.path} — ${(p.manifest.targets ?? []).length} target(s)`);
      return 0;
    }

    console.error('usage: xroutelm <decide|route|doctor|plugins list> ...');
    return 2;
  } catch (e) {
    const msg = (e as Error).message;
    if (json) console.log(JSON.stringify({ ok: false, error: msg, label: 'NOT_VERIFIED' }, null, 2));
    else console.error(`error: ${msg}`);
    return 2;
  }
}

/* istanbul ignore next */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
