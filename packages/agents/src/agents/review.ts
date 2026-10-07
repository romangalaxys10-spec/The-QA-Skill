import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { analyzeTestFile, listFiles } from '@the-qa-skill/core';
import type { TestQualityReport } from '@the-qa-skill/core';

/**
 * ReviewAgent — static test-quality review over test-shaped files.
 *
 * Discovery: when no explicit paths are given, core `listFiles` is filtered to
 * test-shaped files: any `*.test.` or `*.spec.` file at any depth, plus
 * anything inside `__tests__/`. Explicit paths may be absolute or
 * root-relative. Each file is read and analyzed by the core 17-dimension
 * quality engine; unreadable files are skipped honestly (a file that cannot
 * be read cannot be reviewed).
 */
export class ReviewAgent {
  constructor(private readonly root: string) {}

  /** Review the discovered (or explicitly given) test files. */
  async review(paths?: string[]): Promise<TestQualityReport[]> {
    const files =
      paths !== undefined && paths.length > 0 ? paths.map((p) => this.normalize(p)) : this.discoverTestFiles();
    const reports: TestQualityReport[] = [];
    for (const rel of files) {
      const abs = isAbsolute(rel) ? rel : join(this.root, rel);
      if (!existsSync(abs)) continue;
      let source: string;
      try {
        source = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      reports.push(analyzeTestFile(rel, source));
    }
    return reports;
  }

  private discoverTestFiles(): string[] {
    return listFiles(this.root).filter(isTestShaped);
  }

  private normalize(p: string): string {
    const abs = isAbsolute(p) ? p : join(this.root, p);
    const rel = relative(this.root, abs).split(/[/\\]/).join('/');
    return rel.startsWith('..') ? p.split(/[/\\]/).join('/') : rel;
  }
}

/** A path is test-shaped when it looks like a test/spec file or lives in __tests__. */
export function isTestShaped(path: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path) || /(^|\/)__tests__\/[^/]+\.[cm]?[jt]sx?$/i.test(path);
}
