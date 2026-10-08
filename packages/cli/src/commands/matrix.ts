import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandSpec } from '../args.js';
import { EXIT_OK, EXIT_FINDINGS, flagString, ok, rootFrom } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa matrix — the quality traceability matrix (read-only).
 *
 * Reads `.theqa/matrix.json` (or --matrix <file>): an array of records
 *   { "requirement": "…", "testId": "…", "layer": "unit|integration|api|e2e",
 *     "status": "passing|failing|not_run", "riskTier": "low|medium|high|critical",
 *     "evidence?": "artifacts/run-…" }
 * and renders requirement→test coverage with per-requirement confidence:
 *   CONFIRMED (≥1 passing with evidence) · OBSERVED (≥1 passing, no evidence)
 *   NOT_RUN (tests exist, never executed) · GAP (no tests at all).
 *
 * Honest by design: a missing or empty file is reported as an empty matrix
 * with instructions — the command never invents requirement coverage.
 */

interface MatrixRecord {
  requirement: string;
  testId: string;
  layer: string;
  status: string;
  riskTier?: string;
  evidence?: string;
}

const LAYERS = new Set(['unit', 'integration', 'api', 'e2e', 'visual', 'a11y', 'performance', 'security', 'contract', 'manual']);
const STATUSES = new Set(['passing', 'failing', 'not_run']);

function requirementConfidence(records: MatrixRecord[]): { confidence: string; passing: number; total: number } {
  const passing = records.filter((r) => r.status === 'passing').length;
  const withEvidence = records.some((r) => r.status === 'passing' && typeof r.evidence === 'string' && r.evidence.length > 0);
  if (records.length === 0) return { confidence: 'GAP', passing: 0, total: 0 };
  if (passing === 0) return { confidence: 'NOT_RUN', passing: 0, total: records.length };
  return { confidence: withEvidence ? 'CONFIRMED' : 'OBSERVED', passing, total: records.length };
}

async function run(ctx: CommandContext): Promise<CommandResult> {
  const root = rootFrom(ctx);
  const matrixPath = join(root, flagString(ctx, 'matrix') ?? join('.theqa', 'matrix.json'));

  let records: MatrixRecord[] = [];
  let errors: string[] = [];
  let source = matrixPath;
  if (existsSync(matrixPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(matrixPath, 'utf8'));
      if (!Array.isArray(parsed)) {
        errors.push('matrix.json must be an array of records');
      } else {
        for (const [i, raw] of parsed.entries()) {
          const rec = raw as Partial<MatrixRecord>;
          if (typeof rec.requirement !== 'string' || rec.requirement.length === 0) errors.push(`records[${i}].requirement missing`);
          if (typeof rec.testId !== 'string' || rec.testId.length === 0) errors.push(`records[${i}].testId missing`);
          if (rec.layer !== undefined && !LAYERS.has(rec.layer)) errors.push(`records[${i}].layer "${rec.layer}" not in ${[...LAYERS].join('|')}`);
          if (rec.status !== undefined && !STATUSES.has(rec.status)) errors.push(`records[${i}].status "${rec.status}" not in ${[...STATUSES].join('|')}`);
        }
        if (errors.length === 0) records = parsed as MatrixRecord[];
      }
    } catch (e) {
      errors.push(`unreadable matrix.json: ${(e as Error).message}`);
    }
  } else {
    source = '';
  }

  // Group by requirement, preserving first-seen order.
  const byRequirement = new Map<string, MatrixRecord[]>();
  for (const r of records) {
    const list = byRequirement.get(r.requirement) ?? [];
    list.push(r);
    byRequirement.set(r.requirement, list);
  }

  const rows = [...byRequirement.entries()].map(([requirement, recs]) => {
    const conf = requirementConfidence(recs);
    return {
      requirement,
      tests: recs.length,
      passing: conf.passing,
      layers: [...new Set(recs.map((r) => r.layer).filter(Boolean))],
      highestRisk: recs.find((r) => r.riskTier === 'critical') !== undefined ? 'critical' : recs.find((r) => r.riskTier === 'high') !== undefined ? 'high' : recs[0]?.riskTier ?? 'unspecified',
      confidence: conf.confidence,
    };
  });

  const gaps = rows.filter((r) => r.confidence === 'GAP').length;
  const untested = rows.filter((r) => r.confidence === 'NOT_RUN').length;
  const summary = {
    requirements: rows.length,
    records: records.length,
    confirmed: rows.filter((r) => r.confidence === 'CONFIRMED').length,
    observed: rows.filter((r) => r.confidence === 'OBSERVED').length,
    gaps,
    untested,
    source: source === '' ? null : source,
    errors,
  };

  if (ctx.json) {
    return ok({ summary, rows, records }, 'OBSERVED', errors.length > 0 || gaps > 0 ? EXIT_FINDINGS : EXIT_OK);
  }

  ctx.logger.banner('matrix');
  if (records.length === 0) {
    ctx.logger.info('No traceability records found.');
    ctx.logger.info(`Write ${matrixPath} as an array of { requirement, testId, layer, status, riskTier, evidence? } records.`);
    ctx.logger.info('The generate and test commands document how they map requirements to generated tests.');
    if (errors.length > 0) {
      for (const e of errors) ctx.logger.info(`  error: ${e}`);
      return ok({ summary, rows: [], records: [] }, 'NOT_VERIFIED', EXIT_FINDINGS);
    }
    return ok({ summary, rows: [], records: [] }, 'NOT_RUN', EXIT_OK);
  }

  ctx.logger.info(`  ${'requirement'.padEnd(44)} ${'tests'.padStart(5)} ${'pass'.padStart(5)}  confidence  highest risk`);
  for (const r of rows) {
    ctx.logger.info(`  ${r.requirement.slice(0, 44).padEnd(44)} ${String(r.tests).padStart(5)} ${String(r.passing).padStart(5)}  ${r.confidence.padEnd(10)}  ${r.highestRisk}`);
  }
  ctx.logger.info('');
  ctx.logger.info(`${summary.requirements} requirement(s): ${summary.confirmed} CONFIRMED · ${summary.observed} OBSERVED · ${summary.untested} NOT_RUN · ${summary.gaps} GAP`);
  if (errors.length > 0) {
    for (const e of errors) ctx.logger.info(`  error: ${e}`);
  }
  return ok({ summary, rows, records }, 'OBSERVED', errors.length > 0 || gaps > 0 ? EXIT_FINDINGS : EXIT_OK);
}

export const matrixCommand: CommandSpec = {
  name: 'matrix',
  summary: 'render the requirement→test traceability matrix with per-requirement confidence (read-only)',
  usage: 'qa matrix [--matrix <file>] [--json]',
  positionals: [],
  flags: [
    { name: 'matrix', value: true, description: 'Matrix file path (default .theqa/matrix.json)' },
  ],
  run,
};
