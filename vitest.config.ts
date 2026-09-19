import { defineConfig } from 'vitest/config';

// The browser-extension suite runs under jsdom, whose undici build needs Node 22+.
// jsdom is a dev-only dependency, so on older runtimes we skip that one file.
const nodeMajor = Number(process.versions.node.split('.')[0]);

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'bench/**/*.test.ts'],
    exclude: ['**/node_modules/**', ...(nodeMajor < 22 ? ['tests/extension.test.ts'] : [])],
    environment: 'node',
  },
});
