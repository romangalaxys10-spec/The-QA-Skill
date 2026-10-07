import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  analyzeCoverage, discover, isGitRepo, parseContext, scoreFlake, suiteFlakeHealth, suiteHealth as computeSuiteHealth,
} from '@the-qa-skill/core';
import type {
  RiskAssessment, SuiteHealthReport, TestEvent, TriageResult,
} from '@the-qa-skill/core';
import { computeReleaseGate, renderConsoleSummary, renderMarkdownReport } from '@the-qa-skill/reporting';
import type { ConsoleSummaryInput, MarkdownReportInput } from '@the-qa-skill/reporting';
import { RiskAgent, ReviewAgent, TriageAgent } from '@the-qa-skill/agents';
import type { CommandSpec } from '../args.js';
import { UsageError } from '../args.js';
import {
  artifactsDirFor, buildInventory, ensureParentDir, flagString, hasExecutionEvidence, loadFailureEvidence,
  loadFlakeInputs, loadProject, ok, rootFrom, EXIT_OK,
} from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';
import { DEFAULT_RANGE } from './risk.js';
import { triageContextForRange } from './triage-core.js';

/**
 * qa report [--audience engineering|qa|leadership|executive]
 *           [--format md|json|console] [--out file]
 *
 * Assembles inputs from .theqa artifacts plus the live engines (quality
 * review, coverage), then renders:
 *   md      → reporting renderMarkdownReport (audience-specific, labelPolicy
 *             enforced: every claim carries its verification label)
 *   console → reporting renderConsoleSummary
 *   json    → the assembled payload itself (data = report inputs + gate)
 *
 * --out writes the rendered document (LOW_RISK write); without it, output
 * goes to stdout. The audience changes the DOCUMENT, not just the length.
 */

const AUDIENCES: ReadonlySet<string> = new Set(['engineering', 'qa', 'leadership', 'executive']);
const FORMATS: ReadonlySet<string> = new Set(['md', 'json', 'console']);

export interface ReportPayload {
  audience: MarkdownReportInput['audience'];
  format: string;
  gate?: ReturnType<typeof computeReleaseGate>;
  risk?: RiskAssessment;
  triage: TriageResult[];
  events: TestEvent[];
  quality: Awaited<ReturnType<ReviewAgent['review']>>;
  suiteHealth: SuiteHealthReport;
  coverage?: Awaited<ReturnType<typeof analyzeCoverage>>;
  flake: { assessments: number; critical: number };
  evidence: { complete: boolean; sources: string[] };
  contextSource: 'disk' | 'absent';
}

