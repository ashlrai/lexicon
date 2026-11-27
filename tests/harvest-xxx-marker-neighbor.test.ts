import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const dirs: string[] = [];
async function repoWith(files: Record<string, string>): Promise<string> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-xxx-nb-')));
  dirs.push(base);
  const dir = path.join(base, 'repo');
  await fs.mkdir(dir);
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// The task contract in one place: the XXX marker is filtered out and the
// ordinary term next to it survives, in both the symbol and the prose path.
describe('harvest XXX marker beside an ordinary term', () => {
  it('drops XXX and keeps the neighboring term (symbols)', async () => {
    const dir = await repoWith({ 'a.ts': '// XXX QuasarWidget\nclass QuasarWidget {}\n' });
    const names = (await harvestRepo(dir, { git: false, minCount: 1, symbols: true })).map((c) => c.canonical);
    expect(names).toContain('QuasarWidget');
    expect(names).not.toContain('XXX');
  });

  it('drops XXX and keeps the neighboring term (README prose, default options)', async () => {
    const dir = await repoWith({
      'a.ts': 'export const x = 1;\n',
      'README.md': 'XXX NebulaQueue handles retries. XXX NebulaQueue drains.\n',
    });
    const names = (await harvestRepo(dir, { git: false, minCount: 1 })).map((c) => c.canonical);
    expect(names).toContain('NebulaQueue');
    expect(names).not.toContain('XXX');
  });
});
