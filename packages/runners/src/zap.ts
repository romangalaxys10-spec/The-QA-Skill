import type { TestEvent } from '@the-qa-skill/core';
import { listFiles, matchAny } from '@the-qa-skill/core';
import { buildEvent, extractJsonObject, freshRunId } from './runner.js';
import type { BuildCommandOptions, PlannedCommand, Runner } from './runner.js';
import type { RunnerContext } from './types.js';

/**
 * SECURITY FINDINGS ARE NOT REGRESSIONS — documented policy of this adapter.
 *
 * A ZAP alert says "this endpoint exposes X", not "commit C1 broke test T".
 * Therefore alerts map to TestEvents with status 'failed' and
 * failureCategory left UNSET (triage will classify UNKNOWN and route them to
 * security review) and names prefixed `[ZAP]`. They are never force-classified
 * as REAL_REGRESSION — that would corrupt the release gate's semantics.
 *
 * PLAN-ONLY: this repo NEVER executes live scans. ZAPRunner implements only
 * detection, planning ({@link ZAPRunner.buildPlan}) and output parsing. The
 * plan is a declarative object a human (or an approved pipeline stage) can
 * execute with the real ZAP binary outside this codebase.
 */
export interface ZapScanPlan {
  /** Absolute URL or host the scan would target. */
  target: string;
  /** Scan policies to load (e.g. ['baseline', 'api-scan']). */
  policies: string[];
  /** Whether an active (intrusive) scan would run. */
  activeScan: boolean;
  /** Whether the spider/crawl phase would run. */
  spider: boolean;
  /** Always 'plan-only' — this adapter never executes scans. */
  mode: 'plan-only';
  /** ISO timestamp of plan generation. */
  generatedAt: string;
  /** Human note about where execution is allowed to happen. */
  note: string;
}

export interface ZapPlanOptions {
  policies?: string[];
  activeScan?: boolean;
  spider?: boolean;
}

/** ZAP runner: plan + parse only. No scan execution exists in this repo. */
export class ZAPRunner implements Runner {
  readonly id = 'zap';
  readonly framework = 'zap';
  readonly planOnly = true;

  detect(root: string): boolean {
    try {
      const files = listFiles(root, { maxFiles: 5000 });
      return files.some((f) =>
        matchAny(f, ['zap*.{yaml,yml,json}', '.zap/**', '**/zap*.{yaml,yml,json}', 'zap/**', '**/zap/**']),
      );
    } catch {
      return false;
    }
  }

  /**
   * Build a declarative scan plan. Returning a plan is the adapter's ONLY
   * output; nothing here spawns processes or touches the network.
   */
  buildPlan(target: string, opts?: ZapPlanOptions): ZapScanPlan {
    return {
      target,
      policies: opts?.policies ?? ['baseline'],
      activeScan: opts?.activeScan ?? false,
      spider: opts?.spider ?? true,
      mode: 'plan-only',
      generatedAt: new Date().toISOString(),
      note: 'Plan only — execute ZAP externally with human approval; this repo never runs live scans.',
    };
  }

  buildCommand(_ctx: RunnerContext, _opts?: BuildCommandOptions): PlannedCommand {
    // Deliberate: there is no command to build. ZAP is executed outside this
    // repository; the executor will never spawn this runner.
    return { command: 'echo', args: ['zap is plan-only; no scan is executed by The-QA-Skill'], reporterHint: 'alerts-json' };
  }

  /**
   * Parse a ZAP alerts JSON document:
   *   { site: [ { '@name'?, alerts: [ { name, riskcode, url, description, ... } ] } ] }
   * Every alert becomes one TestEvent: status 'failed', name prefixed '[ZAP]',
   * errorType carrying the numeric risk code. `riskcode` values follow ZAP's
   * 0..3 scale (0 informational, 3 high).
   */
  parseOutput(raw: string, ctx: RunnerContext): TestEvent[] {
    const doc = extractJsonObject(raw) as ZapAlertsDocument | null;
    if (!doc || !Array.isArray(doc.site)) return [];
    const runId = freshRunId();
    const events: TestEvent[] = [];

    for (const site of doc.site) {
      for (const alert of site.alerts ?? []) {
        const name = `[ZAP] ${alert.name ?? '(unnamed alert)'}`;
        events.push(
          buildEvent({
            runId,
            ctx,
            framework: this.framework,
            filePath: alert.url ?? site['@name'] ?? 'zap/alerts.json',
            name,
            status: 'failed',
            durationMs: 0,
            errorType: `riskcode=${alert.riskcode ?? 'unknown'}`,
            errorMessage: alert.description ?? alert.name,
            errorStack: alert.solution ?? alert.otherinfo ?? alert.description,
          }),
        );
      }
    }
    return events;
  }
}

interface ZapAlert {
  name?: string;
  riskcode?: string;
  riskdesc?: string;
  url?: string;
  description?: string;
  solution?: string;
  otherinfo?: string;
}

interface ZapSite {
  '@name'?: string;
  alerts?: ZapAlert[];
}

interface ZapAlertsDocument {
  site?: ZapSite[];
}
