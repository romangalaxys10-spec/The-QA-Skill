import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { claimHash, normalizeClaim } from './engine.js';

/**
 * KNOWN_FALSE registry — persistent memory of refuted claims.
 *
 * Once a claim is REFUTED by a deterministic probe, retrying the identical
 * claim is banned: agents must change the claim (fix the underlying reality)
 * rather than re-ask the same question. The registry is a small JSON file
 * (default `.theqa/known-false.json`), append-only in practice, and every
 * entry records who refuted it, when, and with what evidence.
 */

export interface KnownFalseEntry {
  hash: string;
  claim: string;
  reason: string;
  refutedAt: string;
  /** Probe observation that produced the refutation. */
  evidence: string;
}

export class KnownFalseRegistry {
  constructor(private readonly filePath: string) {}

  private load(): Map<string, KnownFalseEntry> {
    if (!existsSync(this.filePath)) return new Map();
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const entries = Array.isArray(parsed) ? (parsed as KnownFalseEntry[]) : [];
      return new Map(entries.map((e) => [e.hash, e] as const));
    } catch {
      // Corrupt registry — treat as empty but never crash a verify run.
      return new Map();
    }
  }

  private save(entries: Map<string, KnownFalseEntry>): void {
    const dir = dirname(this.filePath);
    if (dir) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify([...entries.values()], null, 2) + '\n', 'utf8');
  }

  isKnownFalse(claim: string): KnownFalseEntry | undefined {
    return this.load().get(claimHash(claim));
  }

  /** Record a refutation. Returns the stored entry. */
  add(claim: string, reason: string, evidence: string): KnownFalseEntry {
    const entries = this.load();
    const entry: KnownFalseEntry = {
      hash: claimHash(claim),
      claim: normalizeClaim(claim),
      reason,
      refutedAt: new Date().toISOString(),
      evidence,
    };
    entries.set(entry.hash, entry);
    this.save(entries);
    return entry;
  }

  all(): KnownFalseEntry[] {
    return [...this.load().values()];
  }
}
