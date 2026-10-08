/**
 * xRouteLM — public contracts.
 *
 * xRouteLM is a **System One decision engine**: it does not generate text.
 * You submit a state (the context) plus typed questions, and it returns
 * calibrated, typed answers with probabilities and confidence — the same
 * question semantics Jev made popular (choice / score / noul), implemented
 * with a portable scorer pipeline so it runs anywhere Laya cannot (no macOS,
 * no MLX, no Apple Silicon) and without needing Jev itself.
 *
 * Every answer carries its evidence. No probability in this package is a
 * constant: each is derived from observable lexical/structural signals and
 * can be audited through the decision journal.
 */

/** Jev-compatible question types. */
export type QuestionKind = 'noul' | 'choice' | 'score';

export interface NoulQuestion {
  type: 'noul';
  /** What "true" means for this question. */
  instructions: string;
  /** Optional lexical anchors that strengthen the positive case. */
  keywords?: string[];
  /** Optional lexical anchors for the negative case. */
  negativeKeywords?: string[];
}

export interface ChoiceOption {
  id: string;
  description: string;
  keywords?: string[];
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  options: ChoiceOption[];
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** Ordered levels, low → high (e.g. ['low','medium','high']). */
  levels: string[];
  /** Optional anchors per level, aligned with `levels`. */
  levelKeywords?: string[][];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface QuestionRequest {
  name: string;
  question: Question;
}

/** Evidence for one probability — every number is traceable. */
export interface AnswerEvidence {
  /** Signals that raised the score, with their contributions. */
  matches: Array<{ token: string; weight: number; source: 'state' | 'anchor' }>;
  /** Raw similarity before calibration (0..1). */
  rawScore: number;
  /** Margin over the next-best alternative (choice questions only). */
  margin?: number;
}

export interface NoulAnswer {
  type: 'noul';
  /** P(instructions is true of the state), 0..1. */
  noul: number;
  confidence: number;
  evidence: AnswerEvidence;
}

export interface ChoiceAnswer {
  type: 'choice';
  /** Probability per option id (sums to ~1 across options). */
  probabilities: Record<string, number>;
  selected: string;
  confidence: number;
  evidence: AnswerEvidence;
}

export interface ScoreAnswer {
  type: 'score';
  /** Continuous score 0..1 across the ordered levels. */
  score: number;
  /** The selected level bucket. */
  level: string;
  /** Distribution across levels (sums to ~1). */
  distribution: Record<string, number>;
  confidence: number;
  evidence: AnswerEvidence;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionResult {
  name: string;
  kind: QuestionKind;
  answer: Answer;
  /** Which scorer produced this answer. */
  scorer: string;
  /** Wall-clock evaluation time. */
  durationMs: number;
}

export interface DecisionSet {
  /** Stable hash of the state text — the journal key. */
  stateHash: string;
  decisions: DecisionResult[];
  scorer: string;
  totalDurationMs: number;
  /** Epistemics: heuristic scorers produce INFERRED probabilities. */
  label: 'INFERRED';
}

/** Scorer plugin contract — the xRouteLM plugin system. */
export interface Scorer {
  readonly id: string;
  /** Human description surfaced by `xroutelm doctor`. */
  readonly description: string;
  readonly available: boolean;
  /** Why a scorer is unavailable (honest capability reporting). */
  unavailableReason?: string;
  /** Rough relative cost (heuristics ~0, remote LLMs higher). */
  readonly costWeight: number;
  evaluate(state: string, requests: QuestionRequest[]): Promise<DecisionResult[]>;
}

export interface RouteTarget {
  id: string;
  description: string;
  keywords?: string[];
  /** Optional command to execute when this target is selected (harness mode). */
  command?: string;
}

export interface RouteDecision {
  target: string;
  confidence: number;
  probabilities: Record<string, number>;
  /** Ordered fallback chain: what would have been chosen next. */
  fallback: string[];
  scorer: string;
  evidence: AnswerEvidence;
  label: 'INFERRED';
}

/** One journaled decision (JSONL line) — replayable and auditable. */
export interface JournalEntry {
  ts: string;
  kind: 'decision' | 'route';
  stateHash: string;
  statePreview: string;
  payload: unknown;
  scorer: string;
}
