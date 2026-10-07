import {
  buildContext,
  currentBranch,
  currentCommit,
  discover as discoverRepository,
  loadConfig,
} from '@the-qa-skill/core';
import type { DiscoveryResult, QAContext, StackInfo, TheQAConfig } from '@the-qa-skill/core';

/**
 * DiscoveryAgent — the eyes of the platform.
 *
 * Wraps the core deterministic discovery engine (stack detection + test
 * inventory) and turns the raw result into a validated QAContext:
 *   - `application` derives from the detected StackInfo;
 *   - `existingTests` maps the discovered test files into the context model;
 *   - `knownFlakes` starts empty (flake intelligence lives in the learning
 *     store and is attached by callers that have history);
 *   - `provenance` carries the commit/branch observed during `discover()` so
 *     every downstream conclusion can be traced to a repository state.
 */
export class DiscoveryAgent {
  /** The resolved configuration (explicit option or loaded from theqa.config.json). */
  public readonly config: TheQAConfig;
  private commit?: string;
  private branch?: string;

  constructor(
    private readonly root: string,
    opts: { config?: TheQAConfig } = {},
  ) {
    this.config = opts.config ?? loadConfig(root).config;
  }

  /** Run core discovery and remember the repository state for provenance. */
  async discover(): Promise<DiscoveryResult> {
    const result = discoverRepository(this.root);
    this.commit = await currentCommit(this.root);
    this.branch = await currentBranch(this.root);
    return result;
  }

  /**
   * Build the validated QAContext from a discovery result. Synchronous by
   * contract; provenance commit/branch were captured during `discover()`.
   */
  buildContext(discovery: DiscoveryResult): QAContext {
    const stack: StackInfo = discovery.stack;
    return buildContext({
      generatedAt: new Date().toISOString(),
      root: discovery.root,
      application: {
        type: applicationType(stack),
        framework: stack.framework,
        language: stack.language,
      },
      existingTests: discovery.testFiles.map((f) => ({
        testId: f.filePath,
        name: f.filePath.split('/').pop() ?? f.filePath,
        filePath: f.filePath,
        layer: f.layer,
        framework: f.framework,
        covers: [],
      })),
      knownFlakes: [],
      provenance: {
        discovery: 'core.discover',
        commit: this.commit,
        branch: this.branch,
      },
    });
  }
}

/**
 * Application-type classification from stack signals — documented and
 * deterministic: a detected web framework → 'web-app'; a workspace →
 * 'monorepo'; any known language → 'library'; otherwise 'unknown'.
 */
function applicationType(stack: StackInfo): string {
  if (stack.framework !== undefined) return 'web-app';
  if (stack.monorepo) return 'monorepo';
  if (stack.language !== 'unknown') return 'library';
  return 'unknown';
}
