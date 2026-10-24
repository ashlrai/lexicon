import { defineConfig } from 'vitest/config';

// The browser-extension suites and the XML export check run under jsdom, whose
// undici build needs Node 22+.
// jsdom is a dev-only dependency, so on older runtimes we skip those files.
const nodeMajor = Number(process.versions.node.split('.')[0]);

// Wall-clock assertions. They run in their own project (below), never in the
// parallel pool with the rest of the suite.
const PERF_FILES = ['tests/matcher-perf.test.ts', 'tests/matcher-linear-perf.test.ts'];

export default defineConfig({
  // The extension imports examples/lexicon.example.yaml as text (esbuild's
  // text loader in scripts/build-extension.mjs); the same here, so a suite can
  // load the Options page as it ships.
  plugins: [
    {
      name: 'yaml-as-text',
      enforce: 'pre',
      transform(code: string, id: string) {
        return id.endsWith('.yaml') ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined;
      },
    },
  ],
  test: {
    environment: 'node',
    // Vitest's default is 5s. Several suites do real filesystem work (mkdtemp,
    // atomic writes, recursive rm) and NTFS plus Defender make each of those
    // several times slower than on APFS or ext4: `installPack` and the setup
    // walkthroughs came in at 3.6-5.1s on windows-latest against ~300ms on a
    // Mac, so they were timing out on their own slowness rather than failing.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'bench/**/*.test.ts'],
          exclude: ['**/node_modules/**', ...(nodeMajor < 22 ? ['tests/extension.test.ts', 'tests/extension-api-health.test.ts', 'tests/extension-frames.test.ts', 'tests/extension-editing.test.ts', 'tests/extension-storage-write.test.ts', 'tests/exporters-xml.test.ts'] : []), ...PERF_FILES],
          sequence: { groupOrder: 0 },
        },
      },
      {
        // A timing bound measured while other workers saturate the CPU tests the
        // runner's load, not the code (the 20 ms matcher case read 21.96 ms on a
        // busy ubuntu node 20 runner and passes alone). groupOrder 1 starts this
        // project only after the `unit` group has finished, and one forked worker
        // with no file parallelism keeps perf files from contending with each
        // other. Plain `npm test` still runs it; the bounds are unchanged.
        extends: true,
        test: {
          name: 'perf',
          include: PERF_FILES,
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
