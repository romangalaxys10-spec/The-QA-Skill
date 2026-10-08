import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredTestFile, DiscoveryResult, StackInfo, TestLayer } from '../types.js';
import { listFiles, matchAny } from '../util/glob.js';

/**
 * Stack detection + test inventory. Deterministic file-presence signals only.
 */

export function detectStack(root: string): StackInfo {
  const signals: string[] = [];
  let language = 'unknown';
  let framework: string | undefined;
  let packageManager: string | undefined;
  const testFrameworks: string[] = [];
  const ciSystems: string[] = [];

  const pkgPath = join(root, 'package.json');
  if (existsSync(pkgPath)) {
    signals.push('package.json present');
    language = 'typescript';
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        packageManager?: string;
      };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(deps, name);
      if (has('next')) { framework = 'next'; signals.push('next dependency'); }
      else if (has('react')) { framework = 'react'; signals.push('react dependency'); }
      else if (has('express')) { framework = 'express'; signals.push('express dependency'); }
      if (has('@playwright/test')) { testFrameworks.push('playwright'); signals.push('@playwright/test dependency'); }
      if (has('vitest')) { testFrameworks.push('vitest'); signals.push('vitest dependency'); }
      if (has('jest')) { testFrameworks.push('jest'); signals.push('jest dependency'); }
      if (has('cypress')) { testFrameworks.push('cypress'); signals.push('cypress dependency'); }
      if (has('mocha')) { testFrameworks.push('mocha'); signals.push('mocha dependency'); }
      if (has('typescript')) language = 'typescript';
      if (pkg.packageManager) {
        packageManager = pkg.packageManager.split('@')[0];
        signals.push(`packageManager field: ${pkg.packageManager}`);
      }
    } catch {
      signals.push('package.json unparseable');
    }
  }

  if (existsSync(join(root, 'tsconfig.json'))) signals.push('tsconfig.json present');
  if (existsSync(join(root, 'requirements.txt')) || existsSync(join(root, 'pyproject.toml'))) {
    language = language === 'unknown' ? 'python' : language;
    signals.push('python project files present');
  }
  if (existsSync(join(root, 'pytest.ini')) || existsSync(join(root, 'conftest.py'))) {
    testFrameworks.push('pytest');
    signals.push('pytest config present');
  }
  if (existsSync(join(root, 'go.mod'))) { language = language === 'unknown' ? 'go' : language; signals.push('go.mod present'); }
  if (existsSync(join(root, 'Cargo.toml'))) { language = language === 'unknown' ? 'rust' : language; signals.push('Cargo.toml present'); }
  if (existsSync(join(root, 'pom.xml'))) { language = language === 'unknown' ? 'java' : language; testFrameworks.push('junit'); signals.push('pom.xml present'); }
  if (existsSync(join(root, 'k6.config.js')) || existsSync(join(root, 'k6-script.js'))) { testFrameworks.push('k6'); signals.push('k6 config present'); }

  if (existsSync(join(root, 'pnpm-lock.yaml'))) { packageManager = packageManager ?? 'pnpm'; signals.push('pnpm-lock.yaml'); }
  if (existsSync(join(root, 'yarn.lock'))) { packageManager = packageManager ?? 'yarn'; signals.push('yarn.lock'); }
  if (existsSync(join(root, 'package-lock.json'))) { packageManager = packageManager ?? 'npm'; signals.push('package-lock.json'); }

  if (existsSync(join(root, '.github', 'workflows'))) ciSystems.push('github-actions');
  if (existsSync(join(root, '.gitlab-ci.yml'))) ciSystems.push('gitlab-ci');
  if (existsSync(join(root, 'Jenkinsfile'))) ciSystems.push('jenkins');
  if (existsSync(join(root, 'azure-pipelines.yml'))) ciSystems.push('azure-devops');

  const monorepo =
    existsSync(join(root, 'pnpm-workspace.yaml')) ||
    (existsSync(pkgPath) && (() => { try { return Array.isArray(JSON.parse(readFileSync(pkgPath, 'utf8')).workspaces); } catch { return false; } })()) ||
    existsSync(join(root, 'turbo.json'));
  if (monorepo) signals.push('monorepo workspace detected');

  return { language, framework, packageManager, testFrameworks, ciSystems, monorepo, signals };
}

const TEST_FILE_PATTERNS: ReadonlyArray<{ framework: string; layer: TestLayer; patterns: string[] }> = [
  { framework: 'playwright', layer: 'e2e', patterns: ['**/*.spec.ts', '**/*.spec.js', '**/e2e/**/*.ts'] },
  { framework: 'vitest', layer: 'unit', patterns: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.tsx'] },
  { framework: 'jest', layer: 'unit', patterns: ['**/*.test.js', '**/*.test.jsx', '**/__tests__/**/*.ts', '**/__tests__/**/*.js'] },
  { framework: 'pytest', layer: 'integration', patterns: ['**/test_*.py', '**/*_test.py'] },
  { framework: 'k6', layer: 'performance', patterns: ['**/k6/**/*.js', '**/performance/**/*.js'] },
];

export function inventoryTests(root: string, files?: string[]): DiscoveredTestFile[] {
  const all = files ?? listFiles(root);
  const inventory = new Map<string, DiscoveredTestFile>();

  for (const entry of TEST_FILE_PATTERNS) {
    for (const file of all) {
      if (matchAny(file, entry.patterns)) {
        const existing = inventory.get(file);
        if (existing) {
          // Do not double-count the same file under two frameworks.
          continue;
        }
        inventory.set(file, {
          filePath: file,
          framework: entry.framework,
          layer: entry.layer,
          estimatedCases: estimateCases(join(root, file)),
        });
      }
    }
  }
  return [...inventory.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function estimateCases(path: string): number {
  try {
    const src = readFileSync(path, 'utf8');
    const matches = src.match(/\b(?:test|it)\s*\(|def test_|\bvoid test\b/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php)$/;
const SOURCE_IGNORE = /\.(test|spec)\.[jt]sx?$|(^|\/)(test|tests|spec|__tests__|e2e|fixtures)\//;

export function discover(root: string): DiscoveryResult {
  const stack = detectStack(root);
  const files = listFiles(root);
  const testFiles = inventoryTests(root, files);
  const sourceFiles = files.filter((f) => SOURCE_EXT.test(f) && !SOURCE_IGNORE.test(f) && !matchAny(f, ['**/node_modules/**']));
  const configFiles = files.filter((f) => /(^|\/)(theqa\.config\.json|playwright\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|pytest\.ini|conftest\.py|k6\.config\.js)$/.test(f));
  return {
    root,
    stack,
    testFiles,
    sourceFiles,
    configFiles,
    label: 'OBSERVED',
  };
}
