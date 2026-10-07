import { assertAuthorized, createLogger, defaultLearningPath, LifecycleTracker, loadConfig, LearningStore, selectTests, strongestLabel } from '@the-qa-skill/core';
import type {
  DiscoveryResult, Logger, PhaseRecord, ReleaseGateResult, SelectionResult, SimpleCluster, TestEvent,
  TestInventoryEntry, TheQAConfig, TriageResult, VerificationLabel,
} from '@the-qa-skill/core';
import { computeGate } from './gate.js';
import { routeIntent } from './route-intent.js';
import { DiscoveryAgent } from './agents/discovery.js';
import { ExecutionAgent } from './agents/execution.js';
import type { SpawnFn } from './agents/execution.js';
import { GenerationAgent } from './agents/generation.js';
import { HealingAgent } from './agents/healing.js';
import { RequirementsAgent } from './agents/requirements.js';
import { ReviewAgent, isTestShaped } from './agents/review.js';
import { RiskAgent } from './agents/risk.js';
import { TriageAgent } from './agents/triage.js';
import type { AssessResult } from './types.js';
import type { IntentKind, IntentStep, PipelineResult, RunOptions, ScaffoldResult, TestPlan } from './types.js';
import type { OrchestrationPolicyName, LifecyclePhase } from '@the-qa-skill/core';

/**
 * Orchestrator — walks the 12-phase QA lifecycle for a routed intent.
 *
 * Keyword routing (see routeIntent) picks the pipeline kind; every kind walks
 * ALL twelve phases because the tracker's precondition chain makes partial
 * walks impossible (EXECUTE requires VALIDATE, TRIAGE requires OBSERVE, …).
 * Kind-specific handlers decide what each phase actually does:
 *   - read-only intents ('discover', 'explain') force execution into dry-run;
 *   - 'generate' designs cases from extracted requirements and scaffolds
 *     intentionally-skipped test files;
 *   - GENERATE on other kinds records the coverage-gap verdict (the phase's
 *     work is a verified no-op when the selection covers the change set — the
 *     tracker still completes it because EXECUTE cannot run otherwise; the
 *     IntentStep AND the lifecycle record carry status 'skipped' with the
 *     reason);
 *   - HEAL (mid-pipeline) is completed in the tracker as a verified no-op when
 *     there is nothing to do — the core tracker requires 'complete' before
 *     VERIFY may begin — while the lifecycle record honestly reports
 *     'skipped' with the reason; LEARN (the tail phase) is skipped through
 *     the tracker itself.
 *
 * HIGH_RISK wiring: intents that mention production (`run production smoke`)
 * call core assertAuthorized('test.production') and throw without
 * `confirmRisk: true`.
 *
 * Error posture: a failing phase never aborts the pipeline. It is recorded as
 * blocked-then-resolved in the tracker (complete with the error kept in the
 * tracker note path) and the IntentStep carries status 'blocked' with the
 * message — downstream handlers degrade honestly instead of throwing.
 */

const DEFAULT_RANGE = 'HEAD~1';
/** Well-known empty-tree object id — lets first-commit repos (no HEAD~1) still produce a diff. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

interface PhaseWork {
  note?: string;
  /** Skip via tracker (only for phases that are legally skippable here). */
  skipReason?: string;
  /** Keep the tracker complete (mandatory preconditions) but mark the step skipped. */
  stepSkipped?: boolean;
}

/** Mutable per-run state shared across phase handlers. */
interface RunState {
  discovery?: DiscoveryResult;
  requirements: import('@the-qa-skill/core').QAContext['requirements'];
  risk?: AssessResult;
  selection?: SelectionResult;
  plan2?: TestPlan;
  scaffoldResults: ScaffoldResult[];
  quality?: import('@the-qa-skill/core').TestQualityReport[];
  events: TestEvent[];
  triage: TriageResult[];
  clusters: SimpleCluster[];
  gate?: ReleaseGateResult;
  executedDryRun: boolean;
}

