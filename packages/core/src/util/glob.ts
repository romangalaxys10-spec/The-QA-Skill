import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import picomatch from 'picomatch';

/** Default directories never walked (huge, vendor, VCS). */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.theqa', '.venv', 'venv', '__pycache__', '.turbo', '.cache',
  'target', 'vendor', '.pnpm-store',
]);

/** Recursively list files under root as normalized relative POSIX paths. */
export function listFiles(root: string, opts: { ignores?: string[]; maxFiles?: number } = {}): string[] {
  const maxFiles = opts.maxFiles ?? 20_000;
  const ignoreMatch = opts.ignores && opts.ignores.length > 0 ? picomatch(opts.ignores, { dot: true }) : undefined;
  const out: string[] = [];

  const walk = (dir: string): void => {
    if (out.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir — skip silently, discovery is best-effort
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORED_DIRS.has(entry)) walk(full);
      } else if (st.isFile()) {
        const rel = relative(root, full).split(/[/\\]/).join('/');
        if (ignoreMatch?.(rel)) continue;
        out.push(rel);
      }
    }
  };

  walk(root);
  return out;
}

/** Match a normalized relative path against glob patterns. */
export function matchAny(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return picomatch(patterns, { dot: true })(path);
}
