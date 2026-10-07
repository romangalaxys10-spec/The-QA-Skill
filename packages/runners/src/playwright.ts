import type { TestEvent } from '@the-qa-skill/core';
import { listFiles, matchAny } from '@the-qa-skill/core';
import { buildEvent, extractJsonObject, freshRunId, hasPackageDep } from './runner.js';
import type { BuildCommandOptions, PlannedCommand, RunnerContext } from './types.js';
import type { Runner } from './runner.js';

/**
 * Playwright adapter (`@playwright/test`).
 *
 * Detection: `@playwright/test` or `playwright` in package.json dependencies,
 * or any `playwright.config.*` file in the project.
 * Command: `npx playwright test --reporter=json` (+ `--retries=<n>` when the
 * context allows retries) — stdout carries the JSON reporter payload.
 */
export class PlaywrightRunner implements Runner {
  readonly id = 'playwright';
  readonly framework = 'playwright';

  detect(root: string): boolean {
    if (hasPackageDep(root, ['@playwright/test', 'playwright'])) return true;
    try {
      const files = listFiles(root, { maxFiles: 5000 });
      return files.some((f) => matchAny(f, ['playwright.config.{ts,mts,cts,js,mjs,cjs}']));
    } catch {
      return false;
    }
  }

  buildCommand(ctx: RunnerContext, _opts?: BuildCommandOptions): PlannedCommand {
    const args = ['playwright', 'test', '--reporter=json'];
    if (ctx.maxRetries > 0) args.push(`--retries=${ctx.maxRetries}`);
    return { command: 'npx', args, reporterHint: 'json' };
  }

  parseOutput(raw: string, ctx: RunnerContext): TestEvent[] {
    const parsed = extractJsonObject(raw) as PlaywrightReport | null;
    if (!parsed) return [];
    const runId = freshRunId();
    const events: TestEvent[] = [];

    const walkSuites = (suites: PlaywrightSuite[] | undefined, inheritedFile: string | undefined): void => {
      if (!suites) return;
      for (const suite of suites) {
        const file = suite.file ?? inheritedFile ?? 'unknown.spec.ts';
        walkSuites(suite.suites, file);
        for (const spec of suite.specs ?? []) {
          const specFile = spec.file ?? file;
          // Canonical shape: specs[].tests[].results[] — one entry per attempt.
          const resultList = spec.tests?.[0]?.results ?? [];
          resultList.forEach((result, attemptIndex) => {
            const status = mapPlaywrightStatus(result.status);
            const err = result.error ?? result.errors?.[0];
            events.push(
              buildEvent({
                runId,
                ctx,
                framework: this.framework,
                filePath: specFile,
                name: spec.title ?? '(unnamed spec)',
                status,
                durationMs: result.duration ?? 0,
                attemptIndex,
                errorType: err?.message?.split('\n')[0]?.split(':')[0]?.trim() || undefined,
                errorMessage: err?.message,
                errorStack: err?.stack ?? err?.message,
              }),
            );
          });
        }
      }
    };

    walkSuites(parsed.suites, undefined);

    // Suite-level failures (e.g. a project-level error before any test ran):
    // emit one synthetic event so the failure is visible in reports —
    // silently dropping it would fake a green run.
    if (Array.isArray(parsed.errors)) {
      for (const error of parsed.errors) {
        const message = typeof error === 'string' ? error : (error.message ?? '');
        if (message.trim().length === 0) continue;
        events.push(
          buildEvent({
            runId,
            ctx,
            framework: this.framework,
            filePath: '__suite__',
            name: 'Playwright suite error (synthetic)',
            status: 'failed',
            durationMs: 0,
            errorMessage: message,
            errorStack: typeof error === 'object' ? (error.stack ?? message) : message,
          }),
        );
      }
    }

    return events;
  }
}

function mapPlaywrightStatus(status: string | undefined): 'passed' | 'failed' | 'skipped' | 'timedout' | 'not_run' {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'unexpected':
      return 'failed';
    case 'timedOut':
      return 'timedout';
    case 'skipped':
      return 'skipped';
    case 'interrupted':
      // Interrupted = killed before reaching a terminal state — honestly
      // "not run", never faked as a pass or a failure.
      return 'skipped';
    default:
      return 'skipped';
  }
}

interface PlaywrightError {
  message?: string;
  stack?: string;
}

interface PlaywrightResult {
  status?: string;
  duration?: number;
  error?: PlaywrightError;
  errors?: PlaywrightError[];
}

interface PlaywrightTest {
  results?: PlaywrightResult[];
}

interface PlaywrightSpec {
  title?: string;
  file?: string;
  tests?: PlaywrightTest[];
}

interface PlaywrightSuite {
  title?: string;
  file?: string;
  suites?: PlaywrightSuite[];
  specs?: PlaywrightSpec[];
}

interface PlaywrightReport {
  suites?: PlaywrightSuite[];
  errors?: Array<string | PlaywrightError>;
}
