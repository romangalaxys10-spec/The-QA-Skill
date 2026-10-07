import { join } from 'node:path';
import type { TestEvent } from '@the-qa-skill/core';
import { listFiles, matchAny } from '@the-qa-skill/core';
import { parseJUnitXml } from './junit.js';
import { buildEvent, freshRunId, hasPackageDep, readTextIfExists } from './runner.js';
import type { BuildCommandOptions, PlannedCommand, Runner } from './runner.js';
import type { RunnerContext } from './types.js';

/**
 * Mobile capability input — the platform-neutral description of the device/app
 * under test. Mapped onto W3C-compatible Appium capabilities by
 * {@link mapCapabilities}.
 */
export interface AppiumCapabilityInput {
  platformName: string;
  deviceName?: string;
  platformVersion?: string;
  /** Path or URL of the app package (IPA/APK). */
  app?: string;
  /** Automation backend (e.g. 'UiAutomator2', 'XCUITest'). */
  automationName?: string;
  /** Vendor-specific extras, passed through under `appium:options`. */
  extra?: Record<string, unknown>;
}

/**
 * Map the neutral capability input onto a W3C Appium capabilities object:
 * - `platformName` stays W3C-native;
 * - everything Appium-specific is namespaced with the `appium:` prefix
 *   (deviceName, app, automationName, platformVersion);
 * - `extra` entries are namespaced as `appium:<key>` so no vendor key ever
 *   leaks into the W3C namespace.
 */
export function mapCapabilities(input: AppiumCapabilityInput): Record<string, unknown> {
  const caps: Record<string, unknown> = {
    platformName: input.platformName,
  };
  if (input.deviceName !== undefined) caps['appium:deviceName'] = input.deviceName;
  if (input.platformVersion !== undefined) caps['appium:platformVersion'] = input.platformVersion;
  if (input.app !== undefined) caps['appium:app'] = input.app;
  if (input.automationName !== undefined) caps['appium:automationName'] = input.automationName;
  for (const [k, v] of Object.entries(input.extra ?? {})) {
    caps[`appium:${k}`] = v;
  }
  return caps;
}

/**
 * Appium adapter — the ADAPTER SURFACE for mobile testing.
 *
 * This class documents and implements the contract (capability mapping,
 * command construction via WebDriverIO's runner, JUnit result parsing) but it
 * does not install emulators, start Appium servers, or manage device farms.
 * Repositories wire real devices in their wdio.conf.js; this adapter parses
 * whatever that configuration produces.
 */
export class AppiumRunner implements Runner {
  readonly id = 'appium';
  readonly framework = 'appium';

  detect(root: string): boolean {
    if (hasPackageDep(root, ['appium', 'webdriverio', '@wdio/cli'])) return true;
    try {
      const files = listFiles(root, { maxFiles: 5000 });
      return files.some((f) =>
        matchAny(f, [
          'wdio.conf.{ts,mts,cts,js,mjs,cjs}',
          '**/wdio.conf.{ts,mts,cts,js,mjs,cjs}',
          'appium.config.{js,json}',
          '.appiumrc',
          'appium.yml',
        ]),
      );
    } catch {
      return false;
    }
  }

  buildCommand(_ctx: RunnerContext, _opts?: BuildCommandOptions): PlannedCommand {
    return { command: 'npx', args: ['wdio', 'run', 'wdio.conf.js'], reporterHint: 'junit-stdout' };
  }

  /**
   * Parse JUnit XML produced by the WebDriverIO runner (junit reporter) —
   * `classname` carries the spec file, `name` the full mobile test title.
   * `ctx.browser` (when present) is interpreted as the device identity.
   */
  parseOutput(raw: string, ctx: RunnerContext): TestEvent[] {
    const suites = parseJUnitXml(raw);
    const runId = freshRunId();
    const events: TestEvent[] = [];
    for (const suite of suites) {
      for (const caseItem of suite.cases) {
        const isFailure = caseItem.status === 'failed';
        events.push(
          buildEvent({
            runId,
            ctx,
            framework: this.framework,
            filePath: caseItem.className || suite.name || 'appium/unknown.spec.js',
            name: caseItem.name,
            status: caseItem.status,
            durationMs: caseItem.durationMs,
            device: ctx.browser,
            errorType: caseItem.errorType,
            errorMessage: caseItem.errorMessage,
            errorStack: caseItem.errorStack,
          }),
        );
      }
    }
    return events;
  }
}

/** Convenience helper used by orchestrators to persist a wdio capability file. */
export function capabilitiesFilePath(root: string): string {
  return join(root, 'wdio.capabilities.json');
}

/** Guarded read of the generated capability file (null when absent). */
export function readCapabilities(root: string): Record<string, unknown> | null {
  const raw = readTextIfExists(capabilitiesFilePath(root));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
