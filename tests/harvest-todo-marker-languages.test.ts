import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// A TODO fixture in non-TypeScript sources is recognized the same way: the
// name beside the marker is harvested, the marker word never is.
describe('harvest TODO marker across languages', () => {
  it.each([
    ['marker.py', '# TODO: port to QuasarWidget\nclass QuasarWidget: pass\n'],
    ['marker.rs', '// TODO: port to QuasarWidget\nstruct QuasarWidget;\n'],
    ['marker.go', '// TODO: port to QuasarWidget\ntype QuasarWidget struct{}\n'],
  ])('recognizes the TODO marker in %s', async (file, source) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-todo-lang-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, file), source);
    const names = (await harvestRepo(dir, { git: false, minCount: 1, symbols: true })).map((c) => c.canonical);
    expect(names).toContain('QuasarWidget');
    expect(names.map((n) => n.toLowerCase())).not.toContain('todo');
  });
});
