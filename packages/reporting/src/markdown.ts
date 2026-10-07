import type {
  CoverageReport,
  ExecutionStatus,
  ReleaseGateResult,
  RiskAssessment,
  SelectionResult,
  SuiteHealthReport,
  TestEvent,
  TestQualityReport,
  TriageResult,
} from '@the-qa-skill/core';

/**
 * Markdown report renderer with four deliberately DIFFERENT renderings —
 * engineering, QA, leadership, and executive readers need different truths,
 * not the same document with fewer bullet points.
 *
 * VERIFICATION LABEL POLICY (the reason `labelPolicy` is a required literal):
 * every claim in the output carries the verification label of the structure it
 * came from — e.g. "(INFERRED)", "(OBSERVED)". Where data is absent the report
 * says so plainly instead of inventing content. Claims without labels are a
 * policy violation; `renderMarkdownReport` refuses to run without it.
 */

export interface FailureClusterSummary {
  id: string;
  signature: string;
  testIds: string[];
  category?: string;
  isPrimary?: boolean;
}

export interface MarkdownReportInput {
  audience: 'engineering' | 'qa' | 'leadership' | 'executive';
  title: string;
  risk?: RiskAssessment;
  selection?: SelectionResult;
  triage?: TriageResult[];
  clusters?: FailureClusterSummary[];
  quality?: TestQualityReport[];
  suiteHealth?: SuiteHealthReport;
  coverage?: CoverageReport;
  gate?: ReleaseGateResult;
  events?: TestEvent[];
  labelPolicy: true;
}

/**
 * Render a markdown report for one audience. Same input, four different
 * documents — see the module doc for the label policy.
 */
