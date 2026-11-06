import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

// Marker detection is what keeps a comment tag out of the lexicon: the
// scanner recognizes a standalone TODO, still reads the rest of its line for
// real names, and never proposes the marker itself. A word that merely
// contains the letters is not a marker and must survive whole.
describe('harvest TODO marker detection', () => {
  let tmp: string;
  let repo: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-detect-'));
    repo = path.join(tmp, 'repo');
    await fs.mkdir(repo);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('detects a standalone TODO marker: filtered itself, its line still read', async () => {
    await fs.writeFile(path.join(repo, 'work.ts'), [
      '// TODO: retry the upload through QuasarWidget',
      'class QuasarWidget {}',
    ].join('\n'));

    const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
    const names = candidates.map((candidate) => candidate.canonical);
    expect(names).not.toContain('TODO');
    expect(candidates.find((candidate) => candidate.canonical === 'QuasarWidget')).toMatchObject({
      category: 'identifier',
      source: 'harvest:repo',
      count: 2,
      evidence: ['work.ts'],
    });
  });

  it('proposes nothing when a standalone TODO marker is the only content', async () => {
    await fs.writeFile(path.join(repo, 'work.ts'), '// TODO\n');

    expect(await harvestRepo(repo, { git: false, minCount: 1, symbols: true })).toEqual([]);
  });

  it('does not treat a word containing the marker letters as a marker', async () => {
    await fs.writeFile(path.join(repo, 'README.md'),
      'We use Mastodon and Mastodon reaches the community.\n');
    await fs.writeFile(path.join(repo, 'work.ts'),
      '// TODO: keep TodoWidget and QuasarTODO in sync.\n');

    const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
    const names = candidates.map((candidate) => candidate.canonical);
    // Mastodon holds "todo" inside it; the prose scan keeps the whole word.
    expect(candidates.find((candidate) => candidate.canonical === 'Mastodon')).toMatchObject({
      category: 'brand', source: 'harvest:repo', count: 2, evidence: ['README.md'],
    });
    // Identifiers carrying the letters keep them: no split, no drop.
    for (const name of ['TodoWidget', 'QuasarTODO']) {
      expect(candidates.find((candidate) => candidate.canonical === name)).toMatchObject({
        category: 'identifier', source: 'harvest:repo', count: 1, evidence: ['work.ts'],
      });
    }
    // And no marker is synthesized out of their letters.
    for (const spelling of ['TODO', 'Todo', 'todo', 'ToDo']) {
      expect(names).not.toContain(spelling);
    }
  });
});
