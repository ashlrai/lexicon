import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

// Focused check that the `NOTE` marker is recognized together with its
// surrounding text: the marker is not proposed, and the
// names on both sides of it in one comment are still harvested.
describe('harvest NOTE marker with surrounding text', () => {
  it('drops the marker but keeps the names before and after it', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-note-around-')));
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo);
    try {
      await fs.writeFile(path.join(repo, 'a.ts'), '/* OrbitRelay NOTE: see QuartzLoader */\n');
      const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
      expect(candidates.map((c) => c.canonical).sort()).toEqual(['OrbitRelay', 'QuartzLoader']);
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
