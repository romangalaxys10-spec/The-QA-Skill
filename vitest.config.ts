import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['default'],
  },
  resolve: {
    alias: [
      { find: '@the-qa-skill/core', replacement: r('./packages/core/src/index.ts') },
      { find: '@the-qa-skill/graph', replacement: r('./packages/graph/src/index.ts') },
      { find: '@the-qa-skill/data', replacement: r('./packages/data/src/index.ts') },
      { find: '@the-qa-skill/reasoning', replacement: r('./packages/reasoning/src/index.ts') },
      { find: '@the-qa-skill/healing', replacement: r('./packages/healing/src/index.ts') },
      { find: '@the-qa-skill/runners', replacement: r('./packages/runners/src/index.ts') },
      { find: '@the-qa-skill/reporting', replacement: r('./packages/reporting/src/index.ts') },
      { find: '@the-qa-skill/agents', replacement: r('./packages/agents/src/index.ts') },
      { find: '@the-qa-skill/xroutelm', replacement: r('./packages/xroutelm/src/index.ts') },
      { find: '@the-qa-skill/mcp-server', replacement: r('./packages/mcp-server/src/index.ts') },
    ],
  },
});
