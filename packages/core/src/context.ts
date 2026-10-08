import { z } from 'zod';
import type { RiskAssessment, SelectionResult } from './types.js';

/**
 * The QA Context Model — the shared language between all sub-agents.
 * Zod-validated on construction and on every load from disk; agents never
 * pass unvalidated payloads across boundaries.
 */

export const changeAreaSchema = z.enum(['ui', 'api', 'db', 'auth', 'payment', 'config', 'test', 'docs', 'infra', 'unknown']);

export const changedFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  area: changeAreaSchema,
  language: z.string(),
  symbols: z.array(z.string()),
});

export const requirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Acceptance criteria text or structured refs. */
  criteria: z.array(z.string()).default([]),
  source: z.string().optional(),
  priority: z.enum(['must', 'should', 'could']).default('should'),
  status: z.enum(['draft', 'agreed', 'implemented', 'verified']).default('draft'),
});

export const existingTestSchema = z.object({
  testId: z.string(),
  name: z.string(),
  filePath: z.string(),
  layer: z.enum(['unit', 'integration', 'api', 'e2e', 'visual', 'a11y', 'performance', 'security', 'contract', 'manual']),
  framework: z.string(),
  covers: z.array(z.string()).default([]),
  avgDurationMs: z.number().optional(),
  flakeScore: z.number().optional(),
});

export const knownDefectSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Paths historically implicated in this defect. */
  paths: z.array(z.string()).default([]),
  status: z.enum(['open', 'fixed', 'regressed']).default('open'),
  severity: z.enum(['blocker', 'critical', 'major', 'minor']).default('major'),
});

export const environmentSchema = z.object({
  name: z.string(),
  kind: z.enum(['local', 'ci', 'staging', 'production']),
  baseUrl: z.string().optional(),
  reachable: z.boolean().default(false),
  notes: z.string().optional(),
});

export const qualityGateSchema = z.object({
  minWeightedCoverage: z.number().min(0).max(100).default(60),
  maxCriticalFlakes: z.number().int().min(0).default(0),
  blockOnRealRegression: z.boolean().default(true),
  maxUnknownTriage: z.number().int().min(0).default(2),
});

export const qaContextSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: z.string(),
  root: z.string(),
  application: z.object({
    type: z.string(),
    framework: z.string().optional(),
    language: z.string(),
  }),
  risk: z
    .object({
      overall: z.number().min(0).max(100),
      tier: z.enum(['critical', 'high', 'medium', 'low']),
      areas: z.array(changeAreaSchema),
      assessment: z.unknown().optional(),
    })
    .optional(),
  requirements: z.array(requirementSchema).default([]),
  changedFiles: z.array(changedFileSchema).default([]),
  affectedFeatures: z.array(z.string()).default([]),
  existingTests: z.array(existingTestSchema).default([]),
  coverage: z
    .object({
      weightedCoverage: z.number().optional(),
      fileCoverage: z.number().optional(),
      gaps: z.array(z.string()).default([]),
    })
    .optional(),
  knownFlakes: z.array(z.object({ testId: z.string(), score: z.number() })).default([]),
  knownDefects: z.array(knownDefectSchema).default([]),
  environments: z.array(environmentSchema).default([]),
  dependencies: z.array(z.object({ name: z.string(), version: z.string(), kind: z.enum(['runtime', 'dev', 'peer']) })).default([]),
  testData: z
    .object({
      strategy: z.enum(['factories', 'fixtures', 'inline', 'recorded', 'none']).default('none'),
      seeds: z.array(z.string()).default([]),
      maskedFields: z.array(z.string()).default([]),
    })
    .default({ strategy: 'none', seeds: [], maskedFields: [] }),
  qualityGates: qualityGateSchema.default({}),
  /** Free-form provenance so consumers know how this context was built. */
  provenance: z
    .object({
      discovery: z.string().default('unknown'),
      commit: z.string().optional(),
      branch: z.string().optional(),
      range: z.string().optional(),
    })
    .default({ discovery: 'unknown' }),
  /** Extension slot — validated as JSON object, consumers own their keys. */
  extensions: z.record(z.unknown()).default({}),
});

export type QAContext = z.infer<typeof qaContextSchema>;
export type QAContextInput = z.input<typeof qaContextSchema>;

export class ContextValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`QAContext validation failed:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ContextValidationError';
  }
}

export function buildContext(input: QAContextInput): QAContext {
  const parsed = qaContextSchema.safeParse(input);
  if (!parsed.success) {
    throw new ContextValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return parsed.data;
}

/** Attach risk + selection results to a context immutably. */
export function withRisk(ctx: QAContext, assessment: RiskAssessment): QAContext {
  const areas = [...new Set(ctx.changedFiles.map((f) => f.area))];
  return {
    ...ctx,
    risk: {
      overall: assessment.score,
      tier: assessment.tier,
      areas,
      assessment,
    },
  };
}

export function withSelection(ctx: QAContext, selection: SelectionResult): QAContext {
  const features = [
    ...new Set(
      selection.selected
        .flatMap((s) => s.reasons.map((r) => r.split(' ')[0]))
        .filter((f): f is string => Boolean(f)),
    ),
  ];
  return { ...ctx, affectedFeatures: features, extensions: { ...ctx.extensions, selection } };
}

/** Serialize to disk-ready JSON (stable key order via schema shape). */
export function serializeContext(ctx: QAContext): string {
  return JSON.stringify(ctx, null, 2);
}

export function parseContext(json: string): QAContext {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new ContextValidationError([`not valid JSON: ${(e as Error).message}`]);
  }
  return buildContext(raw as QAContextInput);
}
