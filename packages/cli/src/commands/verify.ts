import { join } from 'node:path';
import {
  KnownFalseRegistry,
  verifyClaimAsync,
  type ProbeSpec,
} from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import { EXIT_FINDINGS, EXIT_OK, flagBool, flagString, ok, rootFrom } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';

/**
 * qa verify — ground-truth claim verification (read-only probes).
 *
 *   qa verify --claim "package.json exists" --check file_exists:package.json
 *   qa verify --claim "config is valid JSON" --check json_valid:theqa.config.json --repeat
 *
 * Probe syntax (--check, repeatable): `kind:arg[:extra]`
 *   file_exists:<path> · dir_exists:<path> · json_valid:<path>
 *   file_contains:<path>:<pattern> · file_not_contains:<path>:<pattern>
 *   cmd_exit_zero:<command …> · git_ref_exists:<ref> · http_status:<url>
 *
 * Semantics: every probe must pass → VERIFIED (CONFIRMED with --repeat when
 * both runs agree). Any clean probe failure → REFUTED and the claim is
 * recorded in the KNOWN_FALSE registry (.theqa/known-false.json), which bans
 * silent retries of the identical claim. Probe errors → UNKNOWN, never false.
 * Exit codes: 0 VERIFIED · 1 REFUTED/UNKNOWN · 2 usage error.
 */

const PROBE_KINDS = new Set([
  'file_exists', 'dir_exists', 'file_contains', 'file_not_contains',
  'json_valid', 'cmd_exit_zero', 'git_ref_exists', 'http_status',
]);

export function parseCheckSpec(spec: string): ProbeSpec {
  const idx = spec.indexOf(':');
  if (idx <= 0) throw new Error(`bad --check "${spec}" — expected kind:arg[:extra]`);
  const kind = spec.slice(0, idx);
  const rest = spec.slice(idx + 1);
  if (!PROBE_KINDS.has(kind)) {
    throw new Error(`unknown probe kind "${kind}" — known: ${[...PROBE_KINDS].join(', ')}`);
  }
  switch (kind) {
    case 'file_exists':
    case 'dir_exists':
    case 'json_valid':
      return { kind, path: rest } as ProbeSpec;
    case 'file_contains':
    case 'file_not_contains': {
      const second = rest.indexOf(':');
      if (second < 0) throw new Error(`--check ${kind} needs <path>:<pattern>`);
      return { kind, path: rest.slice(0, second), pattern: rest.slice(second + 1) } as ProbeSpec;
    }
    case 'cmd_exit_zero':
      return { kind, command: rest };
    case 'git_ref_exists':
      return { kind, ref: rest };
    case 'http_status': {
      const second = rest.indexOf(':');
      if (second < 0) return { kind, url: rest };
      const url = rest.slice(0, second);
      const expect = Number.parseInt(rest.slice(second + 1), 10);
      return Number.isFinite(expect) ? { kind, url, expect } : { kind, url: rest };
    }
    default:
      throw new Error(`unhandled probe kind ${kind}`);
  }
}

async function run(ctx: CommandContext): Promise<CommandResult> {
  const claim = flagString(ctx, 'claim') ?? ctx.positionals.join(' ');
  if (claim.length === 0) {
    throw new Error('a claim is required: --claim "…" or a positional string');
  }
  const rawChecks = ctx.flags['check'];
  const checkList = Array.isArray(rawChecks) ? rawChecks : typeof rawChecks === 'string' ? [rawChecks] : [];
  if (checkList.length === 0) {
    throw new Error('at least one --check is required — claims without probes stay UNKNOWN by design');
  }
  const probes = checkList.map(parseCheckSpec);
  const root = rootFrom(ctx);
  const repeat = flagBool(ctx, 'repeat');

  const verdict = await verifyClaimAsync(claim, probes, { cwd: root, repeat });

  // Refutations persist: the identical claim may not be silently retried.
  let recordedKnownFalse: string | undefined;
  if (verdict.status === 'REFUTED') {
    const registryPath = flagString(ctx, 'registry') ?? join('.theqa', 'known-false.json');
    const registry = new KnownFalseRegistry(join(root, registryPath));
    const entry = registry.add(claim, 'refuted by qa verify', verdict.probes.find((p) => p.status === 'FAIL')?.observation ?? 'probe failed');
    recordedKnownFalse = entry.hash;
  }

  if (ctx.json) {
    return ok({ verdict, knownFalseRecorded: recordedKnownFalse ?? null }, verdict.label, verdict.status === 'VERIFIED' ? EXIT_OK : EXIT_FINDINGS);
  }

  ctx.logger.banner('verify');
  ctx.logger.info(`claim: ${claim}`);
  for (const p of verdict.probes) {
    const mark = p.status === 'PASS' ? 'PASS' : p.status === 'FAIL' ? 'FAIL' : 'ERROR';
    ctx.logger.info(`  [${mark}] ${p.spec.kind} — ${p.observation ?? p.error ?? ''}`);
  }
  if (verdict.repeat !== undefined) {
    ctx.logger.info(`repeat run: ${verdict.repeat.status}`);
  }
  ctx.logger.info(`→ ${verdict.status} (${verdict.label}): ${verdict.explanation}`);
  if (recordedKnownFalse !== undefined) {
    ctx.logger.info(`recorded in KNOWN_FALSE registry (${recordedKnownFalse}) — change the claim, not the answer`);
  }
  return ok(
    { verdict, knownFalseRecorded: recordedKnownFalse ?? null },
    verdict.label,
    verdict.status === 'VERIFIED' ? EXIT_OK : EXIT_FINDINGS,
  );
}

export const verifyCommand: CommandSpec = {
  name: 'verify',
  summary: 'verify a claim with deterministic ground-truth probes; refutations enter the KNOWN_FALSE registry (read-only)',
  usage: 'qa verify --claim <claim> --check <kind:arg[:extra]>... [--repeat] [--registry <path>] [--json]',
  positionals: ['claim'],
  flags: [
    { name: 'claim', value: true, description: 'The claim to verify (a positional also works)' },
    { name: 'check', value: true, description: 'Probe spec, repeatable: file_exists:<path>, file_contains:<path>:<pattern>, cmd_exit_zero:<cmd>, git_ref_exists:<ref>, json_valid:<path>, dir_exists:<path>, file_not_contains:<path>:<pattern>, http_status:<url>[:<expect>]' },
    { name: 'repeat', value: false, description: 'Run every probe twice; agreeing runs upgrade the label to CONFIRMED' },
    { name: 'registry', value: true, description: 'KNOWN_FALSE registry path (default .theqa/known-false.json)' },
  ],
  run,
};
