import type { CommandContext, CommandResult } from './shared.js';

/**
 * Hand-rolled argument parser — the CLI has zero runtime dependencies beyond
 * the workspace packages (commander is not present in this workspace's
 * node_modules, and installing is not an option here). The parser is small,
 * deterministic, and fully tested:
 *
 *   - first non-flag token is the command name;
 *   - `--flag value` and `--flag=value` both work for value flags;
 *   - `--flag` alone is a boolean flag;
 *   - `--` terminates flags (everything after is positional);
 *   - short flags (`-x`) are rejected with a pointing hint;
 *   - unknown flags are rejected per-command after the command resolves.
 */

/** A usage-level error → exit code 2, with an optional actionable hint. */
export class UsageError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface ParsedArgs {
  /** Resolved command name, or undefined when no command token was given. */
  command: string | undefined;
  /** Positional arguments after the command name. */
  positionals: string[];
  /** Flag map: boolean flags map to `true`, value flags to their string value. */
  flags: Record<string, string | boolean>;
}

/** A flag accepted by a command. `value: true` means `--flag <value>` is required. */
export interface FlagSpec {
  name: string;
  value: boolean;
  description: string;
}

export interface CommandSpec {
  name: string;
  summary: string;
  /** Full usage line, e.g. `qa init [dir] [--force] [--dry-run]`. */
  usage: string;
  /** Documented positional slots (display + doc only; parsing is positional-agnostic). */
  positionals: string[];
  flags: FlagSpec[];
  run: (ctx: CommandContext) => Promise<CommandResult>;
}

/** Global boolean flags every command accepts. */
export const GLOBAL_BOOLEAN_FLAGS: readonly string[] = ['json', 'quiet', 'verbose', 'dry-run', 'help', 'version'];

/** Flags that take a value. Boolean flags elsewhere are implicit `true`. */
const VALUE_FLAG_DEFAULTS: ReadonlySet<string> = new Set([
  'range', 'policy', 'suite', 'spec', 'out', 'evidence', 'history', 'audience', 'format',
]);

interface RawParse {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Tokenize argv. Value-flag resolution needs the command's flag table, so the
 * CliProgram owns this walk (see `CliProgram.parse`); this helper is the pure
 * syntactic core used by it once the command is known.
 */
function tokenize(argv: string[], valueFlags: ReadonlySet<string>): RawParse {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (onlyPositionals) {
      positionals.push(tok);
      continue;
    }
    if (tok === '--') {
      onlyPositionals = true;
      continue;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq > 2) {
        const name = tok.slice(2, eq);
        if (!name) throw new UsageError(`malformed flag "${tok}"`);
        flags[name] = tok.slice(eq + 1);
      } else {
        const name = tok.slice(2);
        if (!name) throw new UsageError('empty flag name (bare "--")');
        if (valueFlags.has(name)) {
          const next = argv[i + 1];
          if (next === undefined || next.startsWith('--')) {
            throw new UsageError(`flag --${name} requires a value`, `use --${name} <value> or --${name}=<value>`);
          }
          flags[name] = next;
          i += 1;
        } else {
          flags[name] = true;
        }
      }
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1) {
      throw new UsageError(
        `short flags are not supported: "${tok}" — use long flags (e.g. --json, --dry-run)`,
        'use long flags, e.g. --json, --dry-run',
      );
    }
    if (command === undefined) {
      command = tok;
    } else {
      positionals.push(tok);
    }
  }
  return { command, positionals, flags };
}

/**
 * Syntactic-only tokenization against the default value-flag set (no command
 * registry) — exposed for direct parser tests.
 */
export function parseArgsSemantics(argv: string[]): ParsedArgs {
  const raw = tokenize(argv, VALUE_FLAG_DEFAULTS);
  return { command: raw.command, positionals: raw.positionals, flags: raw.flags };
}

/** One-line CLI toolkit: registry + parser + usage renderer. */
export class CliProgram {
  private readonly specs = new Map<string, CommandSpec>();

  register(spec: CommandSpec): this {
    if (this.specs.has(spec.name)) {
      throw new Error(`command "${spec.name}" registered twice`);
    }
    this.specs.set(spec.name, spec);
    return this;
  }

