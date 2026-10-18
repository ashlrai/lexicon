import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without a declaration file
import { cleanDist } from '../scripts/clean-dist.mjs';

const root = path.resolve(import.meta.dirname, '..');
let tmp: string | undefined;

afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('build clears dist/ first', () => {
  // tsc never deletes output, so a file compiled from a source that was
  // since deleted stayed in dist/ and shipped in the npm tarball ("files": ["dist"]).
  it('the build script removes dist/ before tsc writes it', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const build = pkg.scripts.build;
    expect(build).toMatch(/^node scripts\/clean-dist\.mjs && tsc -p tsconfig\.build\.json$/);
    // prepare and prepublishOnly both go through it.
    expect(pkg.scripts.prepare).toMatch(/^npm run build\b/);
    expect(pkg.scripts.prepublishOnly).toMatch(/^npm run build\b/);
  });

  it('cleanDist removes the directory and its stray files, and tolerates a missing one', async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-clean-dist-'));
    const dist = path.join(tmp, 'dist');
    await fs.mkdir(path.join(dist, 'core', 'old'), { recursive: true });
    await fs.writeFile(path.join(dist, 'core', 'old', 'deleted-module.js'), 'export {};\n');
    await cleanDist(dist);
    await expect(fs.stat(dist)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(cleanDist(dist)).resolves.toBeUndefined();
  });
});
