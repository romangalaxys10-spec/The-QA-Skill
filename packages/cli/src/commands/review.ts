import { discover, suiteHealth } from '@the-qa-skill/core';
import type { SuiteHealthReport } from '@the-qa-skill/core';
import { ReviewAgent } from '@the-qa-skill/agents';
import type { CommandSpec } from '../args.js';
import { buildInventory, ok, rootFrom, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa review [paths...] — static test-quality review (read-only).
 * Per-file score table (score, test count, top deductions) + suite health.
 * JSON: the full TestQualityReport[] + SuiteHealthReport.
 */

export interface ReviewData {
  reports: Awaited<ReturnType<ReviewAgent['review']>>;
  suiteHealth: SuiteHealthReport;
  root: string;
}

async function run(ctx: CommandContext): Promise<CommandResult<ReviewData>> {
  const root = rootFrom(ctx);
  const agent = new ReviewAgent(root);
  const paths = ctx.positionals.length > 0 ? ctx.positionals : undefined;
  const reports = await agent.review(paths);

  if (reports.length === 0) {
    ctx.logger.banner('review');
    ctx.logger.info('No test-shaped files found to review.');
    ctx.logger.info('Test-shaped = *.test.* / *.spec.* files, or anything under __tests__/.');
    const health = suiteHealth({ testReports: [] });
    return ok<ReviewData>({ reports: [], suiteHealth: health, root }, 'NOT_RUN', EXIT_OK);
  }

  const discovery = discover(root);
  const inventory = buildInventory(root, discovery);
  const coveredSourceFiles = new Set(inventory.flatMap((t) => t.covers));
  const substantive = discovery.sourceFiles.filter((f) => coveredSourceFiles.has(f));
  const weightedCoverage = discovery.sourceFiles.length > 0
    ? Math.round((substantive.length / discovery.sourceFiles.length) * 1000) / 10
    : 0;
  const health = suiteHealth({ testReports: reports, weightedCoverage });

  ctx.logger.banner('review');
  ctx.logger.info(`${reports.length} test file(s) reviewed (static 17-dimension analysis, INFERRED):`);
  ctx.logger.info('');
  for (const r of reports) {
    ctx.logger.info(`  ${r.filePath.padEnd(52)} score ${String(r.score).padStart(3)}/100 · ${r.testCount} test(s)`);
    for (const d of r.deductions.slice(0, 3)) {
      ctx.logger.info(`      -${String(d.points).padStart(2)} ${d.dimension.padEnd(18)} ${d.reason}${d.line !== undefined ? ` (line ${d.line})` : ''}`);
    }
    if (r.deductions.length > 3) ctx.logger.info(`      … and ${r.deductions.length - 3} more deduction(s)`);
    for (const s of r.strengths.slice(0, 2)) ctx.logger.info(`      + ${s}`);
  }
  ctx.logger.info('');
  ctx.logger.info(`Suite health: ${health.score}/100 (${health.label})`);
  for (const c of health.components) {
    ctx.logger.info(`  ${c.component.padEnd(22)} ${String(c.score).padStart(3)}/100 (weight ${c.weight}) — ${c.notes}`);
  }

  return ok<ReviewData>({ reports, suiteHealth: health, root }, reports[0]?.label ?? 'INFERRED', EXIT_OK);
}

export const reviewCommand: CommandSpec = {
  name: 'review',
  summary: 'static test-quality review with explainable deductions (read-only)',
  usage: 'qa review [paths...] [--json] [--verbose]',
  positionals: ['[paths...]'],
  flags: [],
  run,
};
