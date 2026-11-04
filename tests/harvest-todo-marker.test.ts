import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const dirs: string[] = [];
async function repoWith(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-todo-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, 'marker.ts'), source);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// TODO is a recognized comment marker: harvest reads the comment for the
// names around it but never proposes the marker word itself.
describe('harvest TODO marker', () => {
  it('harvests the name beside a TODO comment and not the marker', async () => {
    const dir = await repoWith('// TODO: retry in QuasarWidget\nclass QuasarWidget {}\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    const names = candidates.map((c) => c.canonical);
    expect(names).toContain('QuasarWidget');
    for (const spelling of ['TODO', 'Todo', 'todo', 'ToDo']) {
      expect(names).not.toContain(spelling);
    }
  });

  it('does not propose TODO even when it is the only comment word', async () => {
    const dir = await repoWith('// TODO\nexport const x = 1;\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    expect(candidates.map((c) => c.canonical)).not.toContain('TODO');
  });

  it('ignores TODO in block comments and the doc prose scan', async () => {
    const dir = await repoWith('/* TODO: drain NebulaQueue */\nclass NebulaQueue {}\n');
    await fs.writeFile(path.join(dir, 'README.md'), 'TODO: tune NebulaQueue.\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    const names = candidates.map((c) => c.canonical);
    expect(names).toContain('NebulaQueue');
    expect(names).not.toContain('TODO');
  });
});
