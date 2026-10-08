import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditGoldenRules } from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import { EXIT_FINDINGS, EXIT_OK, flagString, ok } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa audit-rules — mechanically audit a payload against the enforceable
 * subset of the 15 Golden Rules (read-only).
 *
 *   qa audit-rules --op heal --payload proposal.json
 *   qa audit-rules --op generate --payload-json '{"e2eRatio":0.6,"seed":"s"}'
 *
 * Rules that lack the fields they need report `applicable: false` — an
 * inapplicable rule is honest, a fake pass is not. Exit 1 on any violation.
 */

const OPS = new Set(['heal', 'generate', 'triage', 'test', 'release', 'review', 'coverage']);

async function run(ctx: CommandContext): Promise<CommandResult> {
  const op = flagString(ctx, 'op');
  if (op === undefined || !OPS.has(op)) {
    throw new Error(`--op is required (one of: ${[...OPS].join(', ')})`);
  }
  const payloadFile = flagString(ctx, 'payload');
  const payloadJson = flagString(ctx, 'payload-json');
  if ((payloadFile === undefined) === (payloadJson === undefined)) {
    throw new Error('provide exactly one of --payload <file> or --payload-json <json>');
  }

  let payload: unknown;
  if (payloadFile !== undefined) {
    const path = resolve(payloadFile);
    if (!existsSync(path)) throw new Error(`payload file not found: ${payloadFile}`);
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } else {
    try {
      payload = JSON.parse(payloadJson ?? '{}');
    } catch (e) {
      throw new Error(`--payload-json is not valid JSON: ${(e as Error).message}`);
    }
  }

  const report = auditGoldenRules(op, payload);

  if (ctx.json) {
    return ok(report, report.valid ? 'OBSERVED' : 'OBSERVED', report.valid ? EXIT_OK : EXIT_FINDINGS);
  }

  ctx.logger.banner('audit-rules');
  ctx.logger.info(`operation: ${op} · applicable rules checked: ${report.checked}`);
  for (const r of report.results) {
    const mark = !r.applicable ? 'SKIP' : r.passed ? 'PASS' : 'FAIL';
    ctx.logger.info(`  [${mark}] rule ${r.id} — ${r.name}: ${r.detail}`);
  }
  if (report.valid) {
    ctx.logger.info('→ no golden-rule violations detected');
  } else {
    for (const v of report.violations) ctx.logger.info(`violation: ${v}`);
    ctx.logger.info('→ golden-rule violations present; see docs (rules without enforcement are documentation, not governance)');
  }
  return ok(report, 'OBSERVED', report.valid ? EXIT_OK : EXIT_FINDINGS);
}

export const auditRulesCommand: CommandSpec = {
  name: 'audit-rules',
  summary: 'mechanically audit a payload against the enforceable subset of the 15 Golden Rules (read-only)',
  usage: 'qa audit-rules --op <heal|generate|triage|test|release|review|coverage> (--payload <file> | --payload-json <json>) [--json]',
  positionals: [],
  flags: [
    { name: 'op', value: true, description: 'Operation context for the audit' },
    { name: 'payload', value: true, description: 'Payload JSON file to audit' },
    { name: 'payload-json', value: true, description: 'Inline payload JSON to audit' },
  ],
  run,
};
