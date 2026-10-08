/**
 * MCP tool implementations — the 11 QA tools. Each handler takes the raw
 * `arguments` object from tools/call plus a ToolContext (server root, logger)
 * and returns a JSON-serializable payload. Validation failures throw ToolError
 * (converted to an isError tool result by the server); tool payloads are
 * secret-scrubbed at the server boundary before they leave the process.
 *
 * Agents (RiskAgent, GenerationAgent, …) are loaded lazily per call. Tools
 * with an exact deterministic core equivalent fall back to it when the agents
 * package is unavailable; agent-only tools fail with the graceful
 * 'agents package unavailable' error.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import {
  analyzeDiff,
  assessRisk,
  buildProposal,
  churnHotspots,
  classifyAction,
  classifyFailure,
  classifyRouting,
  clusterFailures,
  computeCoverage,
  discover,
  inventoryTests,
  listFiles,
  scoreFlake,
  selectTests,
} from '@the-qa-skill/core';
import type {
  AttemptRecord, ChangeRouting, ChangedFile, DiscoveryResult, ExecutionStatus,
  FailureCategory, FailureCluster, FailedTestRecord, FlakeInput, HealCandidate, HealingProposal,
  ReleaseGateInput, RiskAssessment, SelectionResult, SimpleCluster, TestInventoryEntry, TestLayer,
  TriageResult, Logger,
} from '@the-qa-skill/core';
import type { FeatureSpec } from '@the-qa-skill/agents';
import { AGENTS_UNAVAILABLE_MESSAGE, constructAgent, requireAgent, type TriageAgentContext, type RiskAgentAssessment } from './agents.js';
import { KnownFalseRegistry, verifyClaimAsync } from '@the-qa-skill/core';
import type { ProbeSpec } from '@the-qa-skill/core';
import { DecisionEngine, ScorerRegistry, defaultTargets } from '@the-qa-skill/xroutelm';
import { ToolError, errorMessage } from './errors.js';
import { computeGate, normalizeReviewResult, renderQualityReport } from './report.js';
import { HEALING_KINDS, ORCHESTRATION_POLICIES, REPORT_AUDIENCES, type HealingKindArg, type ReportAudience } from './tools.js';

/** Context handed to every tool handler. */
export interface ToolContext {
  /** Absolute default project root (server `root` option or process.cwd()). */
  serverRoot: string;
  logger: Logger;
}

/** Raw tool arguments as received from tools/call. */
export type ToolArgs = Record<string, unknown>;

/** A tool handler: sync or async; returns a JSON-serializable payload. */
export type ToolHandler = (args: ToolArgs, ctx: ToolContext) => unknown | Promise<unknown>;

const TEST_LAYERS: ReadonlySet<string> = new Set(['unit', 'integration', 'api', 'e2e', 'visual', 'a11y', 'performance', 'security', 'contract', 'manual']);
const EXECUTION_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'skipped', 'timedout', 'not_run']);
const RECENT_RUN_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'skipped']);
const MAX_EVIDENCE_BUNDLES = 10;

/** All 11 tool handlers, keyed by tool name (mirrors TOOLS order). */
export const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {
  discover_project: handleDiscoverProject,
  analyze_risk: handleAnalyzeRisk,
  list_relevant_tests: handleListRelevantTests,
  generate_tests: handleGenerateTests,
  run_tests: handleRunTests,
  get_failure_evidence: handleGetFailureEvidence,
  triage_failure: handleTriageFailure,
  propose_test_heal: handleProposeTestHeal,
  analyze_flake: handleAnalyzeFlake,
  generate_quality_report: handleGenerateQualityReport,
  evaluate_release: handleEvaluateRelease,
  verify_claim: handleVerifyClaim,
  route_task: handleRouteTask,
};

// ---------------------------------------------------------------------------
// 1. discover_project
// ---------------------------------------------------------------------------

