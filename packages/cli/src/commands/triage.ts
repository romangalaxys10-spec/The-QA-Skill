import { TriageAgent, detectPrimaryCascade } from '@the-qa-skill/agents';
import type { CommandSpec } from '../args.js';
import {
  artifactsDirFor, flagString, loadFailureEvidence, loadProject, ok, rootFrom, EXIT_FINDINGS, EXIT_OK,
} from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';
import { triageContextForRange } from './triage-core.js';

/**
 * qa triage [--evidence <file|dir>] [--range a..b]
 *
 * Reads FailedTestRecord JSON (a file, or every failures.json under a
 * directory; defaults to scanning the artifacts directory) and classifies each
 * failure through the core 12-category decision table. With --range the diff
 * becomes triage context: changed files feed `coversChangedCode` and the raw
 * diff text feeds `detectSelectorChange` against the test file on disk.
 *
 * Human output: a classification card per failure (category, confidence,
 * hypothesis, action, signals/contradicting) + cluster summary. JSON: full
 * results, clusters, and primary/cascade detection.
 */

export interface TriageData {
  failures: number;
  sources: string[];
  skipped: number;
  results: ReturnType<TriageAgent['triage']>;
  clusters: ReturnType<TriageAgent['clusters']>;
  primaryIds: string[];
  cascadeIds: string[];
  range?: string;
  realRegressions: number;
  unknown: number;
}

async function run(ctx: CommandContext): Promise<CommandResult<TriageData>> {
  const root = rootFrom(ctx);
  const config = loadProject(root);
  const evidencePath = flagString(ctx, 'evidence');
  const range = flagString(ctx, 'range');
  const evidence = loadFailureEvidence(root, evidencePath, artifactsDirFor(root));

  if (evidence.records.length === 0) {
    ctx.logger.banner('triage');
    ctx.logger.info('No failure records found — nothing to triage.');
    ctx.logger.info(`Pass --evidence <file|dir> or write failures.json under ${config.paths.artifacts}.`);
    return ok<TriageData>(
      {
        failures: 0, sources: [], skipped: 0, results: [], clusters: [], primaryIds: [], cascadeIds: [],
        realRegressions: 0, unknown: 0, ...(range !== undefined ? { range } : {}),
      },
      'NOT_RUN',
      EXIT_OK,
    );
  }

  let tctx = {};
  if (range !== undefined) {
    tctx = await triageContextForRange(root, range);
  }
  const agent = new TriageAgent(root);
  const results = agent.triage(evidence.records, tctx);
  const clusters = agent.clusters(evidence.records);
  const { primaryIds, cascadeIds } = detectPrimaryCascade(clusters, evidence.records);

  const realRegressions = results.filter((r) => r.category === 'REAL_REGRESSION').length;
  const unknown = results.filter((r) => r.category === 'UNKNOWN').length;

  ctx.logger.banner('triage');
  ctx.logger.info(`${evidence.records.length} failure(s) from ${evidence.sources.length} evidence file(s)${evidence.skipped > 0 ? ` (${evidence.skipped} malformed record(s) skipped)` : ''}`);
  for (const result of results) {
    ctx.logger.info('');
    ctx.logger.info(`── ${result.testId} ─────────────────────────────`);
    ctx.logger.info(`category:    ${result.category} (confidence ${(result.confidence * 100).toFixed(0)}%, ${result.label})`);
    ctx.logger.info(`hypothesis:  ${result.rootCauseHypothesis}`);
    ctx.logger.info(`action:      ${result.recommendedAction}`);
    for (const s of result.signals) ctx.logger.info(`  + ${s.description}`);
    for (const s of result.contradictingSignals) ctx.logger.info(`  − ${s.description}`);
  }
  ctx.logger.info('');
  ctx.logger.info(`Clusters: ${clusters.length} distinct signature(s)${primaryIds.length > 0 ? ` · primary: ${primaryIds.join(', ')}` : ''}${cascadeIds.length > 0 ? ` · cascade: ${cascadeIds.join(', ')}` : ''}`);
  for (const c of clusters) {
    ctx.logger.info(`  ${c.id} — ${c.testIds.length} test(s): ${c.signature.slice(0, 110)}`);
  }

  const exit = realRegressions > 0 ? EXIT_FINDINGS : EXIT_OK;
  return {
    ok: exit === EXIT_OK,
    data: {
      failures: evidence.records.length,
      sources: evidence.sources,
      skipped: evidence.skipped,
      results,
      clusters,
      primaryIds,
      cascadeIds,
      realRegressions,
      unknown,
      ...(range !== undefined ? { range } : {}),
    },
    label: results.length > 0 ? results[0]!.label : 'NOT_RUN',
    exitCode: exit,
  };
}

export const triageCommand: CommandSpec = {
  name: 'triage',
  summary: 'classify failures into the 12 documented categories with evidence (read-only)',
  usage: 'qa triage [--evidence <file|dir>] [--range a..b] [--json] [--verbose]',
  positionals: [],
  flags: [
    { name: 'evidence', value: true, description: 'failure records JSON file or directory containing failures.json' },
    { name: 'range', value: true, description: 'diff range supplying triage context, e.g. HEAD~1..HEAD' },
  ],
  run,
};