export class Orchestrator {
  private readonly root: string;
  private readonly config: TheQAConfig;
  private readonly logger: Logger;
  private readonly discoveryAgent: DiscoveryAgent;
  private readonly requirementsAgent: RequirementsAgent;
  private readonly riskAgent: RiskAgent;
  private readonly generationAgent: GenerationAgent;
  private readonly reviewAgent: ReviewAgent;
  private readonly executionAgent: ExecutionAgent;
  private readonly triageAgent: TriageAgent;
  private readonly healingAgent: HealingAgent;

  constructor(
    root: string,
    opts: { config?: TheQAConfig; spawner?: SpawnFn; logger?: Logger } = {},
  ) {
    this.root = root;
    this.config = opts.config ?? loadConfig(root).config;
    this.logger = opts.logger ?? createLogger({ prefix: 'orchestrator' });
    this.discoveryAgent = new DiscoveryAgent(root, { config: this.config });
    this.requirementsAgent = new RequirementsAgent(root);
    this.riskAgent = new RiskAgent(root, { config: this.config });
    this.generationAgent = new GenerationAgent(root, { config: this.config });
    this.reviewAgent = new ReviewAgent(root);
    this.executionAgent = new ExecutionAgent(root, { config: this.config, spawner: opts.spawner });
    this.triageAgent = new TriageAgent(root, { learning: new LearningStore(defaultLearningPath(root)) });
    this.healingAgent = new HealingAgent(root, { learning: new LearningStore(defaultLearningPath(root)) });
  }

