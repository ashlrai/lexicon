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

it.each([
  ['LF', '\n'],
  ['CRLF', '\r\n'],
])('retains a distinct name beside every standalone marker on separate %s lines', async (_label, newline) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-mixed-markers-'));
  const dir = path.join(temp, 'repo');
  try {
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'markers.ts'), [
      '// TODO: QuasarWidget',
      '// FIXME: NebulaQueue',
      '// NOTE: OrbitBridge',
      '// HACK: PulsarLoader',
      '// XXX: VectorPlanner',
    ].join(newline) + newline);

    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    // Evidence currently identifies files, not lines. Distinct names expose
    // a dropped marker line that a shared name and aggregate count can hide.
    expect(candidates).toEqual([
      'NebulaQueue', 'OrbitBridge', 'PulsarLoader', 'QuasarWidget', 'VectorPlanner',
    ].map((canonical) => ({
      canonical,
      category: 'identifier',
      source: 'harvest:repo',
      count: 1,
      evidence: ['markers.ts'],
      suggestedAliases: [],
    })));
  } finally {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
