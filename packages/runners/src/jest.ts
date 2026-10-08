import { JsonSummaryRunner } from './json-summary.js';
import type { BuildCommandOptions, PlannedCommand } from './runner.js';
import type { RunnerContext } from './types.js';

/**
 * Jest adapter.
 *
 * Detection: `jest.config.*` (incl. `jest.config.json`) or the `jest` dependency.
 * Command: `npx jest --json` — stdout carries the jest JSON summary.
 *
 * Retries are deliberately NOT injected here: Jest's retry mechanics are
 * configuration-owned (`jest.retryTimes`) and differ across major versions, so
 * the adapter never guesses at flags it cannot verify. The context's
 * `maxRetries` is surfaced to the orchestrator through RetryManager instead.
 */
export class JestRunner extends JsonSummaryRunner {
  readonly id = 'jest';
  readonly framework = 'jest';
  protected override readonly configPatterns = [
    'jest.config.{ts,mts,cts,js,mjs,cjs,json}',
    '**/jest.config.{ts,mts,cts,js,mjs,cjs,json}',
  ];
  protected override readonly depNames = ['jest'];
  protected override readonly commandArgs = ['jest', '--json'];

  override buildCommand(_ctx: RunnerContext, _opts?: BuildCommandOptions): PlannedCommand {
    return { command: 'npx', args: [...this.commandArgs], reporterHint: 'json' };
  }
}
