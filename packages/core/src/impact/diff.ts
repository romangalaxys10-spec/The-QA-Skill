import type { ChangedFile } from '../types.js';
import { classifyArea } from '../risk/factors.js';
import { runGit } from '../util/git.js';

/**
 * Git diff → structured change set. Uses `--numstat` + `--name-status` for
 * machine parsing (no diff-text scraping) and a regex pass over the added
 * lines to detect touched exported symbols.
 */

export interface DiffParseResult {
  files: ChangedFile[];
  addedLines: number;
  removedLines: number;
  range: string;
}

function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
    cs: 'csharp', php: 'php', dart: 'dart', sql: 'sql', css: 'css', scss: 'css', html: 'html',
    yml: 'yaml', yaml: 'yaml', json: 'json', md: 'markdown', sh: 'shell',
  };
  return map[ext] ?? 'other';
}

/** Detect exported symbols among ADDED diff lines (best effort, deterministic). */
function symbolsFromDiff(diffText: string, path: string): string[] {
  if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|cs)$/.test(path)) return [];
  const symbols = new Set<string>();
  const patterns: RegExp[] = [
    /export\s+(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+\{([^}]+)\}/g,
    /def\s+([A-Za-z_][\w]*)/g,
    /class\s+([A-Za-z_][\w]*)/g,
    /func\s+([A-Za-z_][\w]*)/g,
    /public\s+(?:async\s+)?[A-Za-z_<>\[\]]+\s+([A-Za-z_][\w]*)\s*\(/g,
  ];
  for (const line of diffText.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const content = line.slice(1);
    for (const p of patterns) {
      let m: RegExpExecArray | null;
      while ((m = p.exec(content)) !== null) {
        const name = (m[1] ?? '').trim();
        if (name) {
          for (const part of name.split(',')) {
            const clean = part.trim().split(/\s+as\s+/).pop()?.trim();
            if (clean && /^[A-Za-z_$][\w$]*$/.test(clean)) symbols.add(clean);
          }
        }
      }
    }
  }
  return [...symbols].slice(0, 20);
}

export async function analyzeDiff(cwd: string, range: string): Promise<DiffParseResult> {
  const nameStatus = await runGit(['diff', '--name-status', range], cwd);
  const numstat = await runGit(['diff', '--numstat', range], cwd);
  const addedSymbolsSource = await runGit(['diff', '--unified=0', range, '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.py', '*.go', '*.java'], cwd);

  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    const [add, del, rawPath] = parts as [string, string, string];
    // numstat renames appear as "old => new" or with braces; normalize to the new path.
    const path = rawPath.includes('=>') ? (rawPath.split('=>').pop() ?? rawPath).replace(/[{}]/g, '').trim() : rawPath;
    stats.set(path, { additions: add === '-' ? 0 : parseInt(add, 10), deletions: del === '-' ? 0 : parseInt(del, 10) });
  }

  const files: ChangedFile[] = [];
  for (const line of nameStatus.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 2) continue;
    const statusCode = parts[0] ?? '';
    let path: string;
    let status: ChangedFile['status'];
    if (statusCode.startsWith('R') && parts.length >= 3) {
      status = 'renamed';
      path = parts[2] ?? '';
    } else {
      path = parts[1] ?? '';
      status = statusCode.startsWith('A') ? 'added' : statusCode.startsWith('D') ? 'deleted' : statusCode.startsWith('R') ? 'renamed' : 'modified';
    }
    if (!path) continue;
    const st = stats.get(path) ?? { additions: 0, deletions: 0 };
    files.push({
      path,
      status,
      additions: st.additions,
      deletions: st.deletions,
      area: classifyArea(path),
      language: languageFor(path),
      symbols: symbolsFromDiff(addedSymbolsSource, path),
    });
  }

  const addedLines = files.reduce((a, f) => a + f.additions, 0);
  const removedLines = files.reduce((a, f) => a + f.deletions, 0);
  return { files, addedLines, removedLines, range };
}

/** Route classification: CSS-only change vs payment vs migration vs auth. */
export interface ChangeRouting {
  cssOnly: boolean;
  paymentRelated: boolean;
  migrationRelated: boolean;
  authRelated: boolean;
  docsOnly: boolean;
  testOnly: boolean;
  boundarySignals: string[];
}

export function classifyRouting(files: ChangedFile[]): ChangeRouting {
  const substantive = files.filter((f) => f.area !== 'docs');
  const hasArea = (area: ChangedFile['area']): boolean => substantive.some((f) => f.area === area);
  const cssOnly =
    substantive.length > 0 &&
    substantive.every((f) => /\.(css|scss|sass|less|styl)$/.test(f.path) || /style/i.test(f.path));

  const boundarySignals: string[] = [];
  if (hasArea('auth')) boundarySignals.push('auth');
  if (hasArea('payment')) boundarySignals.push('payment');
  if (hasArea('db')) boundarySignals.push('database');
  if (substantive.some((f) => /webhook/i.test(f.path))) boundarySignals.push('webhook');
  if (substantive.some((f) => /queue|broker|event/i.test(f.path))) boundarySignals.push('messaging');

  return {
    cssOnly,
    paymentRelated: hasArea('payment'),
    migrationRelated: hasArea('db'),
    authRelated: hasArea('auth'),
    docsOnly: substantive.length === 0 && files.length > 0,
    testOnly: substantive.every((f) => f.area === 'test') && files.length > 0,
    boundarySignals,
  };
}
