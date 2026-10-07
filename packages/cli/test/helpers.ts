import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCommand } from '../src/index.js';

/** Fresh temp directory per test — real filesystem, cleaned by the caller. */
export function makeTempDir(prefix = 'cli-test'): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** Write a file (creating parent directories), relative to the given root. */
export function write(root: string, relPath: string, content: string): string {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

/** Run a git command with a deterministic identity (test helper). */
export function git(root: string, args: string): void {
  execSync(`git ${args}`, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'qa-cli-test',
      GIT_AUTHOR_EMAIL: 'qa@example.com',
      GIT_COMMITTER_NAME: 'qa-cli-test',
      GIT_COMMITTER_EMAIL: 'qa@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: 'pipe',
  });
}

export function commitAll(root: string, message: string): void {
  git(root, 'add -A');
  git(root, `commit -m ${JSON.stringify(message)}`);
}

/** Init a repo with a committed baseline (package.json + given extra files already written). */
export function initRepo(root: string, pkg: Record<string, unknown> = { name: 'app', private: true }): void {
  git(root, 'init');
  git(root, 'config user.name qa-cli-test');
  git(root, 'config user.email qa@example.com');
  write(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  commitAll(root, 'chore: baseline');
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Parse the single JSON envelope written to stdout (throws when absent). */
  json: <T = Record<string, unknown>>() => T;
}

/**
 * Run the CLI in-process with captured IO and THEQA_ROOT pointed at `root`.
 * Never spawns the compiled CLI — handlers run directly (exit codes without
 * process.exit by contract).
 */
export async function runCli(argv: string[], root?: string): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const prevRoot = process.env.THEQA_ROOT;
  if (root !== undefined) process.env.THEQA_ROOT = root;
  try {
    const code = await runCommand(argv, {
      io: {
        stdout: { write: (text: string) => void out.push(text) },
        stderr: { write: (text: string) => void err.push(text) },
      },
    });
    return {
      code,
      stdout: out.join(''),
      stderr: err.join(''),
      json: <T = Record<string, unknown>>(): T => JSON.parse(out.join('')) as T,
    };
  } finally {
    if (prevRoot === undefined) delete process.env.THEQA_ROOT;
    else process.env.THEQA_ROOT = prevRoot;
  }
}

/** A minimal FailedTestRecord JSON fixture builder. */
export function failureRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    testId: 't1',
    name: 't1 fails',
    filePath: 'tests/t1.spec.ts',
    layer: 'unit',
    attempts: [
      {
        status: 'failed',
        durationMs: 12,
        timestamp: '2026-02-01T10:00:00.000Z',
        environment: 'local',
        errorType: 'AssertionError',
        errorMessage: 'expected false to be true',
      },
    ],
    changedFiles: [],
    recentRuns: ['passed', 'failed'],
    ...overrides,
  };
}
