import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { ConfigError, discover, isGitRepo, loadConfig, runGit } from '@the-qa-skill/core';
import type { TheQAConfig } from '@the-qa-skill/core';
import type { CommandSpec } from '../args.js';
import { loadProject, ok, rootFrom, EXIT_FINDINGS, EXIT_OK } from '../shared.js';
import type { CommandContext, CommandResult } from '../shared.js';
/**
 * qa doctor — 12 environment health checks, scored 0..100 (PASS=10, WARN=5,
 * FAIL=0, scaled to 100). Every check returns { id, title, status, detail,
 * fix? }. Exit 1 when the overall verdict is FAIL (any FAIL-status check);
 * WARN never blocks.
 *
 * Checks: node ≥ 18.17 · git available · git repository · package-manager
 * lockfile · theqa.config.json valid · test framework detected · playwright
 * availability (graceful) · playwright browsers · port conflicts on
 * 3000/8080/5432 · provider env vars · .env not tracked in git · learning
 * store writable.
 */

export interface DoctorCheck {
  id: string;
  title: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
  fix?: string;
}

export interface DoctorData {
  checks: DoctorCheck[];
  healthScore: number;
  overall: 'PASS' | 'WARN' | 'FAIL';
  root: string;
}

const NODE_MIN = [18, 17, 0];

