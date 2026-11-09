import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const dirs: string[] = [];
async function repoWith(file: string, source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-todo-place-'));
  dirs.push(dir);
  await fs.writeFile(path.join(dir, file), source);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// Where the comment sits must not matter: after code on the same line, inside
// a JSDoc block, or after Python code, the marker is recognized (never
// proposed) and the name next to it is still harvested.
describe('harvest TODO marker placement', () => {
  it.each([
    ['trailing line comment', 'a.ts', 'const q = 1; // TODO: wire OrbitRelay\nclass OrbitRelay {}\n'],
    ['JSDoc block', 'b.ts', '/**\n * TODO: split OrbitRelay\n */\nclass OrbitRelay {}\n'],
    ['hash comment after code', 'c.py', 'x = 1  # TODO: port OrbitRelay\nclass OrbitRelay: pass\n'],
  ])('recognizes TODO in a %s', async (_label, file, source) => {
    const dir = await repoWith(file, source);
    const names = (await harvestRepo(dir, { git: false, minCount: 1, symbols: true })).map((c) => c.canonical);
    expect(names).not.toContain('TODO');
    expect(names).not.toContain('Todo');
    expect(names).toContain('OrbitRelay');
  });
});
