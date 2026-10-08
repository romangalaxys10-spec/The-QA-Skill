import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { compressText, type DtocKind } from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import { EXIT_OK, flagString, ok } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa tokens — Dynamic Tool Output Compression (read-only).
 *
 *   qa tokens --type logs --file build.log
 *   qa tokens --type diff --file change.patch --out compressed.patch
 *
 * Applies the documented DTOC caps (ls 20 · logs 30 · diff 100 · config 80 ·
 * search 40) with a visible truncation marker, and reports the estimated
 * token savings (chars/4 heuristic, same as the router). Nothing is ever
 * truncated silently.
 */

const KINDS: ReadonlySet<string> = new Set(['ls', 'logs', 'diff', 'config', 'search']);

async function run(ctx: CommandContext): Promise<CommandResult> {
  const kind = flagString(ctx, 'type');
  if (kind === undefined || !KINDS.has(kind)) {
    throw new Error(`--type is required (one of: ${[...KINDS].join(', ')})`);
  }
  const file = flagString(ctx, 'file') ?? ctx.positionals[0];
  if (file === undefined) {
    throw new Error('an input file is required: --file <path> or a positional path');
  }
  const path = resolve(file);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`input file not found: ${file}`);
  }
  const text = readFileSync(path, 'utf8');
  const result = compressText(kind as DtocKind, text);

  const out = flagString(ctx, 'out');
  if (out !== undefined && !ctx.dryRun) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const outPath = resolve(out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, result.text, 'utf8');
  }

  const data = {
    kind: result.kind,
    originalLines: result.originalLines,
    keptLines: result.keptLines,
    truncated: result.truncated,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
    tokensSaved: result.tokensBefore - result.tokensAfter,
    out: out ?? null,
    text: result.text,
  };

  if (ctx.json) {
    return ok(data, 'OBSERVED', EXIT_OK);
  }

  ctx.logger.banner('tokens');
  ctx.logger.info(`DTOC ${result.kind}: ${result.originalLines} lines → ${result.keptLines} kept (cap applied: ${result.truncated ? 'yes' : 'no'})`);
  ctx.logger.info(`tokens ≈ ${result.tokensBefore} → ${result.tokensAfter} (saved ${result.tokensBefore - result.tokensAfter})`);
  if (out !== undefined) ctx.logger.info(ctx.dryRun ? `dry-run: would write ${out}` : `written: ${out}`);
  return ok(data, 'OBSERVED', EXIT_OK);
}

export const tokensCommand: CommandSpec = {
  name: 'tokens',
  summary: 'apply DTOC output-compression caps with visible truncation markers and token-savings estimates (read-only)',
  usage: 'qa tokens --type <ls|logs|diff|config|search> <file> [--out <file>] [--json]',
  positionals: ['file'],
  flags: [
    { name: 'type', value: true, description: 'Output kind determining the cap' },
    { name: 'file', value: true, description: 'Input file (a positional path also works)' },
    { name: 'out', value: true, description: 'Write compressed output to this file' },
  ],
  run,
};
