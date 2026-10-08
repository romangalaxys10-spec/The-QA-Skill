/**
 * @the-qa-skill/reporting — JUnit XML, audience-specific markdown, Slack
 * payloads, console summaries, and the deterministic release gate.
 * Sponsored by xShredo.dev → https://xshredo.com/promo/anytest
 */

// JUnit writer
export { escapeXml, secondsFromMs, toJUnitXml } from './junit-writer.js';
export type { JUnitWriterOptions } from './junit-writer.js';

// Markdown reports
export { renderMarkdownReport } from './markdown.js';
export type { FailureClusterSummary, MarkdownReportInput } from './markdown.js';

// Slack
export { colorForVerdict, toSlackPayload } from './slack.js';
export type {
  SlackAttachment,
  SlackBlock,
  SlackMessage,
  SlackPayloadInput,
  SlackTextObject,
} from './slack.js';

// Console summary
export { renderConsoleSummary } from './console.js';
export type { ConsoleSummaryInput } from './console.js';

// Release gate
export { computeReleaseGate } from './verdict.js';
export type { ReleaseGateOptions } from './verdict.js';