/** Detect stack + test inventory for a project (deterministic, READ_ONLY). */
async function handleDiscoverProject(args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const root = optRoot(args, ctx);
  const result: DiscoveryResult = discover(root);
  const estimatedCases = result.testFiles.reduce((sum, t) => sum + t.estimatedCases, 0);
  const frameworks = result.stack.testFrameworks;
  const summary = [
    `${result.stack.language}${result.stack.framework ? ` + ${result.stack.framework}` : ''} project`,
    `${result.testFiles.length} test file(s)${estimatedCases > 0 ? ` (~${estimatedCases} estimated cases)` : ''}`,
    `${result.sourceFiles.length} source file(s)`,
    frameworks.length > 0 ? `test frameworks: ${frameworks.join(', ')}` : 'no test framework detected',
  ].join(' — ');
  return {
    root: result.root,
    summary,
    stack: result.stack,
    testFileCount: result.testFiles.length,
    estimatedCases,
    sourceFileCount: result.sourceFiles.length,
    configFiles: result.configFiles,
    testFiles: result.testFiles,
    label: result.label,
  };
}

// ---------------------------------------------------------------------------
// 2. analyze_risk
// ---------------------------------------------------------------------------

/** Risk assessment for a git range: RiskAgent when available, core engine otherwise. */
async function handleAnalyzeRisk(args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const root = optRoot(args, ctx);
  const range = optString(args, 'range') ?? 'HEAD~1..HEAD';
  const agent = await constructAgent('RiskAgent', root);
  if (agent !== null) {
    try {
      const raw = await agent.assess(range);
      const normalized = normalizeRiskBundle(raw);
      if (normalized !== null) return { engine: 'RiskAgent', range, ...normalized };
    } catch (err) {
      ctx.logger.debug(`RiskAgent.assess failed — falling back to the core risk engine: ${errorMessage(err)}`);
    }
  } else {
    ctx.logger.debug('agents package unavailable — analyze_risk using the core risk engine');
  }
  const diff = await analyzeDiff(root, range);
  const routing = classifyRouting(diff.files);
  const defectHistory = await churnHotspots(root);
  const assessment: RiskAssessment = assessRisk({
    changedFiles: diff.files,
    addedLines: diff.addedLines,
    removedLines: diff.removedLines,
    defectHistory,
    boundarySignals: routing.boundarySignals,
  });
  return { engine: 'core-fallback', range, assessment, changedFiles: diff.files, routing };
}

function normalizeRiskBundle(raw: unknown): RiskAgentAssessment | null {
  if (!isRecord(raw)) return null;
  const assessment = raw['assessment'];
  if (
    !isRecord(assessment) ||
    typeof assessment['score'] !== 'number' ||
    typeof assessment['tier'] !== 'string' ||
    typeof assessment['explanation'] !== 'string'
  ) {
    return null;
  }
  const changedFiles = Array.isArray(raw['changedFiles']) ? (raw['changedFiles'] as ChangedFile[]) : [];
  const routing = isRecord(raw['routing']) ? (raw['routing'] as unknown as ChangeRouting) : undefined;
  const label = typeof raw['label'] === 'string' ? raw['label'] : undefined;
  return { assessment: assessment as unknown as RiskAssessment, changedFiles, routing, label };
}

// ---------------------------------------------------------------------------
// 3. list_relevant_tests
// ---------------------------------------------------------------------------

/** Smallest high-confidence test set for the range (pure core, READ_ONLY). */
async function handleListRelevantTests(args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const root = optRoot(args, ctx);
  const range = optString(args, 'range') ?? 'HEAD~1..HEAD';
  const diff = await analyzeDiff(root, range);
  const routing = classifyRouting(diff.files);
  const selection = buildSelection(root, diff.files, routing);
  return {
    range,
    changedFileCount: diff.files.length,
    selection,
  };
}

/**
 * Build the SelectionResult: inventory every test file, compute its transitive
 * import-closure coverage, then run the documented selection algorithm.
 *
 * computeCoverage() resolves imports against process.cwd(), so the synchronous
 * inventory step runs with cwd temporarily set to the project root. The MCP
 * server processes lines sequentially, so this scoped chdir cannot interleave
 * with other tool calls.
 */
function buildSelection(root: string, changedFiles: ChangedFile[], routing: ChangeRouting): SelectionResult {
  return withCwd(root, () => {
    const files = listFiles(root);
    const allFiles = new Set(files);
    const inventory: TestInventoryEntry[] = inventoryTests(root, files).map((t) => ({
      testId: t.filePath,
      name: t.filePath,
      filePath: t.filePath,
      layer: t.layer,
      framework: t.framework,
      covers: computeCoverage(t.filePath, allFiles),
    }));
    return selectTests(changedFiles, inventory, routing, { policy: 'pr' });
  });
}

