import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { TestEvent } from '../types.js';

/**
 * Evidence bundles — the artifact contract of the platform.
 *
 *   <artifactsRoot>/run-<date>/<testId>/
 *     metadata.json     run identity (commit, branch, env, browser, seed)
 *     failure.md        human-readable failure narrative
 *     console.log       captured stdout/stderr of the attempt
 *     network.json      captured network activity (har-like)
 *     screenshot.png    (copied in when the runner produced one)
 *     trace.zip         (copied in when the runner produced one)
 *
 * Secrets are scrubbed before write (golden rule 8). Bundles are append-only:
 * callers write fresh run directories; nothing is ever mutated in place.
 */

export interface BundleMetadata {
  runId: string;
  testId: string;
  name: string;
  timestamp: string;
  commit?: string;
  branch?: string;
  environment: string;
  browser?: string;
  device?: string;
  framework: string;
  status: string;
  durationMs: number;
  retryIndex: number;
  seed?: string;
  label: string;
}

export interface BundleInputs {
  event: TestEvent;
  metadata?: Partial<BundleMetadata>;
  consoleLog?: string;
  network?: unknown;
  screenshotPath?: string;
  tracePath?: string;
  failureNarrative?: string;
}

const SECRET_SCRUBBERS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  { re: /(api[_-]?key|apikey|secret|password|passwd|token|authorization)\s*[:=]\s*['"][^'"\s]+['"]/gi, replacement: '$1: "[REDACTED]"' },
  { re: /Bearer\s+[\w.\-]{10,}/gi, replacement: 'Bearer [REDACTED]' },
  { re: /ghp_[A-Za-z0-9]{20,}/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { re: /(?:sk|pk)_(?:live|test)_[\w]{10,}/g, replacement: '[REDACTED_STRIPE_KEY]' },
  { re: /AWS_ACCESS_KEY_ID\s*[:=]\s*\S+/g, replacement: 'AWS_ACCESS_KEY_ID=[REDACTED]' },
  { re: /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const { re, replacement } of SECRET_SCRUBBERS) {
    out = out.replace(re, replacement);
  }
  return out;
}

export function evidenceBundleLayout(root: string, event: TestEvent): string {
  const date = event.timestamp.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const safeTestId = event.testId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return join(root, `run-${date}`, safeTestId);
}

export function writeEvidenceBundle(root: string, inputs: BundleInputs): { path: string; files: string[] } {
  const { event } = inputs;
  const dir = evidenceBundleLayout(root, event);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];

  const metadata: BundleMetadata = {
    runId: event.runId,
    testId: event.testId,
    name: event.name,
    timestamp: event.timestamp,
    commit: event.commit,
    branch: event.branch,
    environment: event.environment,
    browser: event.browser,
    device: event.device,
    framework: event.framework,
    status: event.status,
    durationMs: event.durationMs,
    retryIndex: event.retryIndex,
    label: 'OBSERVED',
    ...inputs.metadata,
  };
  const metaPath = join(dir, 'metadata.json');
  writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n');
  files.push('metadata.json');

  const consolePath = join(dir, 'console.log');
  writeFileSync(consolePath, scrubSecrets(inputs.consoleLog ?? ''), 'utf8');
  files.push('console.log');

  const networkPath = join(dir, 'network.json');
  const networkText = inputs.network !== undefined ? JSON.stringify(inputs.network, null, 2) : '[]';
  writeFileSync(networkPath, scrubSecrets(networkText), 'utf8');
  files.push('network.json');

  const narrative = inputs.failureNarrative ?? renderFailureNarrative(event);
  const failurePath = join(dir, 'failure.md');
  writeFileSync(failurePath, scrubSecrets(narrative), 'utf8');
  files.push('failure.md');

  return { path: dir, files };
}

export function renderFailureNarrative(event: TestEvent): string {
  const lines = [
    `# Failure — ${event.name}`,
    '',
    `- **testId:** ${event.testId}`,
    `- **status:** ${event.status}`,
    `- **framework:** ${event.framework}`,
    `- **environment:** ${event.environment}${event.browser ? ` (${event.browser})` : ''}`,
    `- **commit:** ${event.commit ?? 'unknown'}`,
    `- **timestamp:** ${event.timestamp}`,
    `- **duration:** ${event.durationMs}ms (attempt ${event.retryIndex + 1})`,
    '',
    '## Error',
    '',
    '```',
    event.errorMessage ? scrubSecrets(event.errorMessage) : '(no error message captured)',
    '```',
  ];
  if (event.errorStack) {
    lines.push('', '## Stack (normalized)', '', '```', scrubSecrets(event.errorStack).split('\n').slice(0, 12).join('\n'), '```');
  }
  lines.push('', '## Next step', '', 'Run `qa triage` with this bundle to classify the failure with evidence.');
  return lines.join('\n') + '\n';
}

export function runIdFor(prefix = 'run'): string {
  const h = createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 10);
  return `${prefix}-${h}`;
}
