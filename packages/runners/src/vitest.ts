import { JsonSummaryRunner } from './json-summary.js';
import type { BuildCommandOptions, PlannedCommand } from './runner.js';
import type { RunnerContext } from './types.js';

/**
 * Vitest adapter.
 *
 * Detection: `vitest.config.*` (or `vite.config.*`) or the `vitest` dependency.
 * Command: `npx vitest run --reporter=json` — stdout carries a jest-style JSON
 * summary. When the context allows retries, `--retry=<n>` is added so Vitest
 * itself performs the flake-diagnostic retries; the reporter reports each
 * attempt's terminal outcome.
 */
export class VitestRunner extends JsonSummaryRunner {
  readonly id = 'vitest';
  readonly framework = 'vitest';
  protected override readonly configPatterns = [
    'vitest.config.{ts,mts,cts,js,mjs,cjs}',
    'vite.config.{ts,mts,js,mjs}',
    '**/vitest.config.{ts,mts,cts,js,mjs,cjs}',
  ];
  protected override readonly depNames = ['vitest'];
  protected override readonly commandArgs = ['vitest', 'run', '--reporter=json'];

  override buildCommand(ctx: RunnerContext, _opts?: BuildCommandOptions): PlannedCommand {
    const args = [...this.commandArgs];
    if (ctx.maxRetries > 0) args.push(`--retry=${ctx.maxRetries}`);
    return { command: 'npx', args, reporterHint: 'json' };
  }
}