  get(name: string): CommandSpec | undefined {
    return this.specs.get(name);
  }

  commands(): CommandSpec[] {
    return [...this.specs.values()];
  }

  /**
   * Parse and validate argv against the registered commands. Throws
   * UsageError for unknown commands, unknown flags, and boolean flags given
   * values. Value-flag consumption switches on once the command name is seen
   * (global flags are all boolean, so flags before the command are safe).
   */
  parse(argv: string[]): ParsedArgs {
    // Pre-seed value flags from any command token that appears anywhere in the
    // first positional slot; walking needs them, so do a cheap pre-scan.
    let commandName: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      const tok = argv[i] ?? '';
      if (tok === '--') break;
      if (tok.startsWith('-')) continue;
      commandName = tok;
      break;
    }

    const valueFlags = new Set(VALUE_FLAG_DEFAULTS);
    if (commandName !== undefined) {
      const spec = this.specs.get(commandName);
      if (spec) {
        for (const f of spec.flags) {
          if (f.value) valueFlags.add(f.name);
        }
      }
    }

    const raw = tokenize(argv, valueFlags);

    if (raw.command !== undefined && !this.specs.has(raw.command)) {
      throw new UsageError(
        `unknown command "${raw.command}"`,
        `available commands: ${this.specs.size > 0 ? [...this.specs.keys()].join(', ') : '(none registered)'}`,
      );
    }

    const spec = raw.command !== undefined ? this.specs.get(raw.command) : undefined;
    const allowed = new Set<string>(GLOBAL_BOOLEAN_FLAGS);
    if (spec) {
      for (const f of spec.flags) allowed.add(f.name);
    }
    for (const [name, value] of Object.entries(raw.flags)) {
      if (!allowed.has(name)) {
        throw new UsageError(
          `unknown flag --${name}${spec ? ` for command "${spec.name}"` : ''}`,
          spec ? `usage: ${spec.usage}` : undefined,
        );
      }
      if (typeof value === 'string') {
        const takesValue = spec?.flags.some((f) => f.name === name && f.value) ||
          (spec === undefined && VALUE_FLAG_DEFAULTS.has(name));
        if (!takesValue) {
          throw new UsageError(
            `boolean flag --${name} does not take a value`,
            `drop "=${value}" and use --${name} alone`,
          );
        }
        if (value.length === 0) {
          throw new UsageError(`flag --${name} requires a non-empty value`);
        }
      }
    }

    return { command: raw.command, positionals: raw.positionals, flags: raw.flags };
  }

  /** Top-level usage text (command list). */
  usageText(programName: string): string {
    const lines: string[] = [];
    lines.push(`${programName} — the AI-native QA operating system for coding agents`);
    lines.push('');
    lines.push('Usage: qa <command> [options]');
    lines.push('');
    lines.push('Commands:');
    for (const spec of this.commands()) {
      lines.push(`  ${spec.name.padEnd(10)} ${spec.summary}`);
    }
    lines.push('');
    lines.push('Global flags: --json (machine output) · --quiet · --verbose · --dry-run · --help');
    lines.push('Run `qa <command> --help` for per-command options.');
    return lines.join('\n') + '\n';
  }

  /** Per-command help text. */
  commandHelp(spec: CommandSpec): string {
    const lines: string[] = [];
    lines.push(`${spec.name} — ${spec.summary}`);
    lines.push('');
    lines.push(`Usage: ${spec.usage}`);
    if (spec.positionals.length > 0) {
      lines.push('');
      lines.push(`Positionals: ${spec.positionals.join(', ')}`);
    }
    if (spec.flags.length > 0) {
      lines.push('');
      lines.push('Flags:');
      for (const f of spec.flags) {
        const form = f.value ? `--${f.name} <value>` : `--${f.name}`;
        lines.push(`  ${form.padEnd(22)} ${f.description}`);
      }
    }
    lines.push('');
    lines.push('Every command also accepts: --json --quiet --verbose --dry-run --help');
    return lines.join('\n') + '\n';
  }
}
