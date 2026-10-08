#!/usr/bin/env node
/**
 * @the-qa-skill/cli — the The-QA-Skill command line: 21 commands over the
 * deterministic QA core and the 8 specialized agents.
 *
 *   init · discover · plan · risk · impact · generate · review · test ·
 *   triage · heal · flake · coverage · release · report · doctor · explain ·
 *   verify · matrix · audit-rules · tokens · route
 *
 * Every command supports --json (a single machine envelope on stdout:
 * { schemaVersion, command, ok, data, label }), --quiet, --verbose, and
 * --dry-run where the command writes. Exit codes: 0 success/no findings,
 * 1 findings (failures, BLOCKED gate, doctor FAIL), 2 usage/runtime errors.
 *
 * The-QA-Skill: sponsored by xShredo.dev → https://xshredo.com/promo/anytest
 */
import { ConfigError, createLogger } from '@the-qa-skill/core';
import { CliProgram, UsageError } from './args.js';
import type { ParsedArgs } from './args.js';
import type { CommandContext, CommandIO, CommandResult } from './shared.js';
import { defaultIO, EXIT_ERROR, EXIT_FINDINGS, EXIT_OK } from './shared.js';
import { initCommand } from './commands/init.js';
import { discoverCommand } from './commands/discover.js';
import { planCommand } from './commands/plan.js';
import { riskCommand } from './commands/risk.js';
import { impactCommand } from './commands/impact.js';
import { generateCommand } from './commands/generate.js';
import { reviewCommand } from './commands/review.js';
import { testCommand } from './commands/test.js';
import { triageCommand } from './commands/triage.js';
import { healCommand } from './commands/heal.js';
import { flakeCommand } from './commands/flake.js';
import { coverageCommand } from './commands/coverage.js';
import { releaseCommand } from './commands/release.js';
import { reportCommand } from './commands/report.js';
import { doctorCommand } from './commands/doctor.js';
import { explainCommand } from './commands/explain.js';
import { verifyCommand } from './commands/verify.js';
import { matrixCommand } from './commands/matrix.js';
import { auditRulesCommand } from './commands/audit-rules.js';
import { tokensCommand } from './commands/tokens.js';
import { routeCommand } from './commands/route.js';

export const PROGRAM_NAME = 'qa';
export const CLI_VERSION = '0.1.0';

export { CliProgram, UsageError } from './args.js';
export type { CommandSpec, FlagSpec, ParsedArgs } from './args.js';
export type { CommandContext, CommandIO, CommandResult } from './shared.js';
export { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK } from './shared.js';

/** Build the full 16-command program. */
export function createProgram(): CliProgram {
  const program = new CliProgram();
  program.register(initCommand);
  program.register(discoverCommand);
  program.register(planCommand);
  program.register(riskCommand);
  program.register(impactCommand);
  program.register(generateCommand);
  program.register(reviewCommand);
  program.register(testCommand);
  program.register(triageCommand);
  program.register(healCommand);
  program.register(flakeCommand);
  program.register(coverageCommand);
  program.register(releaseCommand);
  program.register(reportCommand);
  program.register(doctorCommand);
  program.register(explainCommand);
  program.register(verifyCommand);
  program.register(matrixCommand);
  program.register(auditRulesCommand);
  program.register(tokensCommand);
  program.register(routeCommand);
  return program;
}

interface Envelope {
  schemaVersion: 1;
  command: string | null;
  ok: boolean;
  data: unknown;
  label: string;
}

function emitError(io: CommandIO, json: boolean, command: string | undefined, message: string, hint?: string): void {
  if (json) {
    const envelope: Envelope = {
      schemaVersion: 1,
      command: command ?? null,
      ok: false,
      data: { error: message, ...(hint !== undefined ? { hint } : {}) },
      label: 'NOT_VERIFIED',
    };
    io.stdout.write(JSON.stringify(envelope) + '\n');
    return;
  }
  io.stderr.write(`error: ${message}\n`);
  if (hint !== undefined) io.stderr.write(`hint: ${hint}\n`);
}

/**
 * Run one CLI invocation and return the exit code (never process.exit — the
 * caller owns the exit, so pending stdout writes are not killed mid-flight).
 */
export async function runCommand(argv: string[], opts: { io?: Partial<CommandIO> } = {}): Promise<number> {
  const io: CommandIO = {
    stdout: opts.io?.stdout ?? process.stdout,
    stderr: opts.io?.stderr ?? process.stderr,
  };
  const program = createProgram();

  let parsed: ParsedArgs;
  try {
    parsed = program.parse(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      emitError(io, argv.includes('--json'), undefined, e.message, e.hint);
      return EXIT_ERROR;
    }
    emitError(io, argv.includes('--json'), undefined, (e as Error).message);
    return EXIT_ERROR;
  }

  const command = parsed.command;
  const json = parsed.flags['json'] === true;

  // Global flags are honored even without a command token: `qa --version` and
  // `qa --help` are informational invocations, not usage errors. A bare
  // invocation (no command, no global flags) prints usage with exit 2.
  if (parsed.flags['version'] === true) {
    io.stdout.write(`${CLI_VERSION}\n`);
    return EXIT_OK;
  }
  if (parsed.flags['help'] === true) {
    const spec = command !== undefined ? program.get(command) : undefined;
    io.stdout.write(spec !== undefined ? program.commandHelp(spec) : program.usageText(PROGRAM_NAME));
    return EXIT_OK;
  }

  if (command === undefined) {
    io.stdout.write(program.usageText(PROGRAM_NAME));
    return EXIT_ERROR;
  }

  const spec = program.get(command);
  if (spec === undefined) {
    emitError(io, json, command, `unknown command "${command}"`, `available: ${program.commands().map((c) => c.name).join(', ')}`);
    return EXIT_ERROR;
  }

  const ctx: CommandContext = {
    cwd: process.cwd(),
    positionals: parsed.positionals,
    flags: parsed.flags,
    parsed,
    logger: createLogger({
      json,
      quiet: parsed.flags['quiet'] === true,
      verbose: parsed.flags['verbose'] === true,
    }),
    io,
    json,
    quiet: parsed.flags['quiet'] === true,
    verbose: parsed.flags['verbose'] === true,
    dryRun: parsed.flags['dry-run'] === true,
  };

  let result: CommandResult;
  try {
    result = await spec.run(ctx);
  } catch (e) {
    if (e instanceof UsageError) {
      emitError(io, json, command, e.message, e.hint);
      return EXIT_ERROR;
    }
    if (e instanceof ConfigError) {
      emitError(io, json, command, e.message, 'fix the listed issues or re-run `qa init --force`');
      return EXIT_ERROR;
    }
    const err = e instanceof Error ? e : new Error(String(e));
    if (ctx.verbose && err.stack !== undefined) ctx.logger.debug(err.stack);
    emitError(io, json, command, err.message);
    return EXIT_ERROR;
  }

  if (json) {
    const envelope: Envelope = {
      schemaVersion: 1,
      command,
      ok: result.ok,
      data: result.data,
      label: result.label,
    };
    io.stdout.write(JSON.stringify(envelope) + '\n');
  }
  return result.exitCode ?? (result.ok ? EXIT_OK : EXIT_FINDINGS);
}

/* istanbul ignore next */
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void runCommand(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