/** Run a synchronous computation with process.cwd() pinned to `dir`. */
function withCwd<T>(dir: string, fn: () => T): T {
  const prev = process.cwd();
  if (resolvePath(prev) === resolvePath(dir)) return fn();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

// ---------------------------------------------------------------------------
// 4. generate_tests
// ---------------------------------------------------------------------------

/** Plan tests for a feature (GenerationAgent). PLANNING ONLY — never writes. */
async function handleGenerateTests(args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const root = optRoot(args, ctx);
  const feature = normalizeFeature(args['feature']);
  const agent = await requireAgent('GenerationAgent', root);
  const plan = await agent.plan(feature as unknown as FeatureSpec);
  return {
    planningOnly: true,
    note: 'TestPlan is a proposal — nothing was written to disk. Review before applying anything.',
    feature,
    plan,
  };
}

/** Validated feature description accepted by generate_tests. */
interface FeatureInput {
  name: string;
  description?: string;
  acceptanceCriteria: string[];
  businessRules?: string[];
  area?: string;
}

function normalizeFeature(raw: unknown): FeatureInput {
  if (!isRecord(raw)) throw new ToolError('Invalid params: "feature" must be an object with name and acceptanceCriteria');
  const name = raw['name'];
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new ToolError('Invalid params: "feature.name" must be a non-empty string');
  }
  const criteriaRaw = raw['acceptanceCriteria'];
  if (!Array.isArray(criteriaRaw)) {
    throw new ToolError('Invalid params: "feature.acceptanceCriteria" must be an array of strings');
  }
  const acceptanceCriteria = criteriaRaw.map((c, i) => {
    if (typeof c !== 'string') throw new ToolError(`Invalid params: "feature.acceptanceCriteria[${i}]" must be a string`);
    return c;
  });
  const out: FeatureInput = { name, acceptanceCriteria };
  if (raw['description'] !== undefined) {
    if (typeof raw['description'] !== 'string') throw new ToolError('Invalid params: "feature.description" must be a string');
    out.description = raw['description'];
  }
  if (raw['businessRules'] !== undefined) {
    out.businessRules = stringArray(raw['businessRules'], 'feature.businessRules');
  }
  if (raw['area'] !== undefined) {
    if (typeof raw['area'] !== 'string') throw new ToolError('Invalid params: "feature.area" must be a string');
    out.area = raw['area'];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. run_tests
// ---------------------------------------------------------------------------

/**
 * Execute suites via ExecutionAgent. dryRun defaults to TRUE: an MCP caller
 * must explicitly pass dryRun:false to spawn real test processes. Per
 * ACTION_POLICIES the 'test' action is READ_ONLY (no tracked sources are
 * modified), so no --confirm-risk flag is required — the opt-in dryRun flag
 * IS the consent gate, and that is documented here and in the tool description.
 */
async function handleRunTests(args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const root = optRoot(args, ctx);
  const policy = optString(args, 'policy') ?? 'pr';
  if (!(ORCHESTRATION_POLICIES as readonly string[]).includes(policy)) {
    throw new ToolError(`Invalid params: "policy" must be one of ${ORCHESTRATION_POLICIES.join(', ')}`);
  }
  const dryRun = optBoolean(args, 'dryRun', true);
  const agent = await requireAgent('ExecutionAgent', root);
  const safety = classifyAction('test');
  const outcome = await agent.execute(null, { policy: policy as (typeof ORCHESTRATION_POLICIES)[number], dryRun });
  return {
    policy,
    dryRun,
    safety: {
      action: safety.action,
      safetyClass: safety.safety,
      rationale: safety.rationale,
      note: dryRun
        ? 'dryRun: true — planned only, nothing was executed.'
        : "dryRun: false — execution was explicitly requested by the caller; 'test' is READ_ONLY per ACTION_POLICIES but spawns real processes.",
    },
    outcome,
  };
}

// ---------------------------------------------------------------------------
// 6. get_failure_evidence
// ---------------------------------------------------------------------------

/**
 * List evidence bundles (run-<date>/<testId> layout) and return parsed
 * metadata.json for each, most recent first, capped at 10. Refuses paths
 * outside the project root; a targeted testId query with no readable
 * metadata is an explicit error.
 */
function handleGetFailureEvidence(args: ToolArgs, ctx: ToolContext): unknown {
  const serverRoot = ctx.serverRoot;
  const artifactsRootArg = requireString(args, 'artifactsRoot');
  const artifactsRoot = resolvePath(serverRoot, artifactsRootArg);
  if (artifactsRoot !== serverRoot && !artifactsRoot.startsWith(serverRoot + sep)) {
    throw new ToolError(
      `artifactsRoot "${artifactsRootArg}" resolves outside the project root (${serverRoot}) — refusing to read files outside the project`,
    );
  }
  if (!existsSync(artifactsRoot)) {
    throw new ToolError(`artifacts root not found: "${artifactsRootArg}" (resolved ${artifactsRoot})`);
  }
  if (!statSync(artifactsRoot).isDirectory()) {
    throw new ToolError(`artifacts root is not a directory: "${artifactsRootArg}"`);
  }
  const runDate = optString(args, 'runDate');
  const testId = optString(args, 'testId');

  const runDirs = readdirSync(artifactsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
    .map((e) => e.name)
    .filter((name) => !runDate || name === `run-${runDate}` || name.startsWith(`run-${runDate}`))
    .sort((a, b) => b.localeCompare(a)); // run-<ISO-date> names sort chronologically

  interface FoundBundle {
    run: string;
    bundle: string;
    path: string;
    metadata: Record<string, unknown>;
  }
  const bundles: FoundBundle[] = [];
  const missing: string[] = [];

  for (const run of runDirs) {
    const runPath = join(artifactsRoot, run);
    let bundleDirs: string[];
    try {
      bundleDirs = readdirSync(runPath, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      continue; // unreadable run dir — skip, listing is best-effort
    }
    const filtered = testId
      ? bundleDirs.filter((n) => n.startsWith(testId) || n.startsWith(sanitizeBundleName(testId)))
      : bundleDirs;
    for (const bundle of filtered) {
      const bundlePath = join(runPath, bundle);
      const metaPath = join(bundlePath, 'metadata.json');
      let metadata: Record<string, unknown> | undefined;
      if (existsSync(metaPath)) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(metaPath, 'utf8'));
          if (isRecord(parsed)) metadata = parsed;
        } catch {
          metadata = undefined; // corrupt metadata counts as missing
        }
      }
      const rel = relative(artifactsRoot, bundlePath).split(sep).join('/');
      if (metadata !== undefined) bundles.push({ run, bundle, path: rel, metadata });
      else missing.push(rel);
    }
  }

  bundles.sort((a, b) => {
    const ta = String(a.metadata['timestamp'] ?? a.run);
    const tb = String(b.metadata['timestamp'] ?? b.run);
    return tb.localeCompare(ta);
  });
  const limited = bundles.slice(0, MAX_EVIDENCE_BUNDLES);

  if (testId !== undefined && limited.length === 0) {
    const detail = missing.length > 0
      ? ` — ${missing.length} matching bundle(s) had no readable metadata.json`
      : ' — no run-* directories matched';
    throw new ToolError(
      `no evidence bundle found for testId "${testId}" under "${artifactsRootArg}"${detail}`,
    );
  }

  return {
    artifactsRoot: relative(serverRoot, artifactsRoot).split(sep).join('/'),
    scannedRunDirectories: runDirs.length,
    count: limited.length,
    truncated: bundles.length > limited.length,
    bundles: limited,
    missingMetadata: missing.slice(0, MAX_EVIDENCE_BUNDLES),
  };
}

/** Mirror of the core evidence bundle naming: unsafe chars become '_'. */
function sanitizeBundleName(testId: string): string {
  return testId.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

// ---------------------------------------------------------------------------
// 7. triage_failure
// ---------------------------------------------------------------------------

/**
 * Classify failed tests with the 12-category deterministic decision table and
 * cluster them by normalized signature. TriageAgent is used when available;
 * otherwise the identical core engines (classifyFailure + clusterFailures) run.
 */
async function handleTriageFailure(args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const root = optRoot(args, ctx);
  const failuresRaw = args['failures'];
  if (!Array.isArray(failuresRaw) || failuresRaw.length === 0) {
    throw new ToolError('Invalid params: "failures" must be a non-empty array of failed test records');
  }
  const failures = failuresRaw.map((f, i) => normalizeFailedTestRecord(f, i));
  const selectorChangedInDiff = optBoolean(args, 'selectorChangedInDiff', false);
  const changedFiles = args['changedFiles'] === undefined ? [] : stringArray(args['changedFiles'], 'changedFiles');

  const agent = await constructAgent('TriageAgent', root);
  if (agent !== null) {
    try {
      const allChanged = changedFiles.length > 0
        ? changedFiles
        : [...new Set(failures.flatMap((f) => f.changedFiles))];
      // coversChangedCode is deliberately NOT forced here: TriageAgent derives
      // it per failure (relevant changed files ∩ failure.changedFiles), which
      // is exactly the documented rule; forcing an aggregate would misclassify
      // failures with no relevant changes inside a mixed batch.
      const agentCtx: TriageAgentContext = {
        relevantChangedFiles: allChanged,
        ...(selectorChangedInDiff ? { selectorChangedInDiff: true } : {}),
      };
      const results = normalizeTriageResults(await agent.triage(failures, agentCtx));
      if (results !== null) {
        const simpleClusters = typeof agent.clusters === 'function' ? agent.clusters(failures) : [];
        return {
          via: 'TriageAgent',
          results,
          clusters: toFailureClusters(simpleClusters, results),
        };
      }
    } catch (err) {
      ctx.logger.debug(`TriageAgent.triage failed — falling back to the core triage engine: ${errorMessage(err)}`);
    }
  } else {
    ctx.logger.debug('agents package unavailable — triage_failure using the core triage engine');
  }

  const results: TriageResult[] = failures.map((f) =>
    classifyFailure(f, {
      coversChangedCode: f.changedFiles.length > 0,
      relevantChangedFiles: f.changedFiles,
      selectorChangedInDiff,
    }),
  );
  const clusters = toFailureClusters(
    clusterFailures(
      failures.map(toRawFailure),
      { threshold: 0.6 },
    ),
    results,
  );
  return { via: 'core-fallback', results, clusters };
}

function normalizeTriageResults(raw: unknown): TriageResult[] | null {
  if (Array.isArray(raw)) {
    if (raw.every((r) => isRecord(r) && typeof r['testId'] === 'string' && typeof r['category'] === 'string')) {
      return raw as unknown as TriageResult[];
    }
    return null;
  }
  if (isRecord(raw)) {
    const resultsRaw = raw['results'] ?? raw['triageResults'];
    if (Array.isArray(resultsRaw) && resultsRaw.every((r) => isRecord(r) && typeof r['testId'] === 'string')) {
      return resultsRaw as unknown as TriageResult[];
    }
  }
  return null;
}

function normalizeFailedTestRecord(raw: unknown, index: number): FailedTestRecord {
  if (!isRecord(raw)) throw new ToolError(`Invalid params: failures[${index}] must be an object`);
  const testId = raw['testId'];
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new ToolError(`Invalid params: failures[${index}].testId must be a non-empty string`);
  }
  const attemptsRaw = Array.isArray(raw['attempts']) ? raw['attempts'] : [];
  const attempts = attemptsRaw.map((a) => normalizeAttempt(a));
  const layerRaw = raw['layer'];
  const layer: TestLayer = typeof layerRaw === 'string' && TEST_LAYERS.has(layerRaw) ? (layerRaw as TestLayer) : 'unit';
  const recentRunsRaw = Array.isArray(raw['recentRuns']) ? raw['recentRuns'] : [];
  const record: FailedTestRecord = {
    testId,
    name: typeof raw['name'] === 'string' ? raw['name'] : testId,
    filePath: typeof raw['filePath'] === 'string' ? raw['filePath'] : '',
    layer,
    attempts,
    changedFiles: raw['changedFiles'] === undefined ? [] : stringArray(raw['changedFiles'], `failures[${index}].changedFiles`),
    recentRuns: recentRunsRaw.filter((r): r is 'passed' | 'failed' | 'skipped' => typeof r === 'string' && RECENT_RUN_STATUSES.has(r)),
  };
  if (typeof raw['networkVerified'] === 'boolean') record.networkVerified = raw['networkVerified'];
  if (typeof raw['domVerified'] === 'boolean') record.domVerified = raw['domVerified'];
  if (Array.isArray(raw['tags'])) record.tags = raw['tags'].filter((t): t is string => typeof t === 'string');
  return record;
}

function normalizeAttempt(raw: unknown): AttemptRecord {
  const base: AttemptRecord = {
    status: 'failed',
    durationMs: 0,
    timestamp: new Date().toISOString(),
    environment: 'unknown',
  };
  if (!isRecord(raw)) return base;
  if (typeof raw['status'] === 'string' && EXECUTION_STATUSES.has(raw['status'])) {
    base.status = raw['status'] as ExecutionStatus;
  }
  if (typeof raw['durationMs'] === 'number' && Number.isFinite(raw['durationMs'])) base.durationMs = raw['durationMs'];
  if (typeof raw['timestamp'] === 'string' && raw['timestamp'].length > 0) base.timestamp = raw['timestamp'];
  if (typeof raw['environment'] === 'string' && raw['environment'].length > 0) base.environment = raw['environment'];
  if (typeof raw['browser'] === 'string') base.browser = raw['browser'];
  if (typeof raw['errorType'] === 'string') base.errorType = raw['errorType'];
  if (typeof raw['errorMessage'] === 'string') base.errorMessage = raw['errorMessage'];
  if (typeof raw['errorStack'] === 'string') base.errorStack = raw['errorStack'];
  return base;
}

function toRawFailure(record: FailedTestRecord): {
  testId: string; name: string; filePath: string;
  errorType?: string; errorMessage?: string; errorStack?: string;
  browser?: string; environment?: string;
} {
  const failedAttempt = record.attempts.find((a) => a.status === 'failed' || a.status === 'timedout');
  return {
    testId: record.testId,
    name: record.name,
    filePath: record.filePath,
    errorType: failedAttempt?.errorType,
    errorMessage: failedAttempt?.errorMessage,
    errorStack: failedAttempt?.errorStack,
    browser: failedAttempt?.browser,
    environment: failedAttempt?.environment,
  };
}

/** Promote core SimpleClusters into the documented FailureCluster contract. */
function toFailureClusters(simple: SimpleCluster[], results: TriageResult[]): FailureCluster[] {
  return simple.map((cluster, index) => {
    const memberCategories = results.filter((r) => cluster.testIds.includes(r.testId)).map((r) => r.category);
    const counts = new Map<FailureCategory, number>();
    for (const c of memberCategories) counts.set(c, (counts.get(c) ?? 0) + 1);
    let dominant = memberCategories[0] ?? 'UNKNOWN';
    let dominantCount = 0;
    for (const [category, count] of counts) {
      if (count > dominantCount) {
        dominant = category;
        dominantCount = count;
      }
    }
    return {
      id: cluster.id,
      signature: cluster.signature,
      testIds: cluster.testIds,
      category: dominant,
      isPrimary: index === 0,
      cascadesTo: [],
      representativeError: cluster.representative.normalizedMessage,
    };
  });
}

// ---------------------------------------------------------------------------
// 8. propose_test_heal
// ---------------------------------------------------------------------------

/** Propose a healing change (HealingAgent / core tiers). PROPOSALS ONLY. */
async function handleProposeTestHeal(args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const root = optRoot(args, ctx);
  const candidate = normalizeHealCandidate(args['candidate']);
  let proposal: HealingProposal;
  let via: string;
  const agent = await constructAgent('HealingAgent', root);
  if (agent !== null) {
    try {
      proposal = await agent.propose(candidate);
      via = 'HealingAgent';
    } catch (err) {
      ctx.logger.debug(`HealingAgent.propose failed — falling back to the core healing tiers: ${errorMessage(err)}`);
      proposal = buildProposal(candidate);
      via = 'core-fallback';
    }
  } else {
    ctx.logger.debug('agents package unavailable — propose_test_heal using the core healing tiers');
    proposal = buildProposal(candidate);
    via = 'core-fallback';
  }
  return {
    via,
    proposalsOnly: true,
    applicability:
      'Nothing was applied. HIGH tier may be applied after all policy checks pass; MEDIUM and LOW require human review; any golden-rule violation forbids application.',
    proposal,
  };
}

function normalizeHealCandidate(raw: unknown): HealCandidate {
  if (!isRecord(raw)) {
    throw new ToolError('Invalid params: "candidate" must be an object with testId, filePath, kind, description, currentCode, proposedCode');
  }
  for (const key of ['testId', 'filePath', 'description', 'currentCode', 'proposedCode'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).length === 0) {
      throw new ToolError(`Invalid params: "candidate.${key}" must be a non-empty string`);
    }
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !(HEALING_KINDS as readonly string[]).includes(kind)) {
    throw new ToolError(`Invalid params: "candidate.kind" must be one of ${HEALING_KINDS.join(', ')}`);
  }
  return {
    testId: raw['testId'] as string,
    filePath: raw['filePath'] as string,
    kind: kind as HealingKindArg,
    description: raw['description'] as string,
    currentCode: raw['currentCode'] as string,
    proposedCode: raw['proposedCode'] as string,
    observedInTarget: typeof raw['observedInTarget'] === 'string' ? raw['observedInTarget'] : undefined,
    signals: raw['signals'] === undefined ? [] : stringArray(raw['signals'], 'candidate.signals'),
  };
}

