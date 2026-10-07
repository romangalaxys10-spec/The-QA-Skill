import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeTempDir, runCli, write } from './helpers.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = makeTempDir('cli-initdisc');
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('init command', () => {
  it('writes theqa.config.json and .theqa dirs, envelope label OBSERVED, exit 0', async () => {
    const root = tmp();
    const res = await runCli(['init', '--json'], root);
    expect(res.code).toBe(0);
    const envelope = res.json<{ schemaVersion: number; command: string; ok: boolean; label: string; data: { configPath: string; projectName: string; nextSteps: string[] } }>();
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.command).toBe('init');
    expect(envelope.ok).toBe(true);
    expect(envelope.label).toBe('OBSERVED');
    expect(envelope.data.nextSteps).toEqual(['qa discover', 'qa doctor']);

    const configPath = join(root, 'theqa.config.json');
    expect(existsSync(configPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { schemaVersion: number; project: { name: string } };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.project.name).toBe(root.split('/').pop());
    expect(existsSync(join(root, '.theqa', 'artifacts'))).toBe(true);
  });

  it('refuses to overwrite an existing config without --force (exit 2)', async () => {
    const root = tmp();
    write(root, 'theqa.config.json', '{"schemaVersion":1,"project":{"name":"mine"}}\n');
    const res = await runCli(['init', '--json'], root);
    expect(res.code).toBe(2);
    const envelope = res.json<{ ok: boolean; data: { error: string } }>();
    expect(envelope.ok).toBe(false);
    expect(envelope.data.error).toMatch(/refusing to overwrite/);
    expect(readFileSync(join(root, 'theqa.config.json'), 'utf8')).toContain('"mine"');
  });

  it('--force overwrites the config', async () => {
    const root = tmp();
    write(root, 'theqa.config.json', '{"schemaVersion":1,"project":{"name":"mine"}}\n');
    const res = await runCli(['init', '--force', '--json'], root);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(readFileSync(join(root, 'theqa.config.json'), 'utf8')) as { project: { name: string } };
    expect(parsed.project.name).not.toBe('mine');
  });

  it('--dry-run writes nothing (label NOT_RUN)', async () => {
    const root = tmp();
    const res = await runCli(['init', '--dry-run', '--json'], root);
    expect(res.code).toBe(0);
    expect(res.json<{ label: string; data: { wouldWrite: boolean } }>().label).toBe('NOT_RUN');
    expect(res.json<{ data: { wouldWrite: boolean } }>().data.wouldWrite).toBe(true);
    expect(existsSync(join(root, 'theqa.config.json'))).toBe(false);
    expect(existsSync(join(root, '.theqa'))).toBe(false);
  });

  it('accepts an explicit [dir] positional and creates it', async () => {
    const parent = tmp();
    const target = join(parent, 'sub-project');
    mkdirSync(parent, { recursive: true });
    const res = await runCli(['init', target, '--json']);
    expect(res.code).toBe(0);
    expect(existsSync(join(target, 'theqa.config.json'))).toBe(true);
    expect(res.json<{ data: { projectName: string } }>().data.projectName).toBe('sub-project');
  });
});

describe('discover command', () => {
  it('returns the DiscoveryResult JSON shape on a temp project (label OBSERVED)', async () => {
    const root = tmp();
    write(root, 'package.json', JSON.stringify({ name: 'shop', private: true, devDependencies: { vitest: '^2.0.0', '@playwright/test': '^1.0.0' } }, null, 2));
    write(root, 'src/price.ts', 'export const price = 10;\n');
    write(root, 'tests/price.test.ts', "import { test } from 'vitest';\ntest('t', () => {});\n");
    const res = await runCli(['discover', '--json'], root);
    expect(res.code).toBe(0);
    const envelope = res.json<{ command: string; ok: boolean; label: string; data: { stack: { language: string; testFrameworks: string[]; signals: string[] }; counts: { testFiles: number; sourceFiles: number; configFiles: number }; testFiles: Array<{ filePath: string; framework: string; layer: string }>; configFiles: string[] } }>();
    expect(envelope.command).toBe('discover');
    expect(envelope.ok).toBe(true);
    expect(envelope.label).toBe('OBSERVED');
    expect(envelope.data.stack.language).toBe('typescript');
    expect(envelope.data.stack.testFrameworks).toContain('vitest');
    expect(envelope.data.stack.testFrameworks).toContain('playwright');
    expect(envelope.data.counts).toEqual({ testFiles: 1, sourceFiles: 1, configFiles: 0 });
    expect(envelope.data.testFiles[0]?.filePath).toBe('tests/price.test.ts');
    expect(envelope.data.testFiles[0]?.framework).toBe('vitest');
  });

  it('--save-context writes a validated .theqa/context.json', async () => {
    const root = tmp();
    write(root, 'package.json', JSON.stringify({ name: 'shop', private: true }, null, 2));
    const res = await runCli(['discover', '--save-context', '--json'], root);
    expect(res.code).toBe(0);
    const saved = res.json<{ data: { contextSaved?: string } }>().data.contextSaved;
    expect(saved).toBe(join(root, '.theqa', 'context.json'));
    const onDisk = JSON.parse(readFileSync(join(root, '.theqa', 'context.json'), 'utf8')) as { schemaVersion: number; root: string; existingTests: unknown[] };
    expect(onDisk.schemaVersion).toBe(1);
    expect(onDisk.root).toBe(root);
    expect(Array.isArray(onDisk.existingTests)).toBe(true);
  });

  it('writes nothing without --save-context', async () => {
    const root = tmp();
    write(root, 'package.json', JSON.stringify({ name: 'shop', private: true }, null, 2));
    const res = await runCli(['discover', '--json'], root);
    expect(res.code).toBe(0);
    expect(res.json<{ data: { contextSaved?: string } }>().data.contextSaved).toBeUndefined();
    expect(existsSync(join(root, '.theqa'))).toBe(false);
  });
});
