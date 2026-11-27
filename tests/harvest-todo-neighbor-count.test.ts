import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('harvest TODO marker beside an ordinary term', () => {
  it('drops TODO and keeps the neighboring term with its full count across files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-todo-neighbor-'));
    dirs.push(dir);
    await fs.writeFile(path.join(dir, 'a.ts'), '// TODO QuasarWidget\nexport const a = 1;\n');
    await fs.writeFile(path.join(dir, 'b.ts'), '// TODO: QuasarWidget needs a retry\nexport const b = 2;\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    const names = candidates.map((c) => c.canonical);
    expect(names).not.toContain('TODO');
    const widget = candidates.find((c) => c.canonical === 'QuasarWidget');
    expect(widget).toBeDefined();
    expect(widget?.count).toBeGreaterThanOrEqual(2);
  });
});
