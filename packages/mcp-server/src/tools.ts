/**
 * MCP tool catalog — the 11 QA tools exposed by The-QA-Skill over stdio.
 * Each entry is a plain MCP Tool: name, description (which documents the
 * tool's safety posture), and a JSON-Schema inputSchema.
 */
import type { OrchestrationPolicyName } from '@the-qa-skill/core';

/** One MCP tool definition as returned by `tools/list`. */
export interface McpToolDefinition {
  name: string;
  description: string;
  /** JSON Schema (draft-07 style subset): always a top-level object. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/** Orchestration policies accepted by run_tests. */
export const ORCHESTRATION_POLICIES: readonly OrchestrationPolicyName[] = ['pr', 'pre_merge', 'nightly', 'release', 'post_deploy'];

/** Audiences accepted by generate_quality_report. */
export const REPORT_AUDIENCES = ['engineering', 'qa', 'leadership', 'executive'] as const;
export type ReportAudience = (typeof REPORT_AUDIENCES)[number];

/** Healing kinds accepted by propose_test_heal. */
export const HEALING_KINDS = ['selector', 'assertion', 'data', 'timing', 'locator_strategy'] as const;
export type HealingKindArg = (typeof HEALING_KINDS)[number];

const ROOT_PROP = {
  type: 'string',
  description: 'Project root to operate on (absolute, or relative to the server root). Defaults to the server root.',
} as const;

const RANGE_PROP = {
  type: 'string',
  description: "Git diff range to analyze, e.g. 'HEAD~1..HEAD' (default), 'main...HEAD', or a commit sha.",
} as const;

const noRequired: string[] = [];

/** The 11 tools, in catalog order. Exported for `tools/list` and tests. */
export const TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'discover_project',
    description:
      'Detect the project stack, QA configuration, and test inventory using deterministic file-presence signals. ' +
      'READ_ONLY: inspects the repository without writing. Returns a stack summary plus test/source/config file counts.',
    inputSchema: {
      type: 'object',
      properties: { root: ROOT_PROP },
      required: noRequired,
    },
  },
  {
    name: 'analyze_risk',
    description:
      'Assess change risk for a git range with the 8-factor risk engine (business criticality, change surface, defect ' +
      'history, code complexity, integration depth, user impact, security sensitivity, data sensitivity). ' +
      'READ_ONLY. Returns score 0-100, tier, factor contributions, changed files, routing hints, and a plain-language ' +
      'explanation; payment/auth/migration changes escalate documented tier floors.',
    inputSchema: {
      type: 'object',
      properties: { root: ROOT_PROP, range: RANGE_PROP },
      required: noRequired,
    },
  },
  {
    name: 'list_relevant_tests',
    description:
      'Select the smallest high-confidence test set for a change range: builds the transitive import-closure coverage ' +
      'map for every inventory test, maps the changed files onto it, then applies pyramid demotion, routing policy ' +
      '(payment/auth/migration/css-only), the PR e2e budget, and flake warnings. READ_ONLY. ' +
      'Returns a SelectionResult with per-test selection reasons; an empty selection means a coverage gap, not safety.',
    inputSchema: {
      type: 'object',
      properties: { root: ROOT_PROP, range: RANGE_PROP },
      required: noRequired,
    },
  },
  {
    name: 'generate_tests',
    description:
      'Plan tests for a feature from its acceptance criteria and business rules (GenerationAgent). ' +
      'SAFETY: planning only — this tool NEVER writes files. The returned TestPlan is a proposal that must be ' +
      'reviewed and applied deliberately by a human or an explicitly authorized step.',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_PROP,
        feature: {
          type: 'object',
          description: 'FeatureSpec: the feature to plan tests for.',
          properties: {
            name: { type: 'string', description: 'Feature name (required).' },
            description: { type: 'string', description: 'Short feature description.' },
            acceptanceCriteria: {
              type: 'array',
              items: { type: 'string' },
              description: 'Acceptance criteria as verifiable statements (required).',
            },
            businessRules: { type: 'array', items: { type: 'string' }, description: 'Business rules the tests must respect.' },
            area: { type: 'string', description: "Business area, e.g. 'payment', 'auth', 'api', 'ui'." },
          },
          required: ['name', 'acceptanceCriteria'],
        },
      },
      required: ['feature'],
    },
  },
  {
    name: 'run_tests',
    description:
      'Execute suites via ExecutionAgent under an orchestration policy. READ_ONLY per ACTION_POLICIES (executing tests ' +
      'does not modify tracked sources) but SIDE-EFFECTFUL — it spawns real test processes and may hit real services — ' +
      'therefore it is OPT-IN: dryRun defaults to true (plan only, no execution); pass dryRun:false explicitly to run.',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_PROP,
        policy: {
          type: 'string',
          enum: [...ORCHESTRATION_POLICIES],
          description: "Orchestration policy controlling aggressiveness. Default 'pr' keeps the set minimal.",
        },
        dryRun: {
          type: 'boolean',
          description: 'Default TRUE. Only an explicit dryRun:false actually executes tests.',
        },
      },
      required: noRequired,
    },
  },
  {
    name: 'get_failure_evidence',
    description:
      'List failure evidence bundles under <artifactsRoot>/run-<date>/<testId>/ and return each bundle metadata.json ' +
      'parsed. READ_ONLY. Returns at most 10 bundles, most recent first. SECURITY: artifactsRoot must resolve inside ' +
      'the project root; metadata contents are secret-scrubbed before they leave the server.',
    inputSchema: {
      type: 'object',
      properties: {
        artifactsRoot: {
          type: 'string',
          description: 'Evidence artifacts root (absolute, or relative to the server root), e.g. ".theqa/artifacts".',
        },
        runDate: {
          type: 'string',
          description: "Only run directories whose name equals or starts with 'run-' + this value, e.g. '2025-01-30'.",
        },
        testId: {
          type: 'string',
          description: "Only bundles whose directory name starts with this test id.",
        },
      },
      required: ['artifactsRoot'],
    },
  },
  {
    name: 'triage_failure',
    description:
      'Classify failed tests into the 12 documented categories (REAL_REGRESSION, TEST_DEFECT, FLAKE, ENVIRONMENT_FAILURE, ' +
      '...) with supporting/contradicting signals, confidence, root-cause hypothesis, and recommended action; failures ' +
      'with matching normalized signatures are clustered. Deterministic decision table; UNKNOWN is an honest outcome. ' +
      'READ_ONLY.',
    inputSchema: {
      type: 'object',
      properties: {
        failures: {
          type: 'array',
          items: { type: 'object' },
          description:
            'Non-empty array of FailedTestRecord: { testId, name, filePath, layer, attempts: [{status, durationMs, ' +
            'timestamp, environment, errorType?, errorMessage?}], changedFiles: string[], recentRuns: string[], ' +
            'networkVerified?, domVerified? }.',
        },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional change-set file paths (normalized relative); used as triage context.',
        },
        selectorChangedInDiff: {
          type: 'boolean',
          description: 'True when a selector/locator literal used by the failing tests appears in the product diff. Default false.',
        },
      },
      required: ['failures'],
    },
  },
  {
    name: 'propose_test_heal',
    description:
      'Propose a self-healing change for a broken test (kind: selector | assertion | data | timing | locator_strategy). ' +
      'SAFETY: PROPOSALS ONLY — never applies anything to the repository. The returned confidence tier governs ' +
      'applicability: HIGH may be applied after policy checks, MEDIUM and LOW always require human review; any ' +
      'golden-rule violation (weakened assertions, sleeps, skips, timeout raises) forbids application.',
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_PROP,
        candidate: {
          type: 'object',
          description: 'HealCandidate describing the broken test and the proposed fix.',
          properties: {
            testId: { type: 'string' },
            filePath: { type: 'string', description: 'Test file the heal targets.' },
            kind: { type: 'string', enum: [...HEALING_KINDS] },
            description: { type: 'string', description: 'What broke and what the proposal changes.' },
            currentCode: { type: 'string', description: 'Current (broken) test snippet.' },
            proposedCode: { type: 'string', description: 'Proposed replacement snippet.' },
            observedInTarget: { type: 'string', description: 'DOM snapshot/source evidence containing the proposed selector.' },
            signals: { type: 'array', items: { type: 'string' }, description: 'Free-text signals from triage.' },
          },
          required: ['testId', 'filePath', 'kind', 'description', 'currentCode', 'proposedCode'],
        },
      },
      required: ['candidate'],
    },
  },
  {
    name: 'analyze_flake',
    description:
      'Score a test for flakiness with the documented deterministic formula (fail rate 40%, retry signal 25%, ' +
      'intermittency 20%, env/browser spread 15%) producing verdict stable | suspect | flaky | critical_flaky with ' +
      'explicit reasons. READ_ONLY.',
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'object',
          description: 'FlakeInput.',
          properties: {
            testId: { type: 'string' },
            outcomes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['passed', 'failed'] },
                  timestamp: { type: 'string', description: 'ISO-8601; chronological, oldest first.' },
                  environment: { type: 'string' },
                  browser: { type: 'string' },
                },
                required: ['status', 'timestamp'],
              },
              description: 'Chronological attempt outcomes, oldest first.',
            },
            retryCount: { type: 'number', description: 'Retries needed across history.' },
            environments: { type: 'array', items: { type: 'string' }, description: 'Distinct environments the test failed on.' },
            browsers: { type: 'array', items: { type: 'string' }, description: 'Distinct browsers the test failed on.' },
          },
          required: ['testId', 'outcomes'],
        },
      },
      required: ['input'],
    },
  },
  {
    name: 'generate_quality_report',
    description:
      "Assemble a verification-labeled quality report for one audience (engineering | qa | leadership | executive) " +
      "from live platform data (review agent + deterministic engines). READ_ONLY. Never fabricates numbers — any " +
      "section without data states 'no data'.",
    inputSchema: {
      type: 'object',
      properties: {
        root: ROOT_PROP,
        audience: {
          type: 'string',
          enum: [...REPORT_AUDIENCES],
          description: "Report audience. Default 'engineering' (full detail); leadership/executive get condensed views.",
        },
      },
      required: noRequired,
    },
  },
  {
    name: 'evaluate_release',
    description:
      'Deterministic release quality gate over the evidence you supply. Documented rules: any failed real regression, ' +
      'or a triage result of REAL_REGRESSION with confidence >= 0.9, is a BLOCKED finding; more than 2 UNKNOWN triage ' +
      'results, any critical_flaky test, and risk-weighted coverage < 60 produce warnings; incomplete evidence ' +
      'downgrades a PASS to PASS_WITH_WARNINGS; empty input yields UNKNOWN (the gate never invents a verdict). ' +
      'Returns verdict, reasons, blockingFindings, and warnings. READ_ONLY.',
    inputSchema: {
      type: 'object',
      properties: {
        gateInput: {
          type: 'object',
          description: 'ReleaseGateInput — the evidence collected so far (risk assessments, triage results, flake assessments, coverage, counts).',
          properties: {
            riskAssessments: { type: 'array', items: { type: 'object' } },
            triageResults: { type: 'array', items: { type: 'object' } },
            flakeAssessments: { type: 'array', items: { type: 'object' } },
            coverage: { type: 'object', description: 'Optional CoverageReport with weightedCoverage 0..100.' },
            failedRealRegressions: { type: 'number', description: 'Count of confirmed real-regression failures.' },
            openUnknownCategories: { type: 'number', description: 'Count of triage results still UNKNOWN.' },
            criticalFlakeCount: { type: 'number', description: 'Count of critical_flaky tests.' },
            evidenceComplete: { type: 'boolean', description: 'True only when all expected evidence was collected.' },
            environment: { type: 'string', description: 'Environment the evidence was collected in, e.g. "ci".' },
          },
        },
      },
      required: ['gateInput'],
    },
  },
];

/** Tool lookup by name (built from TOOLS; used for dispatch validation). */
export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));
