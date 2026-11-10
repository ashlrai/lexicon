import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

describe('harvest adjacent TODO and FIXME markers', () => {
  it.each([
    ['consecutive lines', '// TODO: repair QuasarWidget\n// FIXME: update NebulaQueue\n'],
    ['reversed lines', '// FIXME: update NebulaQueue\n// TODO: repair QuasarWidget\n'],
    ['one line', '// TODO: repair QuasarWidget; FIXME: update NebulaQueue\n'],
    ['block comment', '/* TODO: repair QuasarWidget\n * FIXME: update NebulaQueue */\n'],
  ])('retains the name associated with each marker on %s', async (_description, source) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-adjacent-markers-'));
    try {
      await fs.writeFile(path.join(dir, 'markers.ts'), source);
      const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
      expect(candidates.map(({ canonical, category, count, evidence }) => ({ canonical, category, count, evidence })))
        .toEqual(expect.arrayContaining([
          { canonical: 'QuasarWidget', category: 'identifier', count: 1, evidence: ['markers.ts'] },
          { canonical: 'NebulaQueue', category: 'identifier', count: 1, evidence: ['markers.ts'] },
        ]));
      expect(candidates.map(({ canonical }) => canonical)).not.toEqual(expect.arrayContaining(['TODO']));
      expect(candidates.map(({ canonical }) => canonical)).not.toEqual(expect.arrayContaining(['FIXME']));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
