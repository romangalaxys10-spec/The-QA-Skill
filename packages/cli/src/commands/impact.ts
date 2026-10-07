import { discover, matchAny } from '@the-qa-skill/core';
import type { ChangedFile, SelectionResult } from '@the-qa-skill/core';
import { analyzeDiff, classifyRouting, selectTests } from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import { buildInventory, flagString, loadProject, ok, rootFrom, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';
import { DEFAULT_RANGE, requireGitRepo } from './risk.js';

/**
 * qa impact [--range a..b] — the smallest high-confidence test set for a
 * change set (read-only).
 *
 * Pipeline: analyzeDiff → classifyRouting → inventory (core discover +
 * per-test import closure) → selectTests. Human output: routing hints,
 * selected tests grouped by priority with file-level reasons, unaffected
 * count, and the summary. JSON: the full SelectionResult plus the change set
 * that produced it.
 */

export interface ImpactComputation {
  selection: SelectionResult;
  changedFiles: ChangedFile[];
  addedLines: number;
  removedLines: number;
  range: string;
  inventoryCount: number;
}

/**
 * The shared impact pipeline (used by `impact` and by `test` for its
 * selection). `suite` optionally filters selected tests by glob on the test
 * file path or the files it covers.
 */
export async function computeImpact(root: string, range: string, opts: { suite?: string } = {}): Promise<ImpactComputation> {
  const config = loadProject(root);
  const diff = await analyzeDiff(root, range);
  const routing = classifyRouting(diff.files);
  const inventory = buildInventory(root, discover(root));
  let selection = selectTests(diff.files, inventory, routing, {
    alwaysInclude: config.selection.alwaysInclude,
    maxPrE2E: config.selection.maxPrE2E,
    policy: 'pr',
  });
  if (opts.suite !== undefined) {
    const glob = [opts.suite];
    const filtered = selection.selected.filter(
      (s) => matchAny(s.test.filePath, glob) || s.test.covers.some((c) => matchAny(c, glob)),
    );
    selection = {
      ...selection,
      selected: filtered,
      summary: `${filtered.length} of ${inventory.length} inventory tests match --suite ${opts.suite}; ${selection.unaffected.length} unaffected.`,
    };
  }
  return { selection, changedFiles: diff.files, addedLines: diff.addedLines, removedLines: diff.removedLines, range, inventoryCount: inventory.length };
}

export interface ImpactData extends SelectionResult {
  range: string;
  root: string;
  changedFiles: Array<{ path: string; status: string; additions: number; deletions: number; area: string }>;
  addedLines: number;
  removedLines: number;
}

const PRIORITY_ORDER: ReadonlyArray<SelectionResult['selected'][number]['priority']> = ['critical', 'high', 'medium', 'low'];

async function run(ctx: CommandContext): Promise<CommandResult<ImpactData>> {
  const root = rootFrom(ctx);
  await requireGitRepo(root, 'impact');
  const range = flagString(ctx, 'range') ?? DEFAULT_RANGE;
  const suite = flagString(ctx, 'suite');
  const { selection, changedFiles, addedLines, removedLines, inventoryCount } = await computeImpact(root, range, { suite });

  ctx.logger.banner(`impact — ${range}`);
  const areas = [...new Set(changedFiles.map((f) => f.area))];
  ctx.logger.info(`change set: ${changedFiles.length} file(s), +${addedLines}/−${removedLines}${areas.length > 0 ? ` · areas: ${areas.join(', ')}` : ''}`);
  for (const f of changedFiles.slice(0, 12)) {
    ctx.logger.info(`  ${f.status.padEnd(8)} ${f.path.padEnd(44)} +${f.additions}/−${f.deletions} [${f.area}]`);
  }
  if (changedFiles.length > 12) ctx.logger.info(`  … and ${changedFiles.length - 12} more`);

  ctx.logger.info('');
  ctx.logger.info('Routing hints:');
  for (const hint of selection.routing) {
    ctx.logger.info(`  ${hint.triggered ? '✔' : '·'} ${hint.rule.padEnd(16)} → ${hint.action}`);
    if (hint.triggered) ctx.logger.info(`      ${hint.reason}`);
  }

  ctx.logger.info('');
  if (selection.selected.length === 0) {
    ctx.logger.info('No inventory test covers the change set — this is a coverage gap, not a pass.');
    ctx.logger.info('Run `qa coverage` to see the gap list, or `qa generate` to scaffold tests.');
  } else {
    ctx.logger.info(`Selected tests by priority (${selection.selected.length} of ${inventoryCount}):`);
    for (const priority of PRIORITY_ORDER) {
      const group = selection.selected.filter((s) => s.priority === priority);
      if (group.length === 0) continue;
      ctx.logger.info(`  ${priority.toUpperCase()}`);
      for (const s of group) {
        ctx.logger.info(`    ${s.test.filePath.padEnd(48)} ${s.test.framework}/${s.test.layer}`);
        for (const reason of s.reasons) ctx.logger.info(`      - ${reason}`);
      }
    }
  }
  ctx.logger.info('');
  ctx.logger.info(`Unaffected: ${selection.unaffected.length} test(s)${selection.unaffected.length > 0 ? ` (${selection.unaffected.slice(0, 5).map((t) => t.filePath).join(', ')}${selection.unaffected.length > 5 ? ', …' : ''})` : ''}`);
  ctx.logger.info(`Summary: ${selection.summary} (${selection.label})`);

  return ok<ImpactData>(
    {
      ...selection,
      range,
      root,
      changedFiles: changedFiles.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, area: f.area })),
      addedLines,
      removedLines,
    },
    selection.label,
    EXIT_OK,
  );
}

export const impactCommand: CommandSpec = {
  name: 'impact',
  summary: 'select the smallest high-confidence test set for a change (read-only)',
  usage: 'qa impact [--range a..b] [--suite glob] [--json] [--verbose]',
  positionals: [],
  flags: [
    { name: 'range', value: true, description: `diff range to analyze (default ${DEFAULT_RANGE})` },
    { name: 'suite', value: true, description: 'glob filter over selected tests (test file path or covered files)' },
  ],
  run,
};
