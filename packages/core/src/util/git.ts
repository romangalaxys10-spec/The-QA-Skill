import { spawn } from 'node:child_process';

/** Run a git command in a directory. Deterministic, no shell interpretation. */
export function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      reject(new Error(`git unavailable: ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim() || 'no stderr'}`));
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function currentCommit(cwd: string): Promise<string | undefined> {
  try {
    return (await runGit(['rev-parse', 'HEAD'], cwd)).trim();
  } catch {
    return undefined;
  }
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    return (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
  } catch {
    return undefined;
  }
}

/**
 * Normalized churn per path across recent history (0..1) — the defect-history
 * proxy. Files touched by many bug-fixing commits score higher. Reads commit
 * subjects; commits whose message matches fix patterns count double.
 */
export async function churnHotspots(cwd: string, maxCommits = 200): Promise<Record<string, number>> {
  try {
    const log = await runGit(['log', `--max-count=${maxCommits}`, '--name-only', '--pretty=format:---%H|%s'], cwd);
    const counts = new Map<string, number>();
    let isFix = false;
    for (const line of log.split('\n')) {
      if (line.startsWith('---')) {
        isFix = /(^|\s)(fix|bug|hotfix|patch|regression)(\s|:|$)/i.test(line);
        continue;
      }
      const path = line.trim();
      if (!path) continue;
      counts.set(path, (counts.get(path) ?? 0) + (isFix ? 2 : 1));
    }
    const max = Math.max(1, ...counts.values());
    const normalized: Record<string, number> = {};
    for (const [path, count] of counts) {
      normalized[path] = count / max;
    }
    return normalized;
  } catch {
    return {};
  }
}
