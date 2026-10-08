import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProposal, canApply, selectorCandidatesFromSnapshot } from '@the-qa-skill/core';
import type { HealingProposal } from '@the-qa-skill/core';
import { HealingAgent, TriageAgent } from '@the-qa-skill/agents';
import type { FailedTestRecord, TriageResult } from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import { UsageError } from '../args.js';
import {
  artifactsDirFor, flagBool, flagString, loadFailureEvidence, loadProject, ok, rootFrom, EXIT_OK,
} from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';
import { LearningStore } from '@the-qa-skill/core';

/**
 * qa heal [--evidence <file>] [--apply] [--confirm-risk]
 *
 * Builds tiered healing proposals from triaged failures:
 *   - SELECTOR_FAILURE: extract the failed selector from the error message,
 *     read the test file, and (when the evidence carries a DOM snapshot —
 *     documented contract: a `domSnapshot` string per record or a top-level
 *     `domSnapshots` map) propose a swap observed in the target state → HIGH
 *     tier candidate. Without a snapshot the proposal is explain-only (LOW):
 *     swapping blind would be guessing.
 *   - TIMING_FAILURE: when the test contains a fixed wait, the proposal spells
 *     out the naive "raise the timeout" fix so the core tier engine can mark
 *     it forbidden — LOW tier, do-not-modify, with the web-first guidance in
 *     the description.
 *
 * `--apply` applies HIGH-tier, zero-violation proposals only, and requires
 * --confirm-risk. Applied proposals are recorded in the learning store
 * (healing_applied / healing_rejected) via HealingAgent.
 */

export interface HealData {
  proposals: HealingProposal[];
  applied: Array<{ id: string; applied: boolean; reason: string; backupPath?: string }>;
  triage: Array<{ testId: string; category: string }>;
  notes: string[];
  applyRequested: boolean;
}

const FAILED_CALL_RE = /((?:locator|getBy(?:Role|Text|Label|TestId))\(\s*['"][^'"]+['"]\s*\))/g;

/** Extract the failed selector call from error message/stack, e.g. locator('x'). */
export function failedSelectorCall(record: FailedTestRecord): string | undefined {
  const text = record.attempts.map((a) => `${a.errorType ?? ''} ${a.errorMessage ?? ''} ${a.errorStack ?? ''}`).join('\n');
  const matches = [...text.matchAll(FAILED_CALL_RE)].map((m) => m[1] ?? '').filter((s) => s.length > 0);
  return matches[0];
}

function selectorProposal(root: string, record: FailedTestRecord, snapshot: string | undefined, notes: string[]): HealingProposal | undefined {
  const call = failedSelectorCall(record);
  if (call === undefined || call.length === 0) {
    notes.push(`${record.testId}: no locator call found in the error message — no selector proposal`);
    return undefined;
  }
  const abs = join(root, record.filePath);
  if (!existsSync(abs)) {
    notes.push(`${record.testId}: test file missing (${record.filePath}) — no proposal`);
    return undefined;
  }
  const source = readFileSync(abs, 'utf8');
  if (!source.includes(call)) {
    notes.push(`${record.testId}: test file does not contain "${call}" verbatim — refusing a blind patch`);
    return undefined;
  }
  const literalMatch = call.match(/['"]([^'"]+)['"]/);
  const failedSelector = literalMatch?.[1] ?? '';
  const candidates = snapshot !== undefined && failedSelector !== ''
    ? selectorCandidatesFromSnapshot(snapshot, failedSelector)
    : [];
  if (candidates.length === 0) {
    // Explain-only: the engine will mark the missing-snapshot violation (LOW).
    return buildProposal({
      testId: record.testId,
      filePath: record.filePath,
      kind: 'selector',
      description: `selector ${call} failed. No DOM snapshot in the evidence — capturing one (evidence bundle domSnapshot) would enable a HIGH-tier, evidence-backed repair. Proposing an identical no-op patch so the tier engine records what is missing.`,
      currentCode: call,
      proposedCode: call,
      signals: ['triage category SELECTOR_FAILURE', 'no DOM snapshot evidence available'],
    });
  }
  return buildProposal({
    testId: record.testId,
    filePath: record.filePath,
    kind: 'selector',
    description: `replace failed ${call} with ${candidates[0]} — observed in the captured DOM snapshot`,
    currentCode: call,
    proposedCode: candidates[0] ?? call,
    observedInTarget: snapshot,
    signals: ['triage category SELECTOR_FAILURE', 'proposed selector located in captured target state'],
  });
}

const FIXED_WAIT_RE = /^[^\n]*waitForTimeout\s*\(\s*\d+\s*\)[^\n]*$/m;

