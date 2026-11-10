import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

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
