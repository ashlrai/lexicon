import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const dirs: string[] = [];
async function repoWith(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-fixme-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'marker.ts'), source);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// FIXME is a recognized comment marker: harvest reads the comment for the
// names around it but never proposes the marker word itself.
describe('harvest FIXME marker', () => {
  it('leaves an ordinary candidate unchanged when a FIXME marker is present', async () => {
    const dir = await repoWith('class QuasarWidget {}\n');
    const options = { git: false, minCount: 1, symbols: true };
    const control = await harvestRepo(dir, options);
    expect(control.map(({ canonical }) => canonical)).toContain('QuasarWidget');
    expect(control.map(({ canonical }) => canonical)).not.toContain('FIXME');

    await fs.writeFile(path.join(dir, 'marker.ts'), '// FIXME\nclass QuasarWidget {}\n');
    expect(await harvestRepo(dir, options)).toEqual(control);
  });

  it('harvests the name beside a FIXME comment and not the marker', async () => {
    const dir = await repoWith('// FIXME: retry in QuasarWidget\nclass QuasarWidget {}\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    const names = candidates.map((c) => c.canonical);
    expect(names).toContain('QuasarWidget');
    for (const spelling of ['FIXME', 'Fixme', 'fixme']) {
      expect(names).not.toContain(spelling);
    }
  });

  it('does not propose FIXME even when it is the only comment word', async () => {
    const dir = await repoWith('// FIXME\nexport const x = 1;\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    expect(candidates.map((c) => c.canonical)).not.toContain('FIXME');
  });

  it('ignores FIXME in block comments and the doc prose scan', async () => {
    const dir = await repoWith('/* FIXME: drain NebulaQueue */\nclass NebulaQueue {}\n');
    await fs.writeFile(path.join(dir, 'NOTES.md'), 'FIXME: tune NebulaQueue.\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    const names = candidates.map((c) => c.canonical);
    expect(names).toContain('NebulaQueue');
    expect(names).not.toContain('FIXME');
  });
});
