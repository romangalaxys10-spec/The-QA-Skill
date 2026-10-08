import { describe, expect, it } from 'vitest';
import { DiscoveryAgent } from '../src/agents/discovery.js';
import { RequirementsAgent } from '../src/agents/requirements.js';
import { commitAll, initRepo, makeTempDir, write } from './helpers.js';

describe('DiscoveryAgent', () => {
  it('discovers stack + test inventory on a real temp dir', async () => {
    const root = makeTempDir('discovery');
    write(root, 'package.json', JSON.stringify({ name: 'app', private: true, devDependencies: { vitest: '^2.1.0', typescript: '^5.6.0' } }));
    write(root, 'tsconfig.json', '{}\n');
    write(root, 'src/index.ts', 'export const one = 1;\n');
    write(root, 'tests/a.test.ts', "import { it } from 'vitest';\nit('one is one', () => {});\nit('two is two', () => {});\n");

    const agent = new DiscoveryAgent(root);
    const discovery = await agent.discover();

    expect(discovery.root).toBe(root);
    expect(discovery.stack.language).toBe('typescript');
    expect(discovery.stack.testFrameworks).toContain('vitest');
    expect(discovery.testFiles).toHaveLength(1);
    expect(discovery.testFiles[0]?.filePath).toBe('tests/a.test.ts');
    expect(discovery.testFiles[0]?.estimatedCases).toBe(2);
    expect(discovery.label).toBe('OBSERVED');
  });

  it('buildContext maps the discovery result into the validated QAContext model', async () => {
    // A real git repo so provenance commit/branch are observable (they are
    // honestly undefined outside a repository).
    const root = makeTempDir('context');
    initRepo(root, { name: 'app', devDependencies: { vitest: '^2.1.0' } });
    write(root, 'tsconfig.json', '{}\n');
    write(root, 'tests/a.test.ts', "import { it } from 'vitest';\nit('a', () => {});\n");
    commitAll(root, 'feat: tests');

    const agent = new DiscoveryAgent(root);
    const discovery = await agent.discover();
    const ctx = agent.buildContext(discovery);

    expect(ctx.root).toBe(root);
    expect(ctx.application.language).toBe('typescript');
    expect(ctx.application.type).toBe('library');
    expect(ctx.knownFlakes).toEqual([]);
    expect(ctx.existingTests).toHaveLength(1);
    expect(ctx.existingTests[0]?.filePath).toBe('tests/a.test.ts');
    expect(ctx.existingTests[0]?.layer).toBe('unit');
    expect(ctx.provenance.discovery).toBe('core.discover');
    expect(ctx.provenance.commit).toBeDefined();
    expect(ctx.provenance.branch).toBeDefined();
  });

  it('classifies a web framework project as web-app', async () => {
    const root = makeTempDir('webapp');
    write(root, 'package.json', JSON.stringify({ name: 'web', dependencies: { react: '^18.0.0' } }));
    const agent = new DiscoveryAgent(root);
    const ctx = agent.buildContext(await agent.discover());
    expect(ctx.application.type).toBe('web-app');
    expect(ctx.application.framework).toBe('react');
  });
});

describe('RequirementsAgent', () => {
  it('extracts headings as requirements and list items as criteria', () => {
    const root = makeTempDir('requirements');
    write(
      root,
      'README.md',
      [
        '# Checkout Service',
        '',
        '- The service **must** reject expired cards',
        '- Totals over 100 USD receive free shipping',
        '',
        '## Refunds',
        '',
        '* Refunds must be idempotent',
      ].join('\n'),
    );
    write(
      root,
      'docs/spec.md',
      ['# Billing', '', '- Invoices are issued monthly'].join('\n'),
    );

    const agent = new RequirementsAgent(root);
    const requirements = agent.extract();

    expect(requirements.length).toBe(3);
    const checkout = requirements.find((r) => r.title === 'Checkout Service');
    expect(checkout?.criteria).toEqual(['The service **must** reject expired cards', 'Totals over 100 USD receive free shipping']);
    expect(checkout?.source).toBe('README.md');
    expect(checkout?.priority).toBe('must');
    expect(checkout?.status).toBe('draft');
    expect(requirements.every((r) => /^REQ-[a-z0-9-]+-\d+$/.test(r.id))).toBe(true);
    expect(requirements.map((r) => r.id)).toEqual([...new Set(requirements.map((r) => r.id))]);
    const billing = requirements.find((r) => r.title === 'Billing');
    expect(billing?.source).toBe('docs/spec.md');
  });

  it('ignores headings inside code fences', () => {
    const root = makeTempDir('fences');
    write(root, 'README.md', ['# Real', '', '```md', '# Not a heading', '```'].join('\n'));
    const requirements = new RequirementsAgent(root).extract();
    expect(requirements.map((r) => r.title)).toEqual(['Real']);
  });

  it('skips files over 5000 lines and returns an honest empty array when nothing is found', () => {
    const root = makeTempDir('huge');
    write(root, 'README.md', `# Huge\n${'filler line\n'.repeat(5001)}`);
    const huge = new RequirementsAgent(root).extract();
    expect(huge).toEqual([]);

    const emptyRoot = makeTempDir('empty-specs');
    expect(new RequirementsAgent(emptyRoot).extract()).toEqual([]);
  });
});