export function renderMarkdownReport(input: MarkdownReportInput): string {
  if (input.labelPolicy !== true) {
    throw new Error('labelPolicy must be true — reports without verification labels are not allowed');
  }
  const lines: string[] = [];
  lines.push(`# ${input.title}`, '');
  lines.push(`**Audience:** ${input.audience} · **Generated:** ${new Date().toISOString()}`, '');
  lines.push(
    '_Every claim carries its verification label: (CONFIRMED) > (OBSERVED) > (INFERRED) > (NOT_RUN) > (NOT_VERIFIED). Absent data is stated as absent._',
    '',
  );

  if (input.gate) {
    lines.push(`**Release gate:** ${input.gate.verdict} (${input.gate.label})`);
    for (const reason of input.gate.reasons.slice(0, 5)) lines.push(`- ${reason}`);
    lines.push('');
  }

  switch (input.audience) {
    case 'engineering':
      renderEngineering(input, lines);
      break;
    case 'qa':
      renderQa(input, lines);
      break;
    case 'leadership':
      renderLeadership(input, lines);
      break;
    case 'executive':
      renderExecutive(input, lines);
      break;
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Engineering: what failed, why, what to do, where the proof lives
// ---------------------------------------------------------------------------

function renderEngineering(input: MarkdownReportInput, lines: string[]): void {
  lines.push('## Failing tests', '');
  const failures = (input.events ?? []).filter((e) => e.status === 'failed' || e.status === 'timedout');
  if (failures.length === 0) {
    lines.push((input.events?.length ?? 0) > 0 ? 'No failing tests in this run (OBSERVED).' : 'No execution events were provided — nothing to report (NOT_RUN).');
  } else {
    lines.push(`${failures.length} failing test(s) (OBSERVED):`, '');
    for (const f of failures) {
      lines.push(`- **${f.name}** — ${f.status} (${f.framework}, ${f.durationMs}ms, attempt ${f.retryIndex + 1}) \`${f.testId}\``);
      if (f.filePath) lines.push(`  - file: \`${f.filePath}\``);
      if (f.errorMessage) lines.push(`  - error: \`${firstLine(f.errorMessage)}\``);
    }
  }
  lines.push('');

  const triage = input.triage ?? [];
  lines.push('## Root cause & recommended action', '');
  if (triage.length === 0) {
    lines.push('No triage results were provided — run triage before acting on these failures (NOT_VERIFIED).', '');
  } else {
    const byTestId = new Map(triage.map((t) => [t.testId, t]));
    const targets = failures.length > 0 ? failures.map((f) => byTestId.get(f.testId)).filter((t): t is TriageResult => t !== undefined) : triage;
    if (targets.length === 0) {
      lines.push(`${triage.length} triage result(s) provided but none match the failing tests above (${triage[0]?.label ?? 'INFERRED'}).`, '');
    }
    for (const t of targets) {
      lines.push(`### ${t.testId}`);
      lines.push(`- **Root cause hypothesis (${t.label}):** ${t.rootCauseHypothesis}`);
      lines.push(`- **Category:** ${t.category} (confidence ${(t.confidence * 100).toFixed(0)}%)`);
      lines.push(`- **Recommended action:** ${t.recommendedAction}`);
      const evidence = t.evidence.filter((e) => e.location).map((e) => `\`${e.location}\``);
      lines.push(`- **Evidence:** ${evidence.length > 0 ? evidence.join(', ') : 'no evidence pointers recorded (NOT_VERIFIED)'}`);
      lines.push('');
    }
  }

  if (input.risk) {
    lines.push('## Change risk', '');
    lines.push(`- Risk score **${input.risk.score}/100 (${input.risk.tier})** (${input.risk.label})`);
    lines.push(`- ${input.risk.explanation}`);
    const top = input.risk.topContributors.slice(0, 3).map((c) => `${c.factor} (+${c.contribution.toFixed(1)})`);
    lines.push(`- Top contributors: ${top.join(', ')}`, '');
  }
}

// ---------------------------------------------------------------------------
// QA: coverage, flake, quality, dedup — the suite-improvement view
// ---------------------------------------------------------------------------

function renderQa(input: MarkdownReportInput, lines: string[]): void {
  if (input.coverage) {
    const c = input.coverage;
    lines.push('## Coverage', '');
    lines.push(`- Risk-weighted coverage **${c.weightedCoverage.toFixed(1)}%**, raw file coverage ${c.fileCoverage.toFixed(1)}% (${c.label})`);
    const uncoveredFlows = c.criticalFlowCoverage.filter((f) => !f.covered);
    lines.push(`- Critical flows covered: ${c.criticalFlowCoverage.length - uncoveredFlows.length}/${c.criticalFlowCoverage.length}`);
    if (uncoveredFlows.length > 0) {
      lines.push(`- Uncovered critical flows (INFERRED): ${uncoveredFlows.map((f) => f.flow).join(', ')}`);
    }
    if (c.gaps.length > 0) {
      lines.push('', 'Top coverage gaps:', '');
      for (const gap of c.gaps.slice(0, 5)) {
        lines.push(`- \`${gap.path}\` — ${gap.reason} (risk weight ${gap.riskWeight.toFixed(1)})`);
      }
    }
    lines.push('');
  } else {
    lines.push('## Coverage', '', 'No coverage analysis was provided — coverage claims are intentionally absent (NOT_VERIFIED).', '');
  }

  if (input.clusters && input.clusters.length > 0) {
    lines.push('## Failure deduplication', '');
    const totalMembers = input.clusters.reduce((n, c) => n + c.testIds.length, 0);
    lines.push(`${totalMembers} failing test(s) collapse into ${input.clusters.length} distinct signature cluster(s) (INFERRED):`, '');
    for (const c of input.clusters) {
      lines.push(`- \`${c.id}\` ${c.isPrimary ? '**[primary]** ' : ''}${c.category ? `(${c.category}) ` : ''}— ${c.testIds.length} test(s): ${c.signature}`);
    }
    lines.push('');
  }

  if (input.quality && input.quality.length > 0) {
    lines.push('## Test quality deductions', '');
    for (const q of input.quality) {
      lines.push(`- \`${q.filePath}\` — score **${q.score}/100** across ${q.testCount} test(s) (${q.label})`);
      for (const d of q.deductions.slice(0, 5)) {
        lines.push(`  - ${d.dimension}: -${d.points} — ${d.reason}${d.line !== undefined ? ` (line ${d.line})` : ''}`);
      }
    }
    lines.push('');
  } else {
    lines.push('## Test quality', '', 'No test quality reports were provided (NOT_VERIFIED).', '');
  }

  if (input.suiteHealth) {
    const weak = input.suiteHealth.components.filter((c) => c.score < 60);
    lines.push('## Suite health', '');
    lines.push(`- Composite **${input.suiteHealth.score}/100** (${input.suiteHealth.label})`);
    for (const c of weak) lines.push(`- Weak component: ${c.component} — ${c.score}/100 (weight ${c.weight}) — ${c.notes}`);
    lines.push('');
  }

  if (input.selection) {
    const s = input.selection;
    lines.push('## Selection', '');
    lines.push(`- ${s.selected.length} test(s) selected, ${s.unaffected.length} unaffected (${s.label})`);
    lines.push(`- ${s.summary}`);
    lines.push('');
  }

  lines.push('## Execution events', '');
  renderEventCounts(input.events ?? [], lines);
}

// ---------------------------------------------------------------------------
// Leadership: confidence, critical risks, trends (or their honest absence)
// ---------------------------------------------------------------------------

function renderLeadership(input: MarkdownReportInput, lines: string[]): void {
  lines.push('## Release confidence', '');
  if (input.gate) {
    lines.push(`- Verdict **${input.gate.verdict}** (${input.gate.label})`);
    lines.push(`- Warnings: ${input.gate.warnings.length > 0 ? input.gate.warnings.length : 'none'}`);
  } else {
    lines.push('- No release gate evaluation was provided — confidence cannot be stated (NOT_RUN).');
  }
  lines.push('');

  lines.push('## Critical risks', '');
  if (input.risk && (input.risk.tier === 'critical' || input.risk.tier === 'high')) {
    lines.push(`- Change risk is **${input.risk.tier.toUpperCase()}** (${input.risk.score}/100) (${input.risk.label})`);
    lines.push(`- ${input.risk.explanation}`);
  } else if (input.risk) {
    lines.push(`- No high or critical risk signals in this change set (${input.risk.tier}, ${input.risk.score}/100) (${input.risk.label}).`);
  } else {
    lines.push('- No risk assessment was provided — risk exposure is unknown (NOT_VERIFIED).');
  }
  const unknownTriage = (input.triage ?? []).filter((t) => t.category === 'UNKNOWN');
  if (unknownTriage.length > 0) {
    lines.push(`- ${unknownTriage.length} failure(s) remain unclassified and need owner attention (INFERRED).`);
  }
  lines.push('');

  lines.push('## Trends', '');
  lines.push(
    'No historical trend data was provided to this report — trend claims are intentionally absent rather than invented (NOT_VERIFIED).',
  );
  lines.push('');

  if (input.selection) {
    lines.push('## Scope of testing', '');
    lines.push(`- ${input.selection.selected.length} test(s) selected against this change; ${input.selection.unaffected.length} confirmed unaffected (${input.selection.label}).`);
    lines.push('');
  }
}

// ---------------------------------------------------------------------------
// Executive: verdict, blockers, business exposure — three paragraphs, no jargon
// ---------------------------------------------------------------------------

function renderExecutive(input: MarkdownReportInput, lines: string[]): void {
  lines.push('## Release readiness', '');
  if (input.gate) {
    lines.push(`**${verdictSentence(input.gate.verdict)}** (${input.gate.label})`);
  } else {
    lines.push('**No gate data was provided — readiness is UNKNOWN.** A verdict will not be invented (NOT_RUN).');
  }
  lines.push('');

  lines.push('## Blockers', '');
  if (input.gate && input.gate.blockingFindings.length > 0) {
    for (const b of input.gate.blockingFindings) lines.push(`- ${b}`);
  } else {
    lines.push('- No blocking findings recorded (OBSERVED).');
  }
  lines.push('');

  lines.push('## Business risk exposure', '');
  if (input.risk) {
    lines.push(`- Change risk: **${input.risk.tier}** (${input.risk.score}/100) — ${input.risk.explanation} (${input.risk.label})`);
  } else {
    lines.push('- No risk assessment available for this change (NOT_VERIFIED).');
  }
  const realRegressions = (input.triage ?? []).filter((t) => t.category === 'REAL_REGRESSION').length;
  if (realRegressions > 0) {
    lines.push(`- ${realRegressions} confirmed real regression(s) in business behavior (INFERRED).`);
  }
  if (input.coverage) {
    lines.push(`- Risk-weighted test coverage of the change: ${input.coverage.weightedCoverage.toFixed(0)}% (${input.coverage.label})`);
  }
  lines.push('');

  lines.push('## Decision', '');
  lines.push(decisionLine(input.gate?.verdict));
  lines.push('');
  lines.push('## Execution summary', '');
  renderEventCounts(input.events ?? [], lines);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function renderEventCounts(events: TestEvent[], lines: string[]): void {
  if (events.length === 0) {
    lines.push('No execution events were provided (NOT_RUN).');
    return;
  }
  const byStatus = new Map<ExecutionStatus, number>();
  for (const e of events) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
  const parts = (['passed', 'failed', 'timedout', 'skipped', 'not_run'] as const)
    .filter((s) => byStatus.has(s))
    .map((s) => `${byStatus.get(s)} ${s}`);
  lines.push(`${events.length} event(s) (OBSERVED): ${parts.join(', ')}.`);
}

function verdictSentence(verdict: ReleaseGateResult['verdict']): string {
  switch (verdict) {
    case 'PASS':
      return 'This release is ready to ship — all evaluated quality gates passed.';
    case 'PASS_WITH_WARNINGS':
      return 'This release can ship, with recorded warnings that need owners.';
    case 'BLOCKED':
      return 'This release is blocked by quality gate findings.';
    case 'FAIL':
      return 'This release failed review and must not ship.';
    case 'UNKNOWN':
      return 'There is not enough verified data to call this release.';
  }
}

function decisionLine(verdict: ReleaseGateResult['verdict'] | undefined): string {
  switch (verdict) {
    case 'PASS':
      return 'Proceed with release. Keep monitoring post-deploy signals (OBSERVED).';
    case 'PASS_WITH_WARNINGS':
      return 'Proceed only after assigning owners to the warnings above (OBSERVED).';
    case 'BLOCKED':
    case 'FAIL':
      return 'Hold the release. Resolve the blockers above and re-run the gate (OBSERVED).';
    default:
      return 'Do not decide yet — collect the missing evidence first (NOT_RUN).';
  }
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}
