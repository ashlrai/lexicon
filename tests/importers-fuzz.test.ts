import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMPORT_FORMATS } from '../src/core/importers/index.js';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('./helpers/importers-fuzz.ts', import.meta.url));

const cases = IMPORT_FORMATS.flatMap((format) =>
  ['corpus', 'duplicates', ...Array.from({ length: 8 }, (_, i) => String(i))]
    .map((scenario) => ({ format, scenario })),
);

describe('importers: deterministic malformed, huge and mixed-encoding corpus', () => {
  let directory: string;
  let executable: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lexicon-importers-fuzz-'));
    executable = join(directory, 'corpus.cjs');
    // Compile once so each isolated scan measures parser work without a
    // TypeScript loader or a separate compiler process at every launch.
    await build({ entryPoints: [helper], outfile: executable, bundle: true, platform: 'node', format: 'cjs' });
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(cases)('$format / $scenario completes without runtime failures', async ({ format, scenario }) => {
    // A Vitest timeout cannot interrupt a synchronous infinite loop. A child
    // deadline can, and also reports uncaught errors and abnormal exits.
    const { stdout, stderr } = await run(process.execPath, [executable, format, scenario], {
      timeout: 15_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    });
    expect(stderr).toBe('');
    const counts = JSON.parse(stdout) as { accepted: number; refused: number };
    expect(counts.accepted + counts.refused).toBeGreaterThanOrEqual(scenario === 'corpus' ? 215 : 1);
  }, 20_000);
});