// ---------------------------------------------------------------------------
// 9. analyze_flake
// ---------------------------------------------------------------------------

/** Flake scoring with the documented formula (pure core, READ_ONLY). */
function handleAnalyzeFlake(args: ToolArgs): unknown {
  const input = normalizeFlakeInput(args['input']);
  return scoreFlake(input);
}

function normalizeFlakeInput(raw: unknown): FlakeInput {
  if (!isRecord(raw)) throw new ToolError('Invalid params: "input" must be an object with testId and outcomes');
  const testId = raw['testId'];
  if (typeof testId !== 'string' || testId.length === 0) {
    throw new ToolError('Invalid params: "input.testId" must be a non-empty string');
  }
  const outcomesRaw = raw['outcomes'];
  if (!Array.isArray(outcomesRaw)) throw new ToolError('Invalid params: "input.outcomes" must be an array');
  const outcomes = outcomesRaw.map((o, i): FlakeInput['outcomes'][number] => {
    if (!isRecord(o)) throw new ToolError(`Invalid params: "input.outcomes[${i}]" must be an object`);
    const status = o['status'];
    if (status !== 'passed' && status !== 'failed') {
      throw new ToolError(`Invalid params: "input.outcomes[${i}].status" must be "passed" or "failed"`);
    }
    return {
      status,
      timestamp: typeof o['timestamp'] === 'string' && o['timestamp'].length > 0
        ? o['timestamp']
        : new Date().toISOString(),
      environment: typeof o['environment'] === 'string' ? o['environment'] : undefined,
      browser: typeof o['browser'] === 'string' ? o['browser'] : undefined,
    };
  });
  const retryRaw = raw['retryCount'];
  const retryCount = typeof retryRaw === 'number' && Number.isFinite(retryRaw) && retryRaw >= 0 ? retryRaw : 0;
  return {
    testId,
    outcomes,
    retryCount,
    environments: raw['environments'] === undefined ? [] : stringArray(raw['environments'], 'input.environments'),
    browsers: raw['browsers'] === undefined ? [] : stringArray(raw['browsers'], 'input.browsers'),
  };
}

