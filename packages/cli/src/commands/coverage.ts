import { analyzeCoverage, discover } from '@the-qa-skill/core';
import type { CoverageReport } from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import { buildInventory, flagBool, loadProject, ok, rootFrom, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa coverage [--flows] — business-risk-aware coverage (read-only).
 * Not line coverage: of the source files that matter (weighted by area
 * criticality), which are covered by at least one test, and which named
 * critical flows lack any reach. `--flows` adds the per-flow detail section
 * (criticalFlowCoverage is always present in JSON).
 */

export interface CoverageData extends CoverageReport {
  root: string;
  sourceFileCount: number;
}

async function run(ctx: CommandContext): Promise<CommandResult<CoverageData>> {
  const root = rootFrom(ctx);
  const config = loadProject(root);
  const discovery = discover(root);
  const inventory = buildInventory(root, discovery);
  const report = analyzeCoverage(discovery.sourceFiles, inventory, config.project.criticalFlows);

  ctx.logger.banner('coverage');
  ctx.logger.info(`risk-weighted coverage: ${report.weightedCoverage.toFixed(1)}% · raw file coverage: ${report.fileCoverage.toFixed(1)}% (${report.label})`);
  ctx.logger.info(`source files: ${discovery.sourceFiles.length} · inventory tests: ${inventory.length}`);
  ctx.logger.info('');

  if (report.gaps.length === 0) {
    ctx.logger.info('Gaps: none — every substantive source file is reached by at least one test.');
  } else {
    ctx.logger.info(`Gaps (${report.gaps.length}, highest risk first):`);
    ctx.logger.info(`  ${'path'.padEnd(44)} ${'area'.padEnd(9)} ${'weight'.padStart(6)}  reason`);
    for (const gap of report.gaps) {
      ctx.logger.info(`  ${gap.path.padEnd(44)} ${gap.area.padEnd(9)} ${String(gap.riskWeight).padStart(6)}  ${gap.reason}`);
    }
  }

  if (flagBool(ctx, 'flows') || report.criticalFlowCoverage.length > 0) {
    ctx.logger.info('');
    if (config.project.criticalFlows.length === 0) {
      ctx.logger.info('Critical flows: none configured — add project.criticalFlows to theqa.config.json.');
    } else {
      ctx.logger.info('Critical flows:');
      for (const flow of report.criticalFlowCoverage) {
        ctx.logger.info(`  ${flow.covered ? '✓' : '✗'} ${flow.flow} — ${flow.note}`);
      }
    }
  }

  return ok<CoverageData>({ ...report, root, sourceFileCount: discovery.sourceFiles.length }, report.label, EXIT_OK);
}

export const coverageCommand: CommandSpec = {
  name: 'coverage',
  summary: 'risk-weighted coverage, gap list, and critical-flow reach (read-only)',
  usage: 'qa coverage [--flows] [--json] [--verbose]',
  positionals: [],
  flags: [
    { name: 'flows', value: false, description: 'always show the critical-flow detail section' },
  ],
  run,
};
