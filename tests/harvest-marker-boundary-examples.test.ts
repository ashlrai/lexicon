import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

it('keeps the documented marker boundary examples in step with harvestRepo', async () => {
  const doc = await fs.readFile(path.resolve('docs/harvest-marker-boundary-examples.md'), 'utf8');
  const rows = [...doc.matchAll(/^\| `([^`]+)` \| (None|`[^`]+`) \| [^\n]+ \|$/gm)];
  expect(rows.length).toBeGreaterThanOrEqual(12);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-boundaries-'));
  const repo = path.join(tmp, 'repo');
  try {
    await fs.mkdir(repo);
    for (const [, source, result] of rows) {
      await fs.writeFile(path.join(repo, 'markers.ts'), source);
      const candidates = await harvestRepo(repo, {
        git: false, packages: false, symbols: true, minCount: 1,
      });
      const expected = result === 'None' ? [] : [result.slice(1, -1)];
      expect(candidates.map((candidate) => candidate.canonical), source).toEqual(expected);
      for (const candidate of candidates) {
        expect(candidate).toMatchObject({
          category: 'identifier', source: 'harvest:repo', count: 1, evidence: ['markers.ts'],
        });
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