function compareVersion(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function spawnVersion(command: string, args: string[], timeoutMs: number): { version?: string; error?: string } {
  try {
    const res = spawnSync(command, args, { timeout: timeoutMs, encoding: 'utf8', cwd: process.cwd() });
    if (res.error !== undefined) return { error: res.error.message };
    if (res.status !== 0) return { error: `exit ${String(res.status)}: ${(res.stderr ?? '').trim().slice(0, 120)}` };
    return { version: (res.stdout ?? '').trim().split('\n')[0]?.slice(0, 120) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = net.createServer();
    server.once('error', () => resolvePromise(true));
    server.once('listening', () => {
      server.close(() => resolvePromise(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

const PROVIDER_ENV: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  deterministic: [],
  local: [],
};

export async function runChecks(root: string, config: TheQAConfig, verbose = false): Promise<DoctorCheck[]> {
  void verbose;
  const checks: DoctorCheck[] = [];

  // 1. Node version.
  const nodeParts = process.versions.node.split('.').map((p) => parseInt(p, 10));
  if (compareVersion(nodeParts, NODE_MIN) >= 0) {
    checks.push({ id: 'node-version', title: 'Node.js version', status: 'PASS', detail: `node ${process.versions.node} (>= ${NODE_MIN.join('.')})` });
  } else {
    checks.push({ id: 'node-version', title: 'Node.js version', status: 'FAIL', detail: `node ${process.versions.node} is below the required ${NODE_MIN.join('.')}`, fix: 'upgrade Node.js to 18.17.0 or newer' });
  }

  // 2. Git available.
  const git = spawnVersion('git', ['--version'], 5000);
  if (git.version !== undefined) {
    checks.push({ id: 'git-available', title: 'Git available', status: 'PASS', detail: git.version });
  } else {
    checks.push({ id: 'git-available', title: 'Git available', status: 'FAIL', detail: `git is not runnable: ${git.error ?? 'unknown error'}`, fix: 'install git and ensure it is on PATH' });
  }

  // 3. Git repository.
  if (checks.find((c) => c.id === 'git-available')?.status !== 'PASS') {
    checks.push({ id: 'git-repo', title: 'Git repository', status: 'WARN', detail: 'skipped — git is unavailable', fix: 'install git first' });
  } else if (await isGitRepo(root)) {
    checks.push({ id: 'git-repo', title: 'Git repository', status: 'PASS', detail: `${root} is inside a git work tree` });
  } else {
    checks.push({ id: 'git-repo', title: 'Git repository', status: 'WARN', detail: `${root} is not a git repository — risk/impact/test-selection commands need a diff`, fix: 'run `git init` (or set THEQA_ROOT to the repository root)' });
  }

  // 4. Package-manager lockfile.
  const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];
  const lock = lockfiles.find((f) => existsSync(join(root, f)));
  if (lock !== undefined) {
    checks.push({ id: 'lockfile', title: 'Package manager lockfile', status: 'PASS', detail: lock });
  } else {
    checks.push({ id: 'lockfile', title: 'Package manager lockfile', status: 'WARN', detail: 'no lockfile found — dependency drift makes failures unreproducible', fix: 'commit the lockfile produced by your package manager' });
  }

  // 5. theqa.config.json valid.
  try {
    const loaded = loadConfig(root);
    if (loaded.path === undefined) {
      checks.push({ id: 'config', title: 'theqa.config.json', status: 'WARN', detail: 'no theqa.config.json found — defaults in use', fix: 'run `qa init` to write one' });
    } else {
      checks.push({ id: 'config', title: 'theqa.config.json', status: 'PASS', detail: `valid (${loaded.path})` });
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      checks.push({ id: 'config', title: 'theqa.config.json', status: 'FAIL', detail: e.message, fix: 'fix the listed issues or re-run `qa init --force`' });
    } else {
      checks.push({ id: 'config', title: 'theqa.config.json', status: 'FAIL', detail: (e as Error).message, fix: 'inspect theqa.config.json' });
    }
  }

  // 6. Test framework detected.
  const frameworks = discover(root).stack.testFrameworks;
  if (frameworks.length > 0) {
    checks.push({ id: 'test-framework', title: 'Test framework detected', status: 'PASS', detail: frameworks.join(', ') });
  } else {
    checks.push({ id: 'test-framework', title: 'Test framework detected', status: 'WARN', detail: 'no test framework detected (vitest/jest/playwright/cypress/mocha/pytest)', fix: 'add a test runner to devDependencies' });
  }

  // 7. Playwright availability (graceful: WARN, never FAIL).
  const pw = spawnVersion('npx', ['--no-install', 'playwright', '--version'], 10_000);
  if (pw.version !== undefined) {
    checks.push({ id: 'playwright', title: 'Playwright available', status: 'PASS', detail: pw.version });
  } else {
    checks.push({ id: 'playwright', title: 'Playwright available', status: 'WARN', detail: `playwright not runnable via npx --no-install (${pw.error ?? 'not installed here'}) — fine unless you run browser tests`, fix: 'npm i -D @playwright/test' });
  }

  // 8. Playwright browsers installed.
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(browsersPath)) {
    checks.push({ id: 'playwright-browsers', title: 'Playwright browsers', status: 'PASS', detail: `browser cache present at ${browsersPath}` });
  } else {
    checks.push({ id: 'playwright-browsers', title: 'Playwright browsers', status: 'WARN', detail: `no browser cache at ${browsersPath}`, fix: 'npx playwright install' });
  }

  // 9. Port conflicts (3000/8080/5432 briefly probed).
  const ports = [3000, 8080, 5432];
  const busy: number[] = [];
  for (const port of ports) {
    if (await portInUse(port)) busy.push(port);
  }
  if (busy.length === 0) {
    checks.push({ id: 'ports', title: 'Port availability', status: 'PASS', detail: `probed ${ports.join(', ')} — all free` });
  } else {
    checks.push({ id: 'ports', title: 'Port availability', status: 'WARN', detail: `in use: ${busy.join(', ')} — local test servers may fail to bind`, fix: 'stop the process holding the port or point your test config at a free port' });
  }

  // 10. Provider env vars for the configured reasoning provider.
  const provider = config.integrations.reasoningProvider;
  const needed = PROVIDER_ENV[provider] ?? [];
  const missing = needed.filter((name) => (process.env[name] ?? '').length === 0);
  if (needed.length === 0) {
    checks.push({ id: 'provider-env', title: 'Provider credentials', status: 'PASS', detail: `reasoningProvider '${provider}' needs no credentials` });
  } else if (missing.length === 0) {
    checks.push({ id: 'provider-env', title: 'Provider credentials', status: 'PASS', detail: `${needed.join(', ')} present for '${provider}'` });
  } else {
    checks.push({ id: 'provider-env', title: 'Provider credentials', status: 'FAIL', detail: `reasoningProvider '${provider}' requires ${missing.join(', ')} — not set`, fix: `export ${missing.join(' and ')} (env only — never theqa.config.json)` });
  }

  // 11. .env not tracked in git (secret hygiene).
  if (checks.find((c) => c.id === 'git-repo')?.status === 'PASS') {
    try {
      await runGit(['ls-files', '--error-unmatch', '.env'], root);
      checks.push({ id: 'env-tracked', title: '.env secret hygiene', status: 'WARN', detail: '.env is tracked in git — secrets in history are exposed', fix: 'git rm --cached .env && add .env to .gitignore' });
    } catch {
      checks.push({ id: 'env-tracked', title: '.env secret hygiene', status: 'PASS', detail: '.env is not tracked in git (or does not exist)' });
    }
  } else {
    checks.push({ id: 'env-tracked', title: '.env secret hygiene', status: 'PASS', detail: 'skipped — not a git repository' });
  }

  // 12. Learning store writable — probe beside the configured learning file
  // (never touch learning.jsonl itself; a read-only checkout must WARN).
  const learningPath = join(root, config.paths.learning);
  const learningDir = dirname(learningPath);
  const probePath = join(learningDir, '.theqa-doctor-probe');
  try {
    mkdirSync(learningDir, { recursive: true });
    writeFileSync(probePath, 'probe', 'utf8');
    unlinkSync(probePath);
    checks.push({ id: 'learning-store', title: 'Learning store writable', status: 'PASS', detail: `${learningPath} is writable` });
  } catch (e) {
    checks.push({ id: 'learning-store', title: 'Learning store writable', status: 'WARN', detail: `cannot write beside ${learningPath}: ${(e as Error).message}`, fix: 'make the project directory writable for the learning loop' });
  }

  return checks;
}

export function scoreChecks(checks: DoctorCheck[]): { healthScore: number; overall: DoctorData['overall'] } {
  const points = checks.reduce((a, c) => a + (c.status === 'PASS' ? 10 : c.status === 'WARN' ? 5 : 0), 0);
  const healthScore = checks.length > 0 ? Math.round((points / (checks.length * 10)) * 100) : 0;
  const overall: DoctorData['overall'] = checks.some((c) => c.status === 'FAIL') ? 'FAIL' : checks.some((c) => c.status === 'WARN') ? 'WARN' : 'PASS';
  return { healthScore, overall };
}

async function run(ctx: CommandContext): Promise<CommandResult<DoctorData>> {
  const root = rootFrom(ctx);
  const config = loadProject(root);
  const checks = await runChecks(root, config, ctx.verbose);
  const { healthScore, overall } = scoreChecks(checks);

  ctx.logger.banner('doctor');
  for (const c of checks) {
    const mark = c.status === 'PASS' ? '✓' : c.status === 'WARN' ? '!' : '✗';
    ctx.logger.info(`${mark} ${c.status.padEnd(4)} ${c.title} — ${c.detail}`);
    if (c.fix !== undefined) ctx.logger.info(`         fix: ${c.fix}`);
  }
  ctx.logger.info('');
  ctx.logger.info(`Health score: ${healthScore}/100 · overall: ${overall}`);
  if (overall === 'FAIL') {
    ctx.logger.info('Doctor FAIL — fix the ✗ checks above; some commands cannot run correctly.');
  }

  const exit = overall === 'FAIL' ? EXIT_FINDINGS : EXIT_OK;
  return {
    ok: exit === EXIT_OK,
    data: { checks, healthScore, overall, root },
    label: 'OBSERVED',
    exitCode: exit,
  };
}

export const doctorCommand: CommandSpec = {
  name: 'doctor',
  summary: 'run 12 environment health checks and produce a 0..100 health score',
  usage: 'qa doctor [--json] [--verbose]',
  positionals: [],
  flags: [],
  run,
};
