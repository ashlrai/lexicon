import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

describe('harvest marker case behavior documentation', () => {
  it.each([
    ['TODO', 'ToDo', false, true],
    ['FIXME', 'FixMe', true, true],
    ['NOTE', 'NoTe', false, true],
    ['HACK', 'HaCk', false, true],
    ['XXX', 'XxX', false, false],
  ])('compares %s with lowercase and mixed-case spellings in source and prose', async (marker, mixed, sourceMixed, proseMixed) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-cases-'));
    try {
      const options = { git: false, minCount: 1 };
      for (const [index, spelling] of [marker, marker.toLowerCase(), mixed].entries()) {
        // Separate repos avoid merging different spellings into the same bucket.
        const repo = path.join(tmp, String(index), 'repo');
        await fs.mkdir(repo, { recursive: true });
        await fs.writeFile(path.join(repo, 'markers.ts'), `// ${spelling}: QuasarWidget\n`);
        const source = await harvestRepo(repo, { ...options, symbols: true });
        expect(source.map(({ canonical, category, count }) => ({ canonical, category, count })))
          .toEqual([
            ...(spelling === mixed && sourceMixed ? [{ canonical: spelling, category: 'identifier', count: 1 }] : []),
            { canonical: 'QuasarWidget', category: 'identifier', count: 1 },
          ]);
        expect(await harvestRepo(repo, options)).toEqual([]);

        await fs.rm(path.join(repo, 'markers.ts'));
        await fs.writeFile(path.join(repo, 'README.md'), `We use ${spelling} today.\n`);
        const prose = await harvestRepo(repo, options);
        expect(prose.map(({ canonical, category, count }) => ({ canonical, category, count })))
          .toEqual(spelling === mixed && proseMixed ? [{ canonical: spelling, category: 'brand', count: 1 }] : []);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('produces the documented candidates from both examples', async () => {
    const doc = await fs.readFile(path.resolve('docs/harvest-marker-case-behavior.md'), 'utf8');
    const source = /```ts\n([\s\S]*?)\n```/.exec(doc)?.[1];
    const readme = /```text\n([\s\S]*?)\n```/.exec(doc)?.[1];
    expect(source).toBeDefined();
    expect(readme).toBeDefined();

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-case-'));
    const repo = path.join(tmp, 'repo');
    try {
      await fs.mkdir(repo);
      await fs.writeFile(path.join(repo, 'markers.ts'), source!);
      const options = { git: false, minCount: 1 };
      const sourceCandidates = await harvestRepo(repo, { ...options, symbols: true });
      expect(sourceCandidates.map(({ canonical, category, count }) => ({ canonical, category, count })))
        .toEqual(['FixMe', 'QuasarWidget'].map((canonical) => ({ canonical, category: 'identifier', count: 1 })));
      expect(await harvestRepo(repo, options)).toEqual([]);

      await fs.rm(path.join(repo, 'markers.ts'));
      await fs.writeFile(path.join(repo, 'README.md'), readme!);
      const proseCandidates = await harvestRepo(repo, options);
      expect(proseCandidates.map(({ canonical, category, count }) => ({ canonical, category, count })))
        .toEqual([{ canonical: 'ToDo', category: 'brand', count: 1 }]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
