/**
 * The 12-phase QA lifecycle. Every QA task flows through these phases in order.
 * The tracker refuses phase-skipping: you cannot EXECUTE without a PLAN,
 * you cannot HEAL without TRIAGE, you cannot MEASURE without VERIFY —
 * this is what prevents "user asked for tests → write Playwright code" jumps.
 */
export const LIFECYCLE_PHASES = [
  'DISCOVER',
  'MODEL',
  'PLAN',
  'GENERATE',
  'VALIDATE',
  'EXECUTE',
  'OBSERVE',
  'TRIAGE',
  'HEAL',
  'VERIFY',
  'MEASURE',
  'LEARN',
] as const;

export type LifecyclePhase = (typeof LIFECYCLE_PHASES)[number];

export type PhaseStatus = 'pending' | 'active' | 'complete' | 'skipped' | 'blocked';

export interface PhaseRecord {
  phase: LifecyclePhase;
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  /** Why a phase was blocked or skipped — required for those statuses. */
  note?: string;
}

/** Phases that may not be skipped under any orchestration policy. */
const MANDATORY: ReadonlySet<LifecyclePhase> = new Set(['DISCOVER', 'PLAN', 'EXECUTE', 'TRIAGE', 'VERIFY', 'MEASURE']);

/** Preconditions: a phase may start only when all listed phases are complete. */
const PRECONDITIONS: Record<LifecyclePhase, readonly LifecyclePhase[]> = {
  DISCOVER: [],
  MODEL: ['DISCOVER'],
  PLAN: ['MODEL'],
  GENERATE: ['PLAN'],
  VALIDATE: ['GENERATE'],
  EXECUTE: ['VALIDATE'],
  OBSERVE: ['EXECUTE'],
  TRIAGE: ['OBSERVE'],
  HEAL: ['TRIAGE'],
  VERIFY: ['HEAL'],
  MEASURE: ['VERIFY'],
  LEARN: ['MEASURE'],
};

export class LifecycleError extends Error {
  constructor(
    public readonly phase: LifecyclePhase,
    public readonly unmet: LifecyclePhase[],
  ) {
    super(
      `Lifecycle violation: cannot enter ${phase} before completing: ${unmet.join(', ')}. ` +
      `The lifecycle is DISCOVER → MODEL → PLAN → GENERATE → VALIDATE → EXECUTE → OBSERVE → TRIAGE → HEAL → VERIFY → MEASURE → LEARN.`,
    );
    this.name = 'LifecycleError';
  }
}

export class LifecycleTracker {
  private readonly records = new Map<LifecyclePhase, PhaseRecord>();

  constructor() {
    for (const phase of LIFECYCLE_PHASES) {
      this.records.set(phase, { phase, status: 'pending' });
    }
  }

  /** Phases that must be complete before `phase` may begin (transitive closure). */
  unmetPreconditions(phase: LifecyclePhase): LifecyclePhase[] {
    const unmet = new Set<LifecyclePhase>();
    const visit = (p: LifecyclePhase): void => {
      for (const dep of PRECONDITIONS[p]) {
        if (this.records.get(dep)?.status !== 'complete') {
          unmet.add(dep);
        }
        visit(dep);
      }
    };
    visit(phase);
    // Preserve lifecycle order for readable messages.
    return LIFECYCLE_PHASES.filter((p) => unmet.has(p));
  }

  begin(phase: LifecyclePhase, now = new Date().toISOString()): PhaseRecord {
    const unmet = this.unmetPreconditions(phase);
    if (unmet.length > 0) throw new LifecycleError(phase, unmet);
    const rec = this.records.get(phase);
    if (!rec) throw new Error(`Unknown phase ${phase}`);
    if (rec.status === 'complete') throw new Error(`Phase ${phase} already complete; refusing to restart.`);
    rec.status = 'active';
    rec.startedAt = now;
    rec.note = undefined;
    return { ...rec };
  }

  complete(phase: LifecyclePhase, now = new Date().toISOString()): PhaseRecord {
    const rec = this.records.get(phase);
    if (!rec) throw new Error(`Unknown phase ${phase}`);
    if (rec.status !== 'active' && rec.status !== 'blocked') {
      throw new Error(`Phase ${phase} must be active to complete (current: ${rec.status}).`);
    }
    rec.status = 'complete';
    rec.completedAt = now;
    return { ...rec };
  }

  /**
   * Mark a phase skipped. Only optional phases may be skipped, and a reason is
   * mandatory — silent skipping is forbidden.
   */
  skip(phase: LifecyclePhase, reason: string, now = new Date().toISOString()): PhaseRecord {
    if (MANDATORY.has(phase)) {
      throw new Error(`Phase ${phase} is mandatory under every orchestration policy and cannot be skipped.`);
    }
    const unmet = this.unmetPreconditions(phase);
    if (unmet.length > 0) throw new LifecycleError(phase, unmet);
    const rec = this.records.get(phase);
    if (!rec) throw new Error(`Unknown phase ${phase}`);
    rec.status = 'skipped';
    rec.completedAt = now;
    rec.note = reason;
    return { ...rec };
  }

  block(phase: LifecyclePhase, reason: string): PhaseRecord {
    const rec = this.records.get(phase);
    if (!rec) throw new Error(`Unknown phase ${phase}`);
    rec.status = 'blocked';
    rec.note = reason;
    return { ...rec };
  }

  status(phase: LifecyclePhase): PhaseStatus {
    return this.records.get(phase)?.status ?? 'pending';
  }

  snapshot(): PhaseRecord[] {
    return LIFECYCLE_PHASES.map((p) => ({ ...(this.records.get(p) as PhaseRecord) }));
  }

  /** Human-readable progress line, e.g. `DISCOVER✓ MODEL✓ PLAN● GENERATE○ …`. */
  renderProgress(): string {
    const glyph: Record<PhaseStatus, string> = {
      pending: '○',
      active: '●',
      complete: '✓',
      skipped: '↷',
      blocked: '✗',
    };
    return LIFECYCLE_PHASES.map((p) => `${p}${glyph[this.status(p)]}`).join(' → ');
  }
}
