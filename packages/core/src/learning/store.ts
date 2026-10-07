import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { LearningRecord, LearningRecordType } from '../types.js';

/**
 * Learning loop — structured, queryable, and never silent.
 * Every behavioral lesson (failure clusters, accepted/rejected healings, flake
 * observations, rejected generations, review feedback) is recorded with an
 * explicit `effect` statement. Nothing mutates behavior implicitly from a
 * single failure: consumers (triage, healing, selection) read aggregates.
 */

export interface LearningQuery {
  type?: LearningRecordType;
  tags?: string[];
  limit?: number;
}

export class LearningStore {
  constructor(private readonly filePath: string) {}

  append(record: Omit<LearningRecord, 'id' | 'timestamp'> & { timestamp?: string }): LearningRecord {
    const full: LearningRecord = {
      id: `lr-${createHash('sha256').update(`${JSON.stringify(record)}-${Date.now()}-${Math.random()}`).digest('hex').slice(0, 10)}`,
      timestamp: record.timestamp ?? new Date().toISOString(),
      type: record.type,
      tags: record.tags,
      payload: record.payload,
      effect: record.effect,
    };
    const dir = dirname(this.filePath);
    if (dir) mkdirSync(dir, { recursive: true });
    appendFileSync(this.filePath, JSON.stringify(full) + '\n', 'utf8');
    return full;
  }

  query(q: LearningQuery = {}): LearningRecord[] {
    if (!existsSync(this.filePath)) return [];
    const out: LearningRecord[] = [];
    const raw = readFileSync(this.filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as LearningRecord;
        if (q.type && rec.type !== q.type) continue;
        if (q.tags && q.tags.length > 0 && !q.tags.some((t) => rec.tags.includes(t))) continue;
        out.push(rec);
      } catch {
        continue; // skip malformed lines — the store is append-only JSONL
      }
    }
    return q.limit ? out.slice(-q.limit) : out;
  }

  /** Failure patterns by path — feeds the risk engine's defectHistory input. */
  failureDensityByPath(): Record<string, number> {
    const counts = new Map<string, number>();
    for (const rec of this.query({ type: 'failure' })) {
      const paths = (rec.payload.paths as string[] | undefined) ?? [];
      for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const max = Math.max(1, ...counts.values());
    const norm: Record<string, number> = {};
    for (const [p, c] of counts) norm[p] = c / max;
    return norm;
  }

  /** Rejected healings for a target — healing proposals check this before applying. */
  rejectedHealingsFor(testId: string): LearningRecord[] {
    return this.query({ type: 'healing_rejected' }).filter((r) => r.payload.testId === testId);
  }

  summarize(): string {
    const all = this.query();
    const byType = new Map<string, number>();
    for (const r of all) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    if (all.length === 0) return 'learning store is empty — no lessons recorded yet';
    const parts = [...byType.entries()].map(([t, c]) => `${t}: ${c}`).join(', ');
    return `${all.length} records (${parts})`;
  }
}

/** Default store location resolver. */
export function defaultLearningPath(root: string): string {
  return join(root, '.theqa', 'learning.jsonl');
}
