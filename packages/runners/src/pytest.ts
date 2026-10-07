import { join } from 'node:path';
import type { TestEvent, TestLayer } from '@the-qa-skill/core';
import { listFiles, matchAny } from '@the-qa-skill/core';
import { parseJUnitXml } from './junit.js';
import { buildEvent, freshRunId, readTextIfExists } from './runner.js';
import type { BuildCommandOptions, PlannedCommand, Runner } from './runner.js';
import type { RunnerContext } from './types.js';

/** Default artifacts directory when the executor does not provide one. */
export function defaultArtifactsDir(ctx: RunnerContext): string {
  return join(ctx.root, '.theqa', 'artifacts');
}

/**
 * Map a JUnit `classname` onto a pyramid layer (best effort, documented):
 * e2e/ui → 'e2e', integration → 'integration', api → 'api', performance →
 * 'performance', everything else → 'unit'. Used to build FailedTestRecords
 * downstream (TestEvent itself has no layer field).
 */
export function pytestLayerFromClassName(className: string): TestLayer {
  const c = className.toLowerCase();
  if (c.includes('e2e') || c.includes('ui') || c.includes('browser')) return 'e2e';
  if (c.includes('integration')) return 'integration';
  if (c.includes('api') || c.includes('http')) return 'api';
  if (c.includes('perf') || c.includes('load')) return 'performance';
  return 'unit';
}

/**
 * Derive a stable relative file path from a pytest `classname`. Pytest writes
 * either a dotted module (`tests.unit.test_orders`) or a plain path; both map
 * deterministically onto `<path>.py`. Missing classnames degrade honestly to
 * `pytest/unknown.py`.
 */
export function pytestFilePathFromClassName(className: string): string {
  const trimmed = className.trim();
  if (trimmed.length === 0) return 'pytest/unknown.py';
  if (trimmed.includes('/')) return trimmed.replace(/\\/g, '/').replace(/\.py$/, '') + '.py';
  return trimmed.replace(/\./g, '/') + '.py';
}

/**
 * pytest adapter.
 *
 * Detection: `pytest.ini`, `conftest.py`, `tox.ini`, `pyproject.toml` or
 * `requirements*.txt` mentioning pytest.
 * Command: `python -m pytest --junitxml=<artifacts>/pytest-junit.xml -q`.
 *
 * IMPORTANT CONTRACT: pytest reports through the JUnit XML FILE it writes —
 * not stdout. `buildCommand` points `--junitxml` into the artifacts directory
 * and {@link PytestRunner.readResult} loads that file after the run; the
 * executor passes its content as `raw` to {@link PytestRunner.parseOutput}.
 * So when calling parseOutput directly, pass the JUnit XML content, not
 * console output.
 */
export class PytestRunner implements Runner {
  readonly id = 'pytest';
  readonly framework = 'pytest';

  detect(root: string): boolean {
    const markers = readTextIfExists(join(root, 'pytest.ini'));
    if (markers !== null && /pytest/i.test(markers)) return true;
    const conftest = readTextIfExists(join(root, 'conftest.py'));
    if (conftest !== null) return true;
    try {
      const files = listFiles(root, { maxFiles: 5000 });
      const named = files.filter((f) => matchAny(f, ['pytest.ini', 'conftest.py', 'tox.ini', 'pyproject.toml', 'requirements*.txt']));
      for (const f of named) {
        const content = readTextIfExists(join(root, f));
        if (content !== null && /pytest/i.test(content)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  buildCommand(ctx: RunnerContext, opts?: BuildCommandOptions): PlannedCommand {
    const artifactsDir = opts?.artifactsDir ?? defaultArtifactsDir(ctx);
    return {
      command: 'python',
      args: ['-m', 'pytest', `--junitxml=${join(artifactsDir, 'pytest-junit.xml')}`, '-q'],
      reporterHint: 'junit-file',
    };
  }

  /** The executor calls this instead of parsing stdout: pytest reports via file. */
  readResult(ctx: RunnerContext, artifactsDir: string): string | null {
    return readTextIfExists(join(artifactsDir, 'pytest-junit.xml'));
  }

  /**
   * Parse JUnit XML CONTENT (see the class contract) and map every case onto a
   * core TestEvent. `classname` feeds the file path and, through
   * {@link pytestLayerFromClassName}, the downstream layer classification.
   */
  parseOutput(raw: string, ctx: RunnerContext): TestEvent[] {
    const suites = parseJUnitXml(raw);
    const runId = freshRunId();
    const events: TestEvent[] = [];
    for (const suite of suites) {
      for (const caseItem of suite.cases) {
        const filePath = pytestFilePathFromClassName(caseItem.className);
        const isFailure = caseItem.status === 'failed';
        events.push(
          buildEvent({
            runId,
            ctx,
            framework: this.framework,
            filePath,
            name: caseItem.name,
            status: caseItem.status,
            durationMs: caseItem.durationMs,
            errorType: isFailure ? (caseItem.errorType ?? 'AssertionError') : undefined,
            errorMessage: caseItem.errorMessage,
            errorStack: caseItem.errorStack,
          }),
        );
      }
    }
    return events;
  }
}
