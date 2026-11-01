import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

describe('harvest marker documentation', () => {
  it('produces the documented candidates from the source example', async () => {
    const doc = await fs.readFile(path.resolve('docs/harvest-marker-examples.md'), 'utf8');
    const source = /```ts\n([\s\S]*?)\n```/.exec(doc)?.[1];
    expect(source).toBeDefined();

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-examples-'));
    const repo = path.join(tmp, 'repo');
    try {
      await fs.mkdir(repo);
      await fs.writeFile(path.join(repo, 'markers.ts'), source!);
      const candidates = await harvestRepo(repo, { git: false, symbols: true, minCount: 1 });
      expect(candidates.map(({ canonical, category, count, evidence }) => ({ canonical, category, count, evidence })))
        .toEqual(['CometWidget', 'FixMe', 'NebulaWidget', 'OrbitWidget', 'PulsarWidget', 'QuasarWidget']
          .map((canonical) => ({ canonical, category: 'identifier', count: 1, evidence: ['markers.ts'] })));
    } finally {
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
