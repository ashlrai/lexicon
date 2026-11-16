import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

// Attributed and punctuated XXX comments follow the same contract as the plain
// `// XXX:` form: the name beside the marker is counted, the owner handle and
// the marker itself are never proposed.
it('harvests the name from attributed and dash-punctuated XXX comments, never the marker or owner', async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-xxx-attr-')));
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  try {
    await fs.writeFile(path.join(repo, 'attr.ts'), [
      '// XXX(alice): QuasarWidget',
      '// XXX - QuasarWidget',
      '// XXX QuasarWidget',
    ].join('\n'));

    const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
    const names = candidates.map(({ canonical }) => canonical);
    expect(names).not.toContain('XXX');
    expect(names).not.toContain('alice');
    expect(candidates).toContainEqual(expect.objectContaining({
      canonical: 'QuasarWidget', category: 'identifier', count: 3, evidence: ['attr.ts'],
    }));
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
