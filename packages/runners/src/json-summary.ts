import type { TestEvent } from '@the-qa-skill/core';
import { listFiles, matchAny } from '@the-qa-skill/core';
import { buildEvent, extractJsonObject, freshRunId, hasPackageDep, mapStatus } from './runner.js';
import type { Runner, BuildCommandOptions, PlannedCommand } from './runner.js';
import type { RunnerContext } from './types.js';

/**
 * Shared base for runners that emit a jest-style JSON summary on stdout:
 *
 *   { numTotalTests, testResults: [ { name?, status?, message?,
 *       assertionResults: [ { fullName, title, status, duration,
 *                                failureMessages: [], location? } ] } ] }
 *
 * Vitest's `--reporter=json` and Jest's `--json` both produce this dialect, so
 * the mapping lives here once and the concrete classes only differ in
 * detection markers and command construction.
 */
export abstract class JsonSummaryRunner implements Runner {
  abstract readonly id: string;
  abstract readonly framework: string;

  /** Config-file globs that prove this framework is configured. */
  protected abstract readonly configPatterns: string[];
  /** package.json dependency names that prove this framework is installed. */
  protected abstract readonly depNames: string[];
  /** Command vector used with `npx`. */
  protected abstract readonly commandArgs: string[];

  detect(root: string): boolean {
    if (hasPackageDep(root, this.depNames)) return true;
    try {
      const files = listFiles(root, { maxFiles: 5000 });
      return files.some((f) => matchAny(f, this.configPatterns));
    } catch {
      return false;
    }
  }

  buildCommand(ctx: RunnerContext, _opts?: BuildCommandOptions): PlannedCommand {
    return { command: 'npx', args: [...this.commandArgs], reporterHint: 'json' };
  }

  parseOutput(raw: string, ctx: RunnerContext): TestEvent[] {
    const report = extractJsonObject(raw) as JsonSummaryReport | null;
    if (!report || !Array.isArray(report.testResults)) return [];
    const runId = freshRunId();
    const events: TestEvent[] = [];

    for (const tr of report.testResults) {
      const filePath = normalizePath(tr.name ?? tr.testFilePath ?? '', ctx.root);
      for (const ar of tr.assertionResults ?? []) {
        const name = ar.fullName?.trim() || ar.title?.trim() || '(unnamed test)';
        const failure = ar.failureMessages?.join('\n\n').trim() ?? '';
        events.push(
          buildEvent({
            runId,
            ctx,
            framework: this.framework,
            filePath: filePath.length > 0 ? filePath : this.framework,
            name,
            status: mapStatus(ar.status ?? 'skipped'),
            durationMs: ar.duration ?? 0,
            errorType: errorTypeFromMessage(failure),
            errorMessage: failure.length > 0 ? failure.split('\n')[0] : undefined,
            errorStack: failure.length > 0 ? failure : undefined,
          }),
        );
      }
    }
    return events;
  }
}

/**
 * Normalize an absolute (or already-relative) path against the project root so
 * test ids are stable across machines and CI checkouts.
 */
function normalizePath(p: string, root: string): string {
  const posix = p.replace(/\\/g, '/').trim();
  if (posix.length === 0) return '';
  const rootPosix = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (rootPosix.length > 0 && posix.startsWith(rootPosix + '/')) {
    return posix.slice(rootPosix.length + 1);
  }
  return posix;
}

/** Best-effort error class extraction from the first line of a failure message. */
export function errorTypeFromMessage(message: string): string | undefined {
  if (message.length === 0) return undefined;
  const first = message.split('\n')[0] ?? '';
  const m = /^\s*([A-Z][A-Za-z0-9_]*(?:Error|Exception))\s*[:\s]/.exec(first);
  return m?.[1];
}

interface JsonAssertionResult {
  fullName?: string;
  title?: string;
  status?: string;
  duration?: number;
  failureMessages?: string[];
}

interface JsonTestResult {
  name?: string;
  testFilePath?: string;
  status?: string;
  message?: string;
  assertionResults?: JsonAssertionResult[];
}

interface JsonSummaryReport {
  testResults?: JsonTestResult[];
}
