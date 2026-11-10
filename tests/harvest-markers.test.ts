import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

it('harvests an identifier from the text of a NOTE source comment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-note-'));
  try {
    await fs.writeFile(path.join(dir, 'note.ts'), '// NOTE: retry NebulaQueue after reconnecting\n');

    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    expect(candidates).toContainEqual(expect.objectContaining({
      canonical: 'NebulaQueue', category: 'identifier', source: 'harvest:repo',
      count: 1, evidence: ['note.ts'],
    }));
    expect(candidates.map(({ canonical }) => canonical)).not.toContain('NOTE');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('filters marker words from source while retaining adjacent identifiers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-markers-'));
  try {
    await fs.writeFile(path.join(dir, 'markers.ts'), [
      '// TODO: QuasarWidget',
      '// FIXME: QuasarWidget',
      '// NOTE: QuasarWidget',
      '// HACK: QuasarWidget',
      '// XXX: QuasarWidget',
    ].join('\n'));

    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    const names = candidates.map(({ canonical }) => canonical.toUpperCase());
    for (const marker of ['TODO', 'FIXME', 'NOTE', 'HACK', 'XXX']) {
      expect(names).not.toContain(marker);
    }
    expect(candidates).toContainEqual(expect.objectContaining({
      canonical: 'QuasarWidget', count: 5, evidence: ['markers.ts'],
    }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
