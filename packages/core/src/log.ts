export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  /** Suppress all non-error output (for --quiet). */
  quiet?: boolean;
  /** Show debug lines (for --verbose). */
  verbose?: boolean;
  /** JSON mode: emit nothing to stdout (stdout is reserved for the JSON payload). */
  json?: boolean;
  /** Prefix for human-readable lines. */
  prefix?: string;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  /** Section headers in human mode; no-op in JSON mode. */
  banner(title: string): void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const tag = opts.prefix ? `[${opts.prefix}] ` : '';
  const fmt = (level: Exclude<LogLevel, 'debug'>, msg: string): string => `${tag}${msg}`;

  return {
    debug(msg) {
      if (opts.verbose && !opts.json) process.stderr.write(`  · ${fmt('info', msg)}\n`);
    },
    info(msg) {
      if (!opts.quiet && !opts.json) process.stdout.write(`${fmt('info', msg)}\n`);
    },
    warn(msg) {
      if (!opts.json) process.stderr.write(`${fmt('warn', `warning: ${msg}`)}\n`);
    },
    error(msg) {
      process.stderr.write(`${fmt('error', `error: ${msg}`)}\n`);
    },
    banner(title) {
      if (!opts.quiet && !opts.json) {
        process.stdout.write(`\n${'='.repeat(72)}\n  ${title}\n${'='.repeat(72)}\n`);
      }
    },
  };
}
