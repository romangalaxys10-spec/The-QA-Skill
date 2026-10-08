import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { listFiles } from '@the-qa-skill/core';
import type { QAContext } from '@the-qa-skill/core';
import type { Requirement } from '../types.js';

/**
 * RequirementsAgent — extracts testable requirements from markdown specs.
 *
 * Default scan set (when no explicit paths are given): `README.md`,
 * markdown under `docs/` at any depth, and `requirements/*.md`, capped at 20
 * files, sorted for determinism. Headings at level 1–2 become requirement
 * titles; `-` and `*` list items under a heading become its acceptance
 * criteria. Fenced code blocks are ignored (a `#` inside a fence is not a
 * heading). Files longer than 5000 lines are skipped (they are documents, not
 * specs). When nothing is found the agent returns an honest empty array — it
 * never invents requirements.
 *
 * Deterministic: identical inputs always produce identical requirement ids
 * (`REQ-<slugified-title>-<index>`, global 1-based traversal order).
 */

const MAX_FILES = 20;
const MAX_LINES = 5000;

export class RequirementsAgent {
  constructor(private readonly root: string) {}

  /**
   * Extract requirements from the default scan set or the given explicit
   * paths (absolute or relative to the agent root). Non-existent and
   * unreadable files are skipped silently — extraction is best-effort by
   * design and the result is honest about what was actually parsed.
   */
  extract(paths?: string[]): Requirement[] {
    const files =
      paths !== undefined && paths.length > 0 ? paths.map((p) => this.normalize(p)) : this.defaultSpecFiles();
    const requirements: Requirement[] = [];
    let index = 0;

    for (const rel of files) {
      const abs = isAbsolute(rel) ? rel : join(this.root, rel);
      if (!existsSync(abs)) continue;
      let source: string;
      try {
        source = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      if (source.split('\n').length > MAX_LINES) continue;

      for (const parsed of parseMarkdownSpec(source)) {
        index += 1;
        const slug = slugify(parsed.title);
        const priority = /\bmust\b/i.test(`${parsed.title} ${parsed.criteria.join(' ')}`) ? 'must' : 'should';
        requirements.push({
          id: `REQ-${slug}-${index}`,
          title: parsed.title,
          criteria: parsed.criteria,
          source: rel,
          priority,
          status: 'draft',
        });
      }
    }
    return requirements;
  }

  /** Default markdown spec scan set: README + docs/** + requirements/*, capped and sorted. */
  private defaultSpecFiles(): string[] {
    return listFiles(this.root)
      .filter((f) => f === 'README.md' || /^docs\/.+\.md$/.test(f) || /^requirements\/[^/]+\.md$/.test(f))
      .sort()
      .slice(0, MAX_FILES);
  }

  /** Normalize an explicit path to a stable `source` value (repo-relative when under root). */
  private normalize(p: string): string {
    const abs = isAbsolute(p) ? p : join(this.root, p);
    const rel = relative(this.root, abs).split(/[/\\]/).join('/');
    return rel.startsWith('..') ? p.split(/[/\\]/).join('/') : rel;
  }
}

interface ParsedSection {
  title: string;
  criteria: string[];
}

/** Parse level-1/2 headings as titles and their list items as criteria. */
export function parseMarkdownSpec(source: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  let current: ParsedSection | undefined;
  let inFence = false;

  for (const raw of source.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = raw.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
    if (heading && heading[2]) {
      if (current) sections.push(current);
      current = { title: heading[2].trim(), criteria: [] };
      continue;
    }
    const item = raw.match(/^\s*[-*]\s+(.+)$/);
    if (item?.[1] && current) {
      const text = item[1].trim();
      if (text) current.criteria.push(text);
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** Slugify a title for requirement ids: lowercase, non-alphanumerics → '-', capped. */
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'untitled';
}
