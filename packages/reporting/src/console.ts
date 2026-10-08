import type { ExecutionStatus, ReleaseGateResult, RiskAssessment, SelectionResult, TestEvent, TriageResult } from '@the-qa-skill/core';

/**
 * Compact plain-text summary for CLI output. The library never emits ANSI
 * color codes — the CLI owns colorization; this string must be readable
 * raw (logs, cron mail, MCP text responses).
 */

export interface ConsoleSummaryInput {
  risk?: RiskAssessment;
  selection?: SelectionResult;
  triage?: TriageResult[];
  gate?: ReleaseGateResult;
  events?: TestEvent[];
}

/**
 * Render the summary. Sections appear only for provided inputs; with no data
 * at all the output states that honestly instead of pretending success.
 */
export function renderConsoleSummary(input: ConsoleSummaryInput): string {
  const lines: string[] = ['QA Summary'];

  const provided =
    (input.risk ? 1 : 0) +
    (input.selection ? 1 : 0) +
    (input.triage ? 1 : 0) +
    (input.gate ? 1 : 0) +
    (input.events ? 1 : 0);

  if (provided === 0) {
    lines.push('  (no data provided — nothing to report; verdict UNKNOWN (NOT_VERIFIED))');
    return lines.join('\n') + '\n';
  }

  if (input.risk) {
    lines.push(`  risk:      ${input.risk.score}/100 (${input.risk.tier}) (${input.risk.label})`);
    const top = input.risk.topContributors.slice(0, 2).map((c) => `${c.factor} +${c.contribution.toFixed(0)}`);
    if (top.length > 0) lines.push(`             top: ${top.join(', ')}`);
  }

  if (input.selection) {
    lines.push(
      `  selection: ${input.selection.selected.length} selected, ${input.selection.unaffected.length} unaffected (${input.selection.label})`,
    );
  }

  if (input.triage) {
    const byCategory = new Map<string, number>();
    for (const t of input.triage) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + 1);
    const parts = [...byCategory.entries()].map(([cat, n]) => `${cat} x${n}`);
    lines.push(
      `  triage:    ${input.triage.length} classified${parts.length > 0 ? ` — ${parts.join(', ')}` : ''} (${input.triage[0]?.label ?? 'INFERRED'})`,
    );
  }

  if (input.gate) {
    lines.push(`  gate:      ${input.gate.verdict} (${input.gate.label})`);
    for (const reason of input.gate.reasons.slice(0, 3)) lines.push(`             - ${reason}`);
  }

  if (input.events) {
    const byStatus = new Map<ExecutionStatus, number>();
    for (const e of input.events) byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
    const parts = (['passed', 'failed', 'timedout', 'skipped', 'not_run'] as const)
      .filter((s) => byStatus.has(s))
      .map((s) => `${byStatus.get(s)} ${s}`);
    lines.push(
      `  events:    ${input.events.length} total${parts.length > 0 ? ` — ${parts.join(', ')}` : ''} (OBSERVED)`,
    );
  }

  return lines.join('\n') + '\n';
}