// ---------------------------------------------------------------------------
// 10. generate_quality_report
// ---------------------------------------------------------------------------

/**
 * Verification-labeled quality report for one audience. ReviewAgent data is
 * used when available; the deterministic discovery engine always fills the
 * inventory section so the report is never empty in an honest way.
 */
async function handleGenerateQualityReport(args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const root = optRoot(args, ctx);
  const audienceRaw = optString(args, 'audience') ?? 'engineering';
  if (!(REPORT_AUDIENCES as readonly string[]).includes(audienceRaw)) {
    throw new ToolError(`Invalid params: "audience" must be one of ${REPORT_AUDIENCES.join(', ')}`);
  }
  const audience = audienceRaw as ReportAudience;
  let review = normalizeReviewResult(undefined);
  let via = 'core-fallback';
  const agent = await constructAgent('ReviewAgent', root);
  if (agent !== null) {
    try {
      review = normalizeReviewResult(await agent.review());
      via = 'ReviewAgent';
    } catch (err) {
      ctx.logger.debug(`ReviewAgent.review failed — assembling the report from core data: ${errorMessage(err)}`);
    }
  } else {
    ctx.logger.debug('agents package unavailable — generate_quality_report assembled from core discovery data');
  }
  const discovery = review.discovery ?? discover(root);
  const data = { ...review, discovery };
  const markdown = renderQualityReport(audience, data);
  return {
    audience,
    root,
    via,
    markdown,
    data: {
      testFileCount: discovery.testFiles.length,
      sourceFileCount: discovery.sourceFiles.length,
      suiteHealthScore: data.suiteHealth?.score,
      weightedCoverage: data.coverage?.weightedCoverage,
      qualityReportCount: data.qualityReports?.length ?? 0,
      flakeAssessmentCount: data.flakeAssessments?.length ?? 0,
      triageResultCount: data.triageResults?.length ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 11. evaluate_release
// ---------------------------------------------------------------------------

/** Deterministic release gate over the supplied evidence (documented rules). */
function handleEvaluateRelease(args: ToolArgs): unknown {
  const raw = args['gateInput'];
  if (raw !== undefined && !isRecord(raw)) {
    throw new ToolError('Invalid params: "gateInput" must be an object');
  }
  return computeGate(raw as Partial<ReleaseGateInput> | undefined);
}

// ---------------------------------------------------------------------------
// 12. verify_claim (ground truth)
// ---------------------------------------------------------------------------

/** Deterministic claim verification with KNOWN_FALSE persistence. */
async function handleVerifyClaim(args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const root = optRoot(args, ctx);
  const claim = requireString(args, 'claim');
  const rawProbes = args['probes'];
  if (!Array.isArray(rawProbes) || rawProbes.length === 0) {
    throw new ToolError('Invalid params: "probes" must be a non-empty array of probe objects');
  }
  const probes: ProbeSpec[] = rawProbes.map((p, i) => {
    if (!isRecord(p)) throw new ToolError(`Invalid params: probes[${i}] must be an object`);
    const kind = p['kind'];
    if (typeof kind !== 'string') throw new ToolError(`Invalid params: probes[${i}].kind must be a string`);
    switch (kind) {
      case 'file_exists':
      case 'json_valid':
      case 'dir_exists':
        return { kind, path: String(p['path'] ?? '') };
      case 'file_contains':
      case 'file_not_contains':
        return { kind, path: String(p['path'] ?? ''), pattern: String(p['pattern'] ?? '') };
      case 'cmd_exit_zero':
        return { kind, command: String(p['command'] ?? '') };
      case 'git_ref_exists':
        return { kind, ref: String(p['ref'] ?? '') };
      default:
        throw new ToolError(`Invalid params: probes[${i}].kind "${kind}" is not a supported probe`);
    }
  });
  const repeat = optBoolean(args, 'repeat', false);
  const verdict = await verifyClaimAsync(claim, probes, { cwd: root, repeat });
  let knownFalseRecorded: string | null = null;
  if (verdict.status === 'REFUTED') {
    const registry = new KnownFalseRegistry(join(root, '.theqa', 'known-false.json'));
    knownFalseRecorded = registry.add(claim, 'refuted via MCP verify_claim', verdict.probes.find((p) => p.status === 'FAIL')?.observation ?? 'probe failed').hash;
  }
  return { verdict, knownFalseRecorded };
}

// ---------------------------------------------------------------------------
// 13. route_task (xRouteLM)
// ---------------------------------------------------------------------------

/** Route a task to the owning QA engine with the xRouteLM System One scorer. */
async function handleRouteTask(args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const root = optRoot(args, ctx);
  const task = requireString(args, 'task');
  const engine = new DecisionEngine(ScorerRegistry.withDefaults(), undefined);
  const decision = await engine.route(task, defaultTargets());
  ctx.logger.debug(`route_task → ${decision.target} (${decision.confidence})`);
  return { task, decision };
}

// ---------------------------------------------------------------------------
// Shared argument helpers
// ---------------------------------------------------------------------------

/** Resolve the effective project root: args.root ?? ctx.serverRoot. */
function optRoot(args: ToolArgs, ctx: ToolContext): string {
  const raw = args['root'];
  if (raw === undefined || raw === null || raw === '') return ctx.serverRoot;
  if (typeof raw !== 'string') throw new ToolError('Invalid params: "root" must be a string');
  return resolvePath(ctx.serverRoot, raw);
}

function optString(args: ToolArgs, key: string): string | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new ToolError(`Invalid params: "${key}" must be a string`);
  return raw;
}

function requireString(args: ToolArgs, key: string): string {
  const raw = args[key];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ToolError(`Invalid params: "${key}" must be a non-empty string`);
  }
  return raw;
}

function optBoolean(args: ToolArgs, key: string, fallback: boolean): boolean {
  const raw = args[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') throw new ToolError(`Invalid params: "${key}" must be a boolean`);
  return raw;
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) throw new ToolError(`Invalid params: "${key}" must be an array of strings`);
  return value.map((v, i) => {
    if (typeof v !== 'string') throw new ToolError(`Invalid params: "${key}[${i}]" must be a string`);
    return v;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Re-export so the server module imports only this module for handlers. */
export { AGENTS_UNAVAILABLE_MESSAGE };
