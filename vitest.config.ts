import { defineConfig } from 'vitest/config';

// The browser-extension suite runs under jsdom, whose undici build needs Node 22+.
// jsdom is a dev-only dependency, so on older runtimes we skip that one file.
const nodeMajor = Number(process.versions.node.split('.')[0]);

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'bench/**/*.test.ts'],
    exclude: ['**/node_modules/**', ...(nodeMajor < 22 ? ['tests/extension.test.ts'] : [])],
    environment: 'node',
    // Vitest's default is 5s. Several suites do real filesystem work (mkdtemp,
    // atomic writes, recursive rm) and NTFS plus Defender make each of those
    // several times slower than on APFS or ext4: `installPack` and the setup
    // walkthroughs came in at 3.6-5.1s on windows-latest against ~300ms on a
    // Mac, so they were timing out on their own slowness rather than failing.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
