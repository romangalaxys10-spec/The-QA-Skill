import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Fresh temp directory per test — real filesystem, cleaned by the caller. */
export function makeTempDir(prefix = 'agents-test'): string {
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
      GIT_AUTHOR_NAME: 'qa-agent-test',
      GIT_AUTHOR_EMAIL: 'qa@example.com',
      GIT_COMMITTER_NAME: 'qa-agent-test',
      GIT_COMMITTER_EMAIL: 'qa@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: 'pipe',
  });
}

/** Initialize a git repo with a committed baseline package.json. */
export function initRepo(root: string, pkg: Record<string, unknown> = { name: 'app', private: true }): void {
  git(root, 'init');
  git(root, 'config user.name qa-agent-test');
  git(root, 'config user.email qa@example.com');
  write(root, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  commitAll(root, 'chore: baseline');
}

/** Stage and commit everything in the repo. */
export function commitAll(root: string, message: string): void {
  git(root, 'add -A');
  git(root, `commit -m ${JSON.stringify(message)}`);
}
