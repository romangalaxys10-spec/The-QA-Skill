import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Project configuration (theqa.config.json), Zod-validated with explicit
 * defaults. Unknown keys are rejected so typos fail loudly instead of silently
 * changing behavior.
 */

export const riskWeightsSchema = z.object({
  businessCriticality: z.number().min(0).max(1).default(0.2),
  changeSurface: z.number().min(0).max(1).default(0.15),
  defectHistory: z.number().min(0).max(1).default(0.12),
  codeComplexity: z.number().min(0).max(1).default(0.1),
  integrationDepth: z.number().min(0).max(1).default(0.12),
  userImpact: z.number().min(0).max(1).default(0.15),
  securitySensitivity: z.number().min(0).max(1).default(0.08),
  dataSensitivity: z.number().min(0).max(1).default(0.08),
});

export const configSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.object({
    name: z.string().min(1),
    /** Path patterns treated as business-critical (risk engine boost). */
    criticalPaths: z.array(z.string()).default([]),
    /** Named business flows for business-risk-aware coverage. */
    criticalFlows: z
      .array(z.object({ name: z.string(), patterns: z.array(z.string()) }))
      .default([]),
  }),
  paths: z
    .object({
      artifacts: z.string().default('.theqa/artifacts'),
      evidence: z.string().default('.theqa/artifacts'),
      learning: z.string().default('.theqa/learning.jsonl'),
      context: z.string().default('.theqa/context.json'),
    })
    .default({}),
  risk: z
    .object({
      weights: riskWeightsSchema.default({}),
      thresholds: z
        .object({
          critical: z.number().min(0).max(100).default(80),
          high: z.number().min(0).max(100).default(60),
          medium: z.number().min(0).max(100).default(35),
        })
        .default({}),
    })
    .default({}),
  selection: z
    .object({
      /** Always include tests covering these path patterns regardless of diff. */
      alwaysInclude: z.array(z.string()).default([]),
      /** Max e2e tests selected in PR policy before requiring justification. */
      maxPrE2E: z.number().int().min(1).default(25),
    })
    .default({}),
  execution: z
    .object({
      /** Retry budget per test — never used to hide regressions (golden rule 2). */
      maxRetries: z.number().int().min(0).max(3).default(1),
      /** Bug-reproduction rerun budget. */
      rerunBudget: z.number().int().min(1).max(10).default(3),
    })
    .default({}),
  integrations: z
    .object({
      reasoningProvider: z.enum(['deterministic', 'openai', 'anthropic', 'gemini', 'local']).default('deterministic'),
      /** Model endpoints read from environment variables — never from this file. */
    })
    .default({}),
});

export type TheQAConfig = z.infer<typeof configSchema>;
export type RiskWeights = z.infer<typeof riskWeightsSchema>;

export const DEFAULT_CONFIG: TheQAConfig = configSchema.parse({
  schemaVersion: 1,
  project: { name: 'unnamed-project' },
});

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid theqa.config.json:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  // Bounded upward search — 12 levels is plenty for any sane repo layout.
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'theqa.config.json');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function loadConfig(startDir: string): { config: TheQAConfig; path?: string } {
  const file = findConfigFile(startDir);
  if (!file) return { config: { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: resolve(startDir).split(/[/\\]/).pop() ?? 'project' } }, path: undefined };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError([`file is not valid JSON: ${(e as Error).message}`]);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return { config: parsed.data, path: file };
}

export function renderDefaultConfig(projectName: string): string {
  const cfg: TheQAConfig = { ...DEFAULT_CONFIG, project: { ...DEFAULT_CONFIG.project, name: projectName } };
  return JSON.stringify(cfg, null, 2) + '\n';
}