async function run(ctx: CommandContext): Promise<CommandResult<ReportPayload>> {
  const root = rootFrom(ctx);
  const config = loadProject(root);
  const artifacts = artifactsDirFor(root);
  const audience = flagString(ctx, 'audience') ?? 'engineering';
  if (!AUDIENCES.has(audience)) {
    throw new UsageError(`unknown audience "${audience}"`, 'audiences: engineering, qa, leadership, executive');
  }
  const format = flagString(ctx, 'format') ?? 'console';
  if (!FORMATS.has(format)) {
    throw new UsageError(`unknown format "${format}"`, 'formats: md, json, console');
  }
  const outPath = flagString(ctx, 'out');

  // Live engines: quality review of discovered test files + coverage.
  const discovery = discover(root);
  const quality = await new ReviewAgent(root).review();
  const inventory = buildInventory(root, discovery);
  const coverage = discovery.sourceFiles.length > 0
    ? analyzeCoverage(discovery.sourceFiles, inventory, config.project.criticalFlows)
    : undefined;
  const suiteHealthReport: SuiteHealthReport = computeSuiteHealth({
    testReports: quality,
    ...(coverage !== undefined ? { weightedCoverage: coverage.weightedCoverage } : {}),
  });

  // Artifacts: triage + events + flake.
  const failureEvidence = loadFailureEvidence(root, undefined, artifacts);
  const triage: TriageResult[] = failureEvidence.records.length > 0
    ? new TriageAgent(root).triage(
      failureEvidence.records,
      (await isGitRepo(root)) ? await triageContextForRange(root, DEFAULT_RANGE) : {},
    )
    : [];
  const flakeLoaded = loadFlakeInputs(root, undefined, artifacts);
  const flakeAssessments = flakeLoaded.inputs.map(scoreFlake);
  const flakeHealth = suiteFlakeHealth(flakeAssessments);

  let events: TestEvent[] = [];
  const eventsPath = join(artifacts, 'events.json');
  if (existsSync(eventsPath)) {
    try {
      const raw = JSON.parse(readFileSync(eventsPath, 'utf8')) as unknown;
      if (Array.isArray(raw)) events = raw as TestEvent[];
    } catch {
      ctx.logger.warn('artifacts events.json is not valid JSON — events omitted from the report');
    }
  }

  // Risk + gate.
  let risk: RiskAssessment | undefined;
  if (await isGitRepo(root)) {
    try {
      risk = (await new RiskAgent(root, { config }).assess(DEFAULT_RANGE)).assessment;
    } catch {
      risk = undefined;
    }
  }
  const evidence = hasExecutionEvidence(artifacts);
  const gate = computeReleaseGate({
    riskAssessments: risk !== undefined ? [risk] : [],
    triageResults: triage,
    flakeAssessments,
    coverage,
    failedRealRegressions: triage.filter((t) => t.category === 'REAL_REGRESSION').length,
    openUnknownCategories: triage.filter((t) => t.category === 'UNKNOWN').length,
    criticalFlakeCount: flakeHealth.critical,
    evidenceComplete: evidence.complete,
    environment: 'local',
  });

  const contextPath = join(root, config.paths.context);
  const contextSource: 'disk' | 'absent' = existsSync(contextPath) ? 'disk' : 'absent';
  if (contextSource === 'disk') {
    try {
      parseContext(readFileSync(contextPath, 'utf8'));
    } catch {
      ctx.logger.warn('the .theqa/context.json on disk failed validation — report continues without it');
    }
  }

  const payload: ReportPayload = {
    audience: audience as MarkdownReportInput['audience'],
    format,
    gate,
    ...(risk !== undefined ? { risk } : {}),
    triage,
    events,
    quality,
    suiteHealth: suiteHealthReport,
    ...(coverage !== undefined ? { coverage } : {}),
    flake: { assessments: flakeAssessments.length, critical: flakeHealth.critical },
    evidence: { complete: evidence.complete, sources: evidence.sources },
    contextSource,
  };

  let body: string;
  if (format === 'md') {
    const mdInput: MarkdownReportInput = {
      audience: audience as MarkdownReportInput['audience'],
      title: `QA report — ${config.project.name}`,
      ...(risk !== undefined ? { risk } : {}),
      ...(coverage !== undefined ? { coverage } : {}),
      triage,
      quality,
      suiteHealth: suiteHealthReport,
      gate,
      events,
      labelPolicy: true,
    };
    body = renderMarkdownReport(mdInput);
  } else if (format === 'console') {
    const consoleInput: ConsoleSummaryInput = {
      ...(risk !== undefined ? { risk } : {}),
      gate,
      triage,
      events,
    };
    body = renderConsoleSummary(consoleInput);
  } else {
    body = JSON.stringify(payload, null, 2) + '\n';
  }

  if (outPath !== undefined) {
    const abs = resolve(root, outPath);
    ensureParentDir(abs);
    writeFileSync(abs, body, 'utf8');
    ctx.logger.info(`report written: ${abs}`);
  } else {
    ctx.logger.info(body.replace(/\n$/, ''));
  }

  return ok<ReportPayload>(payload, 'INFERRED', EXIT_OK);
}

export const reportCommand: CommandSpec = {
  name: 'report',
  summary: 'render an audience-specific QA report (md | json | console)',
  usage: 'qa report [--audience engineering|qa|leadership|executive] [--format md|json|console] [--out file]',
  positionals: [],
  flags: [
    { name: 'audience', value: true, description: 'engineering (default) | qa | leadership | executive' },
    { name: 'format', value: true, description: 'console (default) | md | json' },
    { name: 'out', value: true, description: 'write the rendered report to this file' },
  ],
  run,
};
