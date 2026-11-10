import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

// The HACK contract is scoped to the text the harvester scans for
// identifiers: source extensions, plus README prose for external evidence.
// A marker-looking line in a file the scanner skips (.toml config, .json
// data) or in markdown that is not a README contributes neither the marker
// nor the name beside it, while the same line in source still yields the
// name and in README prose it is brand evidence that needs no `symbols`.
async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-hack-')));
  // `repo` is a generic root name, so only what the test writes is proposed.
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  try {
    await run(repo);
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe('HACK marker across file types', () => {
  it('only counts the marker-adjacent name in files the identifier scanner reads', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '// HACK: revisit QuasarWidget\n');
      await fs.writeFile(path.join(repo, 'settings.toml'), '# HACK: revisit NebulaConfig\n');
      await fs.writeFile(path.join(repo, 'config.json'), '{"note": "HACK: revisit PulsarData"}\n');
      await fs.writeFile(path.join(repo, 'notes.md'), '// HACK: revisit VegaDocs\n');

      const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
      expect(candidates.map(({ canonical, category, source, count, evidence }) =>
        ({ canonical, category, source, count, evidence }))).toEqual([{
        canonical: 'QuasarWidget', category: 'identifier', source: 'harvest:repo',
        count: 1, evidence: ['note.ts'],
      }]);
    });
  });

  it('never proposes the marker from README prose while the adjacent name is brand evidence', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'README.md'), 'We revisit QuasarWidget after HACK reviews.\n');

      const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
      expect(candidates.map(({ canonical, category, source, count, evidence }) =>
        ({ canonical, category, source, count, evidence }))).toEqual([{
        canonical: 'QuasarWidget', category: 'brand', source: 'harvest:repo',
        count: 1, evidence: ['README.md'],
      }]);
    });
  });
});
