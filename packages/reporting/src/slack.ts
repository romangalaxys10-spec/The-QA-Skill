import type { ReleaseGateResult, RiskAssessment } from '@the-qa-skill/core';

/**
 * Slack payload builder — Block Kit structure with an honestly colored
 * verdict attachment:
 *
 * - PASS               → 'good'     (green)
 * - PASS_WITH_WARNINGS → '#e2b203'  (amber — warnings are visible, not red)
 * - BLOCKED / FAIL     → 'danger'   (red)
 * - UNKNOWN / no gate  → '#808080'  (grey — "we don't know" is its own color)
 */

export interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

export interface SlackBlock {
  type: 'header' | 'section' | 'context' | 'divider';
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  elements?: SlackTextObject[];
}

export interface SlackAttachment {
  color: string;
  blocks: SlackBlock[];
}

export interface SlackMessage {
  /** Plain-text fallback (notification preview). */
  text: string;
  blocks: SlackBlock[];
  attachments: SlackAttachment[];
}

export interface SlackPayloadInput {
  title: string;
  gate?: ReleaseGateResult;
  failing: number;
  total: number;
  risk?: RiskAssessment;
  /** Link back to the full report or CI run. */
  url?: string;
}

/** Map a release verdict onto its Slack attachment color. */
export function colorForVerdict(verdict: ReleaseGateResult['verdict'] | undefined): string {
  switch (verdict) {
    case 'PASS':
      return 'good';
    case 'PASS_WITH_WARNINGS':
      return '#e2b203';
    case 'BLOCKED':
    case 'FAIL':
      return 'danger';
    default:
      return '#808080';
  }
}

/** Build the Block Kit message. Never throws; missing data degrades honestly. */
export function toSlackPayload(input: SlackPayloadInput): SlackMessage {
  const verdict = input.gate?.verdict;
  const verdictText = verdict ?? 'UNKNOWN';
  const passed = Math.max(0, input.total - input.failing);
  const passRate = input.total > 0 ? `${((passed / input.total) * 100).toFixed(1)}%` : 'n/a';

  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: input.title, emoji: false } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tests*\n${passed}/${input.total} passed (${passRate})` },
        { type: 'mrkdwn', text: `*Failing*\n${input.failing}` },
        { type: 'mrkdwn', text: `*Verdict*\n${verdictText}` },
        {
          type: 'mrkdwn',
          text: input.risk ? `*Risk*\n${input.risk.tier} (${input.risk.score}/100) ${labelTag(input.risk.label)}` : '*Risk*\nno assessment (NOT_VERIFIED)',
        },
      ],
    },
  ];

  if (input.url) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${input.url}|View full report> · generated ${new Date().toISOString()}` }],
    });
  }

  const attachmentBlocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: attachmentText(input),
      },
    },
  ];

  const text =
    `${input.title}: ${verdictText} — ${passed}/${input.total} passed, ${input.failing} failing` +
    (input.risk ? ` · risk ${input.risk.tier} (${input.risk.score}/100)` : '');

  return {
    text,
    blocks,
    attachments: [{ color: colorForVerdict(verdict), blocks: attachmentBlocks }],
  };
}

function attachmentText(input: SlackPayloadInput): string {
  const gate = input.gate;
  if (!gate) return 'No release gate evaluation was attached to this run — verdict unknown (NOT_RUN).';
  const lines: string[] = [`*${gate.verdict}* ${labelTag(gate.label)}`];
  for (const reason of gate.reasons.slice(0, 3)) lines.push(`• ${reason}`);
  if (gate.warnings.length > 0) lines.push(`⚠ ${gate.warnings.length} warning(s): ${gate.warnings[0]}`);
  if (gate.blockingFindings.length > 0) lines.push(`:no_entry: ${gate.blockingFindings.length} blocking finding(s): \`${gate.blockingFindings[0]}\``);
  return lines.join('\n');
}

function labelTag(label: string): string {
  return `(_${label}_)`;
}
