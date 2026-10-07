import { analyzeCoverage, discover, isGitRepo, scoreFlake, suiteFlakeHealth } from '@the-qa-skill/core';
import type { FlakeAssessment, RiskAssessment, TriageResult } from '@the-qa-skill/core';
import { computeReleaseGate } from '@the-qa-skill/reporting';
import type { ReleaseGateResult } from '@the-qa-skill/core';
import { RiskAgent, TriageAgent } from '@the-qa-skill/agents';
import type { CommandSpec } from '../args.js';
import {
  artifactsDirFor, buildInventory, hasExecutionEvidence, loadFailureEvidence, loadFlakeInputs,
  loadProject, ok, rootFrom, EXIT_FINDINGS, EXIT_OK,
} from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';
import { DEFAULT_RANGE, assessWithFallback } from './risk.js';
import { triageContextForRange } from './triage-core.js';

/**
 * qa release — the deterministic ship/no-ship gate from cheap local evidence.
 *
 * Gathers (all optional, honestly reported when absent):
 *   risk      — RiskAgent assessment when the project is a git repository
 *   triage    — classification of failures.json under the artifacts directory
 *               (with diff context when git is available)
 *   flake     — critical-flake count from events.json / flake-history.json
 *   coverage  — risk-weighted coverage when the project has source files
 *   evidence  — execution evidence presence (bundles, events, failures)
 *
 * Verdict from reporting.computeReleaseGate: UNKNOWN on empty input (never
 * PASS without data), BLOCKED on observed real regressions, PASS_WITH_WARNINGS
 * on incomplete evidence or threshold warnings. Exit 1 on BLOCKED/FAIL.
 */

export interface ReleaseData {
  gate: ReleaseGateResult;
  risk?: RiskAssessment;
  triageResults: TriageResult[];
  flakeAssessments: FlakeAssessment[];
  coverage?: { weightedCoverage: number; fileCoverage: number; gapCount: number };
  evidence: { complete: boolean; sources: string[] };
  environment: string;
}

async function run(ctx: CommandContext): Promise<CommandResult<ReleaseData>> {
  const root = rootFrom(ctx);
  const config = loadProject(root);
  const artifacts = artifactsDirFor(root);
  const git = await isGitRepo(root);

  // Risk (when git is available).
  let risk: RiskAssessment | undefined;
  if (git) {
    try {
      risk = (await assessWithFallback(root, DEFAULT_RANGE)).assessment;
    } catch (e) {
      ctx.logger.warn(`risk assessment skipped: ${(e as Error).message}`);
    }
  }

  // Triage of recorded failures (diff context when git is available).
  const failureEvidence = loadFailureEvidence(root, undefined, artifacts);
  let triageResults: TriageResult[] = [];
  if (failureEvidence.records.length > 0) {
    const tctx = git ? await triageContextForRange(root, DEFAULT_RANGE) : {};
    triageResults = new TriageAgent(root).triage(failureEvidence.records, tctx);
  }

  // Flake intelligence from recorded history.
  const flakeInputs = loadFlakeInputs(root, undefined, artifacts);
  const flakeAssessments = flakeInputs.inputs.map(scoreFlake);
  const health = suiteFlakeHealth(flakeAssessments);

  // Coverage — only meaningful when source files exist at all.
  const discovery = discover(root);
  let coverage: ReleaseData['coverage'] | undefined;
  if (discovery.sourceFiles.length > 0) {
    const report = analyzeCoverage(discovery.sourceFiles, buildInventory(root, discovery), config.project.criticalFlows);
    coverage = { weightedCoverage: report.weightedCoverage, fileCoverage: report.fileCoverage, gapCount: report.gaps.length };
  }

  const evidence = hasExecutionEvidence(artifacts);
  const gate = computeReleaseGate({
    riskAssessments: risk !== undefined ? [risk] : [],
    triageResults,
    flakeAssessments,
    coverage: coverage !== undefined
      ? { weightedCoverage: coverage.weightedCoverage, fileCoverage: coverage.fileCoverage, gaps: [], criticalFlowCoverage: [], label: 'INFERRED' }
      : undefined,
    failedRealRegressions: triageResults.filter((t) => t.category === 'REAL_REGRESSION').length,
    openUnknownCategories: triageResults.filter((t) => t.category === 'UNKNOWN').length,
    criticalFlakeCount: health.critical,
    evidenceComplete: evidence.complete,
    environment: 'local',
  });

  ctx.logger.banner('release gate');
  const mark = gate.verdict === 'PASS' ? '✓' : gate.verdict === 'BLOCKED' || gate.verdict === 'FAIL' ? '✗' : '!';
  ctx.logger.info(`${mark} Verdict: ${gate.verdict} (${gate.label})`);
  ctx.logger.info('');
  ctx.logger.info('Reasons:');
  for (const reason of gate.reasons) ctx.logger.info(`  · ${reason}`);
  if (gate.blockingFindings.length > 0) {
    ctx.logger.info('');
    ctx.logger.info('Blocking findings:');
    for (const b of gate.blockingFindings) ctx.logger.info(`  ✗ ${b}`);
  }
  if (gate.warnings.length > 0) {
    ctx.logger.info('');
    ctx.logger.info('Warnings:');
    for (const w of gate.warnings) ctx.logger.info(`  ! ${w}`);
  }
  ctx.logger.info('');
  ctx.logger.info(`Evidence complete: ${String(evidence.complete)}${evidence.sources.length > 0 ? ` (${evidence.sources.join(', ')})` : ''}`);
  ctx.logger.info(`Risk: ${risk ? `${risk.score}/100 (${risk.tier})` : 'not assessed (no git repository)'}`);
  ctx.logger.info(`Triage: ${triageResults.length} result(s) · flakes: ${flakeAssessments.length} (critical ${health.critical}) · coverage: ${coverage ? `${coverage.weightedCoverage.toFixed(1)}%` : 'not computed (no source files)'}`);

  const exit = gate.verdict === 'BLOCKED' || gate.verdict === 'FAIL' ? EXIT_FINDINGS : EXIT_OK;
  return {
    ok: exit === EXIT_OK,
    data: {
      gate,
      ...(risk !== undefined ? { risk } : {}),
      triageResults,
      flakeAssessments,
      ...(coverage !== undefined ? { coverage } : {}),
      evidence: { complete: evidence.complete, sources: evidence.sources },
      environment: 'local',
    },
    label: gate.label,
    exitCode: exit,
  };
}

export const releaseCommand: CommandSpec = {
  name: 'release',
  summary: 'compute the release gate verdict from risk, triage, flake, coverage, and evidence',
  usage: 'qa release [--json] [--verbose]',
  positionals: [],
  flags: [],
  run,
};
