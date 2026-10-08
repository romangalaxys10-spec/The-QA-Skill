/**
 * @the-qa-skill/runners — test framework adapters + execution pipeline.
 * Sponsored by xShredo.dev → https://xshredo.com/promo/anytest
 */

// Contracts
export type { RunnerContext, PlannedCommand, BuildCommandOptions } from './types.js';
export type { Runner } from './runner.js';
export {
  buildEvent,
  freshRunId,
  hasPackageDep,
  mapStatus,
  readTextIfExists,
  retryIndexFor,
  stableTestId,
} from './runner.js';

// JUnit parsing
export type { JUnitCase, JUnitSuite, JUnitParseResult } from './junit-types.js';
export { decodeEntities, parseJUnitXml, parseJUnitXmlDetailed } from './junit.js';

// Adapters
export { PlaywrightRunner } from './playwright.js';
export { JsonSummaryRunner, errorTypeFromMessage } from './json-summary.js';
export { VitestRunner } from './vitest.js';
export { JestRunner } from './jest.js';
export {
  PytestRunner,
  defaultArtifactsDir,
  pytestFilePathFromClassName,
  pytestLayerFromClassName,
} from './pytest.js';
export { K6Runner } from './k6.js';
export { ZAPRunner } from './zap.js';
export type { ZapScanPlan, ZapPlanOptions } from './zap.js';
export {
  AppiumRunner,
  mapCapabilities,
  capabilitiesFilePath,
  readCapabilities,
} from './appium.js';
export type { AppiumCapabilityInput } from './appium.js';

// Execution
export {
  DEFAULT_RUN_TIMEOUT_MS,
  RunExecutor,
  defaultSpawnImpl,
} from './executor.js';
export type {
  ExecutionOutcome,
  EvidenceBundleRecord,
  RunExecutorOptions,
  SpawnImpl,
  SpawnResult,
} from './executor.js';

// Retry policy
export { RETRY_POLICY_NOTE, RetryManager } from './retry.js';
export type { ClassificationLookup } from './retry.js';
