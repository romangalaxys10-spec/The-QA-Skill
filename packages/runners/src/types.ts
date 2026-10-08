import type { OrchestrationPolicyName } from '@the-qa-skill/core';

/**
 * The execution context handed to every runner adapter.
 * It is produced by the orchestrator (CLI / MCP server) and describes WHERE and
 * HOW tests should run — never what to run (that is the selection's job).
 */
export interface RunnerContext {
  /** Absolute filesystem root of the project under test. */
  root: string;
  /** Logical environment name (e.g. 'ci', 'local', 'staging'). */
  environment: string;
  /** Optional browser identity for UI runners (e.g. 'chromium'). */
  browser?: string;
  /** Orchestration policy driving this run — decides aggressiveness upstream. */
  policy: OrchestrationPolicyName;
  /** Max retries allowed per test for flake diagnostics (never to hide regressions). */
  maxRetries: number;
  /** Commit under test when known. */
  commit?: string;
  /** Branch under test when known. */
  branch?: string;
  /** True when this is a dry run: plan commands, execute nothing. */
  dryRun: boolean;
}

/** A command planned (or executed) by a runner adapter. */
export interface PlannedCommand {
  /** Executable, resolved without a shell (e.g. 'npx', 'python', 'k6'). */
  command: string;
  /** Argument vector — shell-free by design (golden rule: no shell injection). */
  args: string[];
  /** Human hint about which reporter format the runner emits. */
  reporterHint: string;
}

/** Extra per-runner options accepted by buildCommand implementations. */
export interface BuildCommandOptions {
  /**
   * Directory where runners drop machine-readable artifacts (JUnit XML,
   * k6 summary JSON). Defaults to `<root>/.theqa/artifacts` when omitted.
   */
  artifactsDir?: string;
  /**
   * Runner-specific entrypoint (e.g. the k6 script to execute). When omitted,
   * adapters make a deterministic best-effort choice from the project tree.
   */
  script?: string;
}
