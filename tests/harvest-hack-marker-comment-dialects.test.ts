import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

// HACK in comment dialects the fixture test does not cover: Ruby `#`, Go
// `/* */`, CRLF line endings and a Kotlin `//` comment. The marker is never
// proposed; the name beside it still is.
describe('HACK marker comment dialects', () => {
  it('recognizes HACK in Ruby, Go, CRLF and Kotlin comments without proposing it', async () => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-hack-')));
    const repo = path.join(base, 'repo');
    await fs.mkdir(repo);
    try {
      await fs.writeFile(path.join(repo, 'q.rb'), '# HACK: patch QuasarLedger\n');
      await fs.writeFile(path.join(repo, 'page.go'), '/* HACK: swap PulsarRouter */\n');
      await fs.writeFile(path.join(repo, 'crlf.ts'), '// HACK: tune NebulaSocket\r\nconst x = 1;\r\n');
      await fs.writeFile(path.join(repo, 'conf.kt'), '// HACK: pin OrbitScheduler\nval k = 1\n');

      const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
      const names = candidates.map((c) => c.canonical).sort();
      expect(names).toEqual(['NebulaSocket', 'OrbitScheduler', 'PulsarRouter', 'QuasarLedger']);
      expect(names).not.toContain('HACK');
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
