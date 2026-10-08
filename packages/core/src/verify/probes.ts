import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * Deterministic ground-truth probes for `qa verify`.
 *
 * A probe is the smallest mechanical check that can refute or support a claim
 * about the world. Probes never guess: a probe either OBSERVES a result,
 * fails cleanly (FAIL), or errors (ERROR — never treated as a refutation).
 *
 * The probe registry is intentionally tiny and dependency-free: filesystem,
 * process exit codes, git refs, JSON parseability, and (opt-in) HTTP status.
 * Every probe returns a ProbeOutcome with an evidence string safe to embed in
 * reports (observations are truncated; nothing throws).
 */

export type ProbeSpec =
  | { kind: 'file_exists'; path: string }
  | { kind: 'dir_exists'; path: string }
  | { kind: 'file_contains'; path: string; pattern: string; flags?: string }
  | { kind: 'file_not_contains'; path: string; pattern: string; flags?: string }
  | { kind: 'json_valid'; path: string }
  | { kind: 'cmd_exit_zero'; command: string; cwd?: string; timeoutMs?: number }
  | { kind: 'git_ref_exists'; repo?: string; ref: string }
  | { kind: 'http_status'; url: string; expect?: number; timeoutMs?: number };

export type ProbeStatus = 'PASS' | 'FAIL' | 'ERROR';

export interface ProbeOutcome {
  spec: ProbeSpec;
  status: ProbeStatus;
  /** Human-readable observation (truncated). Present for PASS and FAIL. */
  observation?: string;
  /** Error detail when status=ERROR — ERROR means the probe could not run. */
  error?: string;
  durationMs: number;
}

const MAX_OBSERVATION = 200;

function clip(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > MAX_OBSERVATION ? one.slice(0, MAX_OBSERVATION - 1) + '…' : one;
}

function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function safeRegex(pattern: string, flags?: string): RegExp | undefined {
  try {
    return new RegExp(pattern, flags ?? '');
  } catch {
    return undefined;
  }
}

/** Execute one synchronous probe. Never throws — errors become ERROR outcomes. */
export function runProbe(spec: ProbeSpec, cwd: string): ProbeOutcome {
  const started = Date.now();
  const done = (partial: Omit<ProbeOutcome, 'spec' | 'durationMs'>): ProbeOutcome => ({
    ...partial,
    spec,
    durationMs: Date.now() - started,
  });

  try {
    switch (spec.kind) {
      case 'file_exists': {
        const p = abs(cwd, spec.path);
        if (!existsSync(p)) return done({ status: 'FAIL', observation: `no file at ${spec.path}` });
        const st = statSync(p);
        if (!st.isFile()) return done({ status: 'FAIL', observation: `${spec.path} exists but is not a regular file` });
        return done({ status: 'PASS', observation: `file ${spec.path} exists (${st.size} bytes)` });
      }
      case 'dir_exists': {
        const p = abs(cwd, spec.path);
        if (!existsSync(p)) return done({ status: 'FAIL', observation: `no directory at ${spec.path}` });
        if (!statSync(p).isDirectory()) return done({ status: 'FAIL', observation: `${spec.path} exists but is not a directory` });
        return done({ status: 'PASS', observation: `directory ${spec.path} exists` });
      }
      case 'file_contains':
      case 'file_not_contains': {
        const p = abs(cwd, spec.path);
        if (!existsSync(p)) return done({ status: 'FAIL', observation: `no file at ${spec.path}` });
        const re = safeRegex(spec.pattern, spec.flags);
        if (re === undefined) return done({ status: 'ERROR', error: `invalid regex: ${spec.pattern}` });
        const text = readFileSync(p, 'utf8');
        const found = re.test(text);
        if (spec.kind === 'file_contains') {
          return found
            ? done({ status: 'PASS', observation: `${spec.path} matches /${spec.pattern}/` })
            : done({ status: 'FAIL', observation: `${spec.path} does not match /${spec.pattern}/` });
        }
        return found
          ? done({ status: 'FAIL', observation: `${spec.path} unexpectedly matches /${spec.pattern}/` })
          : done({ status: 'PASS', observation: `${spec.path} contains no match for /${spec.pattern}/` });
      }
      case 'json_valid': {
        const p = abs(cwd, spec.path);
        if (!existsSync(p)) return done({ status: 'FAIL', observation: `no file at ${spec.path}` });
        try {
          JSON.parse(readFileSync(p, 'utf8'));
          return done({ status: 'PASS', observation: `${spec.path} parses as JSON` });
        } catch (e) {
          return done({ status: 'FAIL', observation: `${spec.path} is not valid JSON: ${clip((e as Error).message)}` });
        }
      }
      case 'cmd_exit_zero': {
        // Split on whitespace, then strip one layer of wrapping quotes so that
        // `node -e "process.exit(3)"` passes process.exit(3) as the script.
        const parts = spec.command
          .split(/\s+/)
          .filter(Boolean)
          .map((a) => (a.length >= 2 && ((a.startsWith('"') && a.endsWith('"')) || (a.startsWith("'") && a.endsWith("'"))) ? a.slice(1, -1) : a));
        if (parts[0] === undefined) return done({ status: 'ERROR', error: 'empty command' });
        const file = parts[0];
        try {
          const out = execFileSync(file, parts.slice(1), {
            cwd: spec.cwd !== undefined ? abs(cwd, spec.cwd) : cwd,
            timeout: spec.timeoutMs ?? 10_000,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return done({ status: 'PASS', observation: `command exited 0: ${clip(out || spec.command)}` });
        } catch (e) {
          const err = e as { status?: number | null; message?: string };
          const detail = err.status !== undefined && err.status !== null ? `exit ${err.status}` : clip(err.message ?? 'spawn failed');
          return done({ status: 'FAIL', observation: `command failed (${detail}): ${spec.command}` });
        }
      }
      case 'git_ref_exists': {
        try {
          execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', '--quiet', `${spec.ref}^{commit}`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return done({ status: 'PASS', observation: `git ref ${spec.ref} resolves` });
        } catch {
          return done({ status: 'FAIL', observation: `git ref ${spec.ref} does not resolve in ${cwd}` });
        }
      }
      default: {
        // http_status must go through the async path (fetch is async-only).
        if ((spec as ProbeSpec).kind === 'http_status') {
          return done({ status: 'ERROR', error: 'use runProbeAsync for http_status probes' });
        }
        return done({ status: 'ERROR', error: `unhandled probe kind: ${JSON.stringify(spec)}` });
      }
    }
  } catch (e) {
    return done({ status: 'ERROR', error: clip((e as Error).message) });
  }
}

/** Async-capable probe execution (required for http_status via fetch). */
export async function runProbeAsync(spec: ProbeSpec, cwd: string): Promise<ProbeOutcome> {
  if (spec.kind === 'http_status') {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs ?? 5_000);
    try {
      const res = await fetch(spec.url, { signal: controller.signal, redirect: 'follow' });
      const expected = spec.expect ?? 200;
      return {
        spec,
        durationMs: Date.now() - started,
        status: res.status === expected ? 'PASS' : 'FAIL',
        observation:
          res.status === expected
            ? `GET ${spec.url} → ${res.status}`
            : `GET ${spec.url} → ${res.status} (expected ${expected})`,
      };
    } catch (e) {
      return {
        spec,
        durationMs: Date.now() - started,
        status: 'ERROR',
        error: `request failed: ${clip((e as Error).message)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return runProbe(spec, cwd);
}
