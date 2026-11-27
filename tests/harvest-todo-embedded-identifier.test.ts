import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

describe('harvest TODO embedded in a longer identifier', () => {
  it('keeps the whole identifier and never proposes TODO as a standalone marker', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-todo-embedded-'));
    try {
      await fs.writeFile(path.join(repo, 'a.ts'), [
        'export class QuasarTODOBeacon {}',
        'const x = new QuasarTODOBeacon(); // QuasarTODOBeacon',
        'export class NebulaTODO {}',
        'const y = new NebulaTODO(); // NebulaTODO',
      ].join('\n'));

      const candidates = await harvestRepo(repo, { git: false, symbols: true, minCount: 1 });
      const names = candidates.map(({ canonical }) => canonical);
      expect(names).not.toContain('TODO');
      expect(names).toEqual(expect.arrayContaining(['QuasarTODOBeacon', 'NebulaTODO']));
      expect(candidates.find(({ canonical }) => canonical === 'QuasarTODOBeacon')?.count).toBeGreaterThanOrEqual(2);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