  /** Route the intent text and run its lifecycle pipeline. */
  async runIntent(intentText: string, opts: RunOptions = {}): Promise<PipelineResult> {
    // HIGH_RISK gate: production-flavored intents are executed only with
    // explicit confirmation (core safe-automation policy).
    if (/\bproduction\b|\bprod[\s-]?(smoke|test|suite|run)\b/i.test(intentText)) {
      assertAuthorized('test.production', { confirmRisk: opts.confirmRisk });
    }

    const intent = routeIntent(intentText);
    const kind = intent.kind;
    const policy: OrchestrationPolicyName = opts.policy ?? defaultPolicyFor(kind);
    const range = opts.range ?? DEFAULT_RANGE;
    const dryRun = opts.dryRun ?? false;

    if (!opts.json) {
      this.logger.info(`intent "${intentText.trim().slice(0, 60)}" → ${kind} (${intent.rationale})`);
      this.logger.info(`policy=${policy} range=${range} dryRun=${String(dryRun)}`);
    }

    const tracker = new LifecycleTracker();
    const steps: IntentStep[] = [];
    const lifecycleRecords: PhaseRecord[] = [];
    const state: RunState = {
      requirements: [],
      scaffoldResults: [],
      events: [],
      triage: [],
      clusters: [],
      executedDryRun: dryRun,
    };

    const runPhase = async (phase: LifecyclePhase, action: string, work: () => Promise<PhaseWork>): Promise<void> => {
      tracker.begin(phase);
      const step: IntentStep = { phase, action, status: 'done' };
      try {
        const workResult = await work();
        if (workResult.skipReason !== undefined) {
          // Tail phases with nothing to do: the core tracker records the skip
          // itself (nothing downstream depends on them being 'complete').
          const record = tracker.skip(phase, workResult.skipReason);
          lifecycleRecords.push(record);
          step.status = 'skipped';
          step.note = workResult.skipReason;
        } else {
          const record = tracker.complete(phase);
          if (workResult.stepSkipped === true) {
            // Verified no-op mid-pipeline: the tracker needed 'complete' for
            // downstream preconditions, but the honest record is 'skipped'.
            lifecycleRecords.push({ ...record, status: 'skipped', note: workResult.note ?? 'phase work was a verified no-op' });
            step.status = 'skipped';
          } else {
            lifecycleRecords.push(record);
          }
          if (workResult.note !== undefined) step.note = workResult.note;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // blocked → resolved keeps the walk alive; the step records the error.
        tracker.block(phase, message);
        const record = tracker.complete(phase);
        lifecycleRecords.push({ ...record, status: 'blocked', note: message });
        step.status = 'blocked';
        step.note = message;
      }
      steps.push(step);
      if (!opts.json) this.logger.info(`${phase}: ${step.status}${step.note ? ` — ${step.note}` : ''}`);
    };

    await runPhase('DISCOVER', 'discover repository stack and test inventory', async () => {
      const discovery = await this.discoveryAgent.discover();
      state.discovery = discovery;
      return {
        note: `${discovery.testFiles.length} test file(s), ${discovery.sourceFiles.length} source file(s), language ${discovery.stack.language}`,
      };
    });

    await runPhase('MODEL', 'build QA context and extract requirements', async () => {
      if (!state.discovery) throw new Error('discovery result unavailable');
      state.requirements = this.requirementsAgent.extract();
      this.discoveryAgent.buildContext(state.discovery); // validated context build (context model sanity)
      return { note: `${state.requirements.length} requirement(s) extracted; QA context model validated` };
    });

    await runPhase('PLAN', 'assess change-set risk and select tests', async () => {
      let assessed: AssessResult;
      try {
        assessed = await this.riskAgent.assess(range);
      } catch (err) {
        if (range !== DEFAULT_RANGE) throw err;
        // First-commit repositories have no HEAD~1 — diff against the empty tree instead.
        assessed = await this.riskAgent.assess(EMPTY_TREE);
      }
      state.risk = assessed;

      const inventory: TestInventoryEntry[] = (state.discovery?.testFiles ?? []).map((f) => ({
        testId: f.filePath,
        name: f.filePath.split('/').pop() ?? f.filePath,
        filePath: f.filePath,
        layer: f.layer,
        framework: f.framework,
        covers: [],
      }));
      state.selection = selectTests(assessed.changedFiles, inventory, assessed.routing, {
        alwaysInclude: this.config.selection.alwaysInclude,
        maxPrE2E: this.config.selection.maxPrE2E,
        policy,
      });

      if (kind === 'generate') {
        const withCriteria = state.requirements.find((r) => r.criteria.length > 0);
        if (withCriteria) {
          state.plan2 = this.generationAgent.plan({
            name: withCriteria.title,
            acceptanceCriteria: withCriteria.criteria.slice(0, 10),
          });
        }
      }
      return {
        note: `risk ${assessed.assessment.score}/100 (${assessed.assessment.tier}); ${state.selection.summary}`,
      };
    });

    await runPhase('GENERATE', kind === 'generate' ? 'design and scaffold tests from the specification' : 'check coverage gaps', async () => {
      if (kind === 'generate' && state.plan2) {
        const outDir = `${this.root.replace(/[/\\]+$/, '')}/.theqa/generated`;
        state.scaffoldResults = this.generationAgent.scaffold(state.plan2, outDir, { dryRun, force: false });
        const created = state.scaffoldResults.filter((r) => r.action === 'created').length;
        const skipped = state.scaffoldResults.filter((r) => r.action === 'skipped').length;
        const planned = state.scaffoldResults.filter((r) => r.action === 'dry-run').length;
        return {
          note: dryRun
            ? `${planned} scaffold(s) planned (dry-run, nothing written)`
            : `${created} created, ${skipped} skipped (existing files are never overwritten without force)`,
        };
      }
      const substantive = (state.risk?.changedFiles ?? []).filter((f) => f.area !== 'docs' && f.area !== 'test');
      const hasGap = substantive.length > 0 && (state.selection?.selected.length ?? 0) === 0;
      if (hasGap) {
        return {
          note: 'coverage gap: no inventory test covers the change set — run "generate tests for <feature>" to design cases',
        };
      }
      return {
        stepSkipped: true,
        note: 'no coverage gaps: generation not required (selection covers the change set or the change is docs/test-only)',
      };
    });

    await runPhase('VALIDATE', 'validate plan, selection, and test quality', async () => {
      if (state.plan2) {
        const invalid = state.plan2.cases.filter((c) => c.rationale.length === 0 || c.given.length === 0 || c.when.length === 0 || c.then.length === 0);
        if (invalid.length > 0) throw new Error(`${invalid.length} designed case(s) missing rationale or Given/When/Then contract`);
        const createdPaths = state.scaffoldResults.filter((r) => r.action === 'created').map((r) => r.path);
        if (createdPaths.length > 0) {
          state.quality = await this.reviewAgent.review(createdPaths);
        }
        return {
          note: `validated ${state.plan2.cases.length} designed case(s) — all carry rationale + GWT contracts${state.quality ? `; scaffold quality avg ${avgScore(state.quality)}/100 (skipped scaffolds are recorded test debt)` : ''}`,
        };
      }
      const changedTestFiles = (state.risk?.changedFiles ?? []).filter((f) => isTestShaped(f.path)).map((f) => f.path);
      if (changedTestFiles.length > 0) {
        state.quality = await this.reviewAgent.review(changedTestFiles);
        return { note: `reviewed ${changedTestFiles.length} changed test file(s): avg quality ${avgScore(state.quality)}/100` };
      }
      return {
        note: (state.selection?.selected.length ?? 0) > 0
          ? `selection validated: ${state.selection?.selected.length} test(s), all with recorded reasons`
          : 'no tests selected — proceeding with an honest empty execution set',
      };
    });

    await runPhase('EXECUTE', 'run the planned suites', async () => {
      const forceDryRun = kind === 'discover' || kind === 'explain';
      const effectiveDryRun = dryRun || forceDryRun;
      state.executedDryRun = effectiveDryRun;
      const outcome = await this.executionAgent.execute(state.selection ?? null, {
        policy,
        dryRun: effectiveDryRun,
        environment: 'local',
      });
      state.events = outcome.events;
      return {
        note: effectiveDryRun
          ? `dry-run: ${outcome.plannedCommands.length} command(s) planned, none executed`
          : `${outcome.events.length} event(s) from ${outcome.plannedCommands.length} command(s); evidence bundles: ${outcome.bundles.length}`,
      };
    });

    await runPhase('OBSERVE', 'collect test events and failure evidence', async () => {
      const failures = state.events.filter((e) => e.status === 'failed' || e.status === 'timedout');
      return {
        note: state.executedDryRun
          ? 'dry-run: no events to observe'
          : `observed ${state.events.length} event(s): ${failures.length} failure(s), ${state.events.length - failures.length} other`,
      };
    });

    await runPhase('TRIAGE', 'classify failures into the 12 categories', async () => {
      const failedEvents = state.events.filter((e) => e.status === 'failed' || e.status === 'timedout');
      if (failedEvents.length === 0) {
        return { note: 'no failures to triage (0 failed events)' };
      }
      const changedPaths = (state.risk?.changedFiles ?? []).map((f) => f.path);
      const records = failedEventsToRecords(failedEvents, state.selection ?? null, changedPaths);
      state.triage = this.triageAgent.triage(records, { relevantChangedFiles: changedPaths });
      state.clusters = this.triageAgent.clusters(records);
      const top = topCategory(state.triage);
      return { note: `${state.triage.length} failure(s) triaged into ${state.clusters.length} cluster(s); dominant category: ${top}` };
    });

    await runPhase('HEAL', 'propose and apply high-tier healing', async () => {
      // No healing engine in the default pipeline fabricates code patches:
      // proposals require observed selector evidence from an evidence bundle.
      // Absent that evidence, healing is an honestly-recorded verified no-op
      // (the tracker completes HEAL because VERIFY depends on it; the step and
      // lifecycle record carry status 'skipped' with this reason).
      return {
        stepSkipped: true,
        note:
          'no healing proposals available: triage produced no candidate with observed selector evidence; healing without evidence is forbidden',
      };
    });

    await runPhase('VERIFY', 'evaluate the release gate', async () => {
      const gate = computeGate({
        riskAssessments: state.risk ? [state.risk.assessment] : [],
        triageResults: state.triage,
        flakeAssessments: [],
        coverage: undefined,
        failedRealRegressions: state.triage.filter((t) => t.category === 'REAL_REGRESSION').length,
        openUnknownCategories: state.triage.filter((t) => t.category === 'UNKNOWN').length,
        criticalFlakeCount: 0,
        evidenceComplete: state.events.length > 0 && !state.executedDryRun,
        environment: 'local',
      });
      state.gate = gate;
      return { note: `gate verdict ${gate.verdict}: ${gate.reasons[0] ?? 'no reasons recorded'}` };
    });

    await runPhase('MEASURE', 'aggregate run measurements', async () => {
      const selected = state.selection?.selected.length ?? 0;
      return {
        note: `measured: risk ${state.risk?.assessment.score ?? 'n/a'}, selected ${selected}, events ${state.events.length}, triaged ${state.triage.length}, gate ${state.gate?.verdict ?? 'n/a'}`,
      };
    });

    await runPhase('LEARN', 'record lessons in the learning store', async () => {
      if (state.triage.length === 0) {
        return { skipReason: 'no lessons to record: no failures or feedback were produced by this run' };
      }
      return {
        note: `${state.triage.length} failure record(s) held by the learning store (appended during triage) for failure-density learning`,
      };
    });

    const labels: VerificationLabel[] = [
      state.risk?.assessment.label ?? 'NOT_VERIFIED',
      state.selection?.label ?? 'NOT_VERIFIED',
      state.plan2?.label ?? 'NOT_VERIFIED',
      state.gate?.label ?? 'NOT_VERIFIED',
      ...(state.quality?.map((q) => q.label) ?? []),
      ...state.triage.map((t) => t.label),
      state.events.length > 0 ? 'OBSERVED' : state.executedDryRun ? 'NOT_RUN' : 'NOT_VERIFIED',
    ];

    const result: PipelineResult = {
      intent: intentText,
      plan: steps,
      lifecycle: lifecycleRecords,
      risk: state.risk?.assessment,
      selection: state.selection,
      plan2: state.plan2,
      ...(state.quality !== undefined ? { quality: state.quality } : {}),
      triage: state.triage,
      clusters: state.clusters,
      gate: state.gate,
      events: state.events,
      label: strongestLabel(labels),
    };
    if (!opts.json) this.logger.info(`pipeline complete: label ${result.label}, gate ${result.gate?.verdict ?? 'n/a'}`);
    return result;
  }
}

/** Default policy per intent kind. */
function defaultPolicyFor(kind: IntentKind): OrchestrationPolicyName {
  if (kind === 'nightly') return 'nightly';
  if (kind === 'release') return 'release';
  return 'pr';
}

/** Average quality score across reports (0 when empty). */
function avgScore(reports: Array<{ score: number }>): number {
  if (reports.length === 0) return 0;
  return Math.round(reports.reduce((a, r) => a + r.score, 0) / reports.length);
}

/** Dominant triage category (deterministic: first by count, then alphabetically). */
function topCategory(results: TriageResult[]): string {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  let best = 'none';
  let bestCount = 0;
  for (const [category, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = category;
      bestCount = count;
    }
  }
  return best;
}

/** Group failed events per test into FailedTestRecords for the triage engine. */
function failedEventsToRecords(
  events: TestEvent[],
  selection: SelectionResult | null,
  changedPaths: string[],
): import('@the-qa-skill/core').FailedTestRecord[] {
  const byTest = new Map<string, TestEvent[]>();
  for (const ev of events) {
    const list = byTest.get(ev.testId);
    if (list) list.push(ev);
    else byTest.set(ev.testId, [ev]);
  }
  const layerOf = (testId: string) => selection?.selected.find((s) => s.test.testId === testId)?.test.layer ?? 'unit';
  const records: Array<import('@the-qa-skill/core').FailedTestRecord> = [];
  for (const [testId, group] of byTest) {
    const first = group[0];
    if (!first) continue;
    const attempts = group.map((ev) => ({
      status: ev.status,
      durationMs: ev.durationMs,
      timestamp: ev.timestamp,
      environment: ev.environment,
      ...(ev.browser !== undefined ? { browser: ev.browser } : {}),
      ...(ev.errorType !== undefined ? { errorType: ev.errorType } : {}),
      ...(ev.errorMessage !== undefined ? { errorMessage: ev.errorMessage } : {}),
      ...(ev.errorStack !== undefined ? { errorStack: ev.errorStack } : {}),
    }));
    records.push({
      testId,
      name: first.name,
      filePath: first.filePath ?? testId,
      layer: layerOf(testId),
      attempts,
      changedFiles: changedPaths,
      recentRuns: [],
    });
  }
  return records;
}
