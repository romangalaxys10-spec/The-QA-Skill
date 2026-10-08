import type { DecisionEngine } from './engine.js';
import type { DecisionSet, QuestionRequest, Scorer } from './types.js';

/**
 * The xRouteLM harness — System One decisions as agent-loop middleware.
 *
 * Jev's headline use cases (model routing, urgency gating, retry policies)
 * are all "ask typed questions about the current state, let the answer drive
 * the loop". This harness packages exactly that shape so any agent runtime —
 * including Fable's router and The-QA-Skill's orchestrator — can gate its
 * loop with fast structured decisions instead of full LLM calls.
 *
 * The harness never generates text and never fabricates results: unavailable
 * scorers surface errors, every decision is journaled, and probabilities are
 * labeled INFERRED with their evidence attached.
 */

export interface GateOutcome {
  proceed: boolean;
  reasons: string[];
  decisions: DecisionSet;
}

export interface ModelChoice {
  id: string;
  criteria: string;
  keywords?: string[];
}

export interface ModelRouterConfig {
  choices: ModelChoice[];
  /** Confidence floor: below it the router returns 'fallback' instead of guessing. */
  minConfidence?: number;
  fallback?: string;
}

export class SystemOneHarness {
  constructor(
    private readonly engine: DecisionEngine,
    private readonly scorer: Scorer,
  ) {}

  /**
   * Gate an agent loop: evaluate all questions; `proceed` is true only when
   * every noul question crosses its threshold (default 0.5). Reasons record
   * each contribution — the gate is auditable after the fact.
   */
  async gate(state: string, questions: QuestionRequest[], opts: { threshold?: number; preferred?: string } = {}): Promise<GateOutcome> {
    const threshold = opts.threshold ?? 0.5;
    const decisions = await this.engine.decide(state, questions, opts.preferred);
    const reasons: string[] = [];
    let proceed = true;
    for (const d of decisions.decisions) {
      if (d.answer.type === 'noul') {
        const yes = d.answer.noul >= threshold;
        reasons.push(`${d.name}: noul=${d.answer.noul} → ${yes ? 'pass' : 'block'} (confidence ${d.answer.confidence})`);
        if (!yes) proceed = false;
      } else {
        reasons.push(`${d.name}: ${d.kind} decision recorded (no gate semantics)`);
      }
    }
    return { proceed, reasons, decisions };
  }

  /**
   * Model-routing middleware (Jev's ModelRouterMiddleware, portable):
   * choose fast vs powerful models from task criteria without an LLM call.
   * Below the confidence floor, returns the configured fallback honestly.
   */
  async routeModel(state: string, config: ModelRouterConfig, opts: { preferred?: string } = {}): Promise<{ model: string; confidence: number; usedFallback: boolean }> {
    const minConfidence = config.minConfidence ?? 0.35;
    const decision = await this.engine.route(
      state,
      config.choices.map((c) => ({ id: c.id, description: c.criteria, keywords: c.keywords })),
      opts.preferred,
    );
    if (decision.confidence < minConfidence) {
      return {
        model: config.fallback ?? decision.target,
        confidence: decision.confidence,
        usedFallback: config.fallback !== undefined && config.fallback !== decision.target,
      };
    }
    return { model: decision.target, confidence: decision.confidence, usedFallback: false };
  }

  /** Raw access for callers composing their own loop policies. */
  async decide(state: string, questions: QuestionRequest[], preferred?: string): Promise<DecisionSet> {
    return this.engine.decide(state, questions, preferred);
  }

  /** Expose the resolved scorer (the harness reports what it actually used). */
  get activeScorer(): Scorer {
    return this.scorer;
  }
}