function timingProposal(root: string, record: FailedTestRecord, notes: string[]): HealingProposal | undefined {
  const abs = join(root, record.filePath);
  if (!existsSync(abs)) {
    notes.push(`${record.testId}: test file missing (${record.filePath}) — no proposal`);
    return undefined;
  }
  const source = readFileSync(abs, 'utf8');
  const line = source.match(FIXED_WAIT_RE)?.[0];
  if (line === undefined) {
    notes.push(`${record.testId}: timing failure without a fixed wait in source — profile before touching timeouts (no proposal)`);
    return undefined;
  }
  const currentCode = line.trim();
  return buildProposal({
    testId: record.testId,
    filePath: record.filePath,
    kind: 'timing',
    description: 'timing failure: the actual guidance is to replace fixed waits with web-first assertions and profile the slow step. The proposal below spells out the naive "raise the wait" fix so the tier engine records it as forbidden (golden rule 3) — do not apply.',
    currentCode,
    proposedCode: 'test.setTimeout(15000); // NAIVE suggestion: raising the timeout is forbidden as a first response',
    signals: ['triage category TIMING_FAILURE', 'fixed wait found in test source'],
  });
}

async function run(ctx: CommandContext): Promise<CommandResult<HealData>> {
  const root = rootFrom(ctx);
  const config = loadProject(root);
  const evidence = loadFailureEvidence(root, flagString(ctx, 'evidence'), artifactsDirFor(root));
  const applyRequested = flagBool(ctx, 'apply');
  const confirmRisk = flagBool(ctx, 'confirm-risk');
  const notes: string[] = [];

  if (evidence.records.length === 0) {
    ctx.logger.banner('heal');
    ctx.logger.info('No failure evidence found — nothing to heal.');
    ctx.logger.info('Run tests, then `qa triage` / `qa heal` against the artifacts.');
    return ok<HealData>({ proposals: [], applied: [], triage: [], notes: ['no failure evidence'], applyRequested }, 'NOT_RUN', EXIT_OK);
  }

  const results: TriageResult[] = new TriageAgent(root).triage(evidence.records);
  const proposals: HealingProposal[] = [];
  for (let i = 0; i < evidence.records.length; i++) {
    const record = evidence.records[i]!;
    const result = results[i];
    if (!result || result.category === 'SELECTOR_FAILURE') {
      const p = selectorProposal(root, record, evidence.domSnapshots.get(record.testId), notes);
      if (p) proposals.push(p);
    } else if (result.category === 'TIMING_FAILURE') {
      const p = timingProposal(root, record, notes);
      if (p) proposals.push(p);
    }
  }

  const applied: HealData['applied'] = [];
  if (applyRequested) {
    if (!confirmRisk) {
      throw new UsageError(
        'heal --apply requires --confirm-risk',
        'healing patches test files; review the proposals first, then re-run with --apply --confirm-risk',
      );
    }
    const learning = new LearningStore(join(root, config.paths.learning));
    const agent = new HealingAgent(root, { learning, confirmRisk: true });
    for (const p of proposals) {
      if (!canApply(p)) {
        applied.push({ id: p.id, applied: false, reason: `tier ${p.tier} is propose-only` });
        continue;
      }
      const result = agent.apply(p, { confirmRisk: true });
      applied.push({ id: p.id, applied: result.applied, reason: result.reason, ...(result.backupPath !== undefined ? { backupPath: result.backupPath } : {}) });
    }
  }

  ctx.logger.banner(applyRequested ? 'heal — apply requested' : 'heal — propose only');
  if (proposals.length === 0) {
    ctx.logger.info('No healing proposals built from the evidence.');
  }
  const tierOrder = ['HIGH', 'MEDIUM', 'LOW'] as const;
  for (const tier of tierOrder) {
    const group = proposals.filter((p) => p.tier === tier);
    for (const p of group) {
      ctx.logger.info('');
      ctx.logger.info(`[${tier}] ${p.id} · ${p.kind} · confidence ${(p.confidence * 100).toFixed(0)}% · ${p.testId}`);
      ctx.logger.info(`  ${p.description}`);
      for (const c of p.policyChecks) ctx.logger.info(`  ✓ ${c}`);
      for (const v of p.violations) ctx.logger.info(`  ✗ ${v}`);
    }
  }
  for (const note of notes) ctx.logger.info(`  note: ${note}`);
  if (applyRequested) {
    ctx.logger.info('');
    ctx.logger.info('Applied:');
    for (const a of applied) ctx.logger.info(`  ${a.applied ? '✓' : '·'} ${a.id}: ${a.reason}`);
  } else if (proposals.some((p) => p.tier === 'HIGH')) {
    ctx.logger.info('');
    ctx.logger.info('HIGH-tier proposal(s) available — re-run with --apply --confirm-risk to apply them.');
  }

  return ok<HealData>(
    {
      proposals,
      applied,
      triage: results.map((r) => ({ testId: r.testId, category: r.category })),
      notes,
      applyRequested,
    },
    'INFERRED',
    EXIT_OK,
  );
}

export const healCommand: CommandSpec = {
  name: 'heal',
  summary: 'build tiered self-healing proposals; apply HIGH tier with --apply --confirm-risk',
  usage: 'qa heal [--evidence <file>] [--apply] [--confirm-risk] [--json]',
  positionals: [],
  flags: [
    { name: 'evidence', value: true, description: 'failure records JSON (default: failures.json under artifacts)' },
    { name: 'apply', value: false, description: 'apply HIGH-tier, zero-violation proposals' },
    { name: 'confirm-risk', value: false, description: 'required with --apply (patching test files is confirm-gated)' },
  ],
  run,
};
