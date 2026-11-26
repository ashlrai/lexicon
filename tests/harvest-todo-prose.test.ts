import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

it('ignores lowercase todo in ordinary prose without affecting nearby names', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-todo-prose-'));
  const readme = path.join(repo, 'README.md');
  const options = { git: false, minCount: 1 };
  try {
    await fs.writeFile(readme, 'We use Mastodon in this project.\n');
    const control = await harvestRepo(repo, options);
    expect(control).toEqual(expect.arrayContaining([
      expect.objectContaining({ canonical: 'Mastodon', count: 1, evidence: ['README.md'] }),
    ]));

    const prose = 'We use Mastodon for the todo in this project.\n';
    await fs.writeFile(readme, prose);
    const candidates = await harvestRepo(repo, options);
    expect(candidates).toEqual(control);
    expect(candidates.map((candidate) => candidate.canonical)).not.toContain('todo');
    expect(await fs.readFile(readme, 'utf8')).toBe(prose);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});
