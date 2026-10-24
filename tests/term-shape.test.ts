/**
 * A term read from a file and a term `addTerm` just created have the same
 * shape. The schema used to fill `never: []` (and settings `protectedWords: []`,
 * `packs: []`) on every load, so `list --json` showed a hand-written term with
 * `never: []` beside a freshly added one without the key. Real schema and
 * store here (tests/store.test.ts mocks the schema).
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTerm, findTerm, loadLexicon, writeLexiconFile } from '../src/core/index.js';
import type { Term } from '../src/core/index.js';
import { runList } from '../src/cli/commands.js';
import { makeIO } from './helpers.js';

let tmp: string;
let globalPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-shape-')));
  globalPath = path.join(tmp, 'config', 'lexicon.yaml');
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  for (const key of ['LEXICON_PATH', 'XDG_CONFIG_HOME']) saved[key] = process.env[key];
  process.env.LEXICON_PATH = globalPath;
  process.env.XDG_CONFIG_HOME = path.join(tmp, 'xdg');
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('term shape across load and create', () => {
  it('has no never key unless there are never-words, and writing back adds no never: [] line', async () => {
    await fs.writeFile(
      globalPath,
      'version: 1\nterms:\n  - canonical: Hand\n    aliases: [hend]\n  - canonical: Blocked\n    aliases: [blokt]\n    never: [Block]\n',
    );
    const { term: created } = await addTerm({ canonical: 'Fresh', aliases: ['frosh'] }, { globalPath, cwd: tmp });
    expect('never' in created).toBe(false);

    const loaded = await loadLexicon({ globalPath, cwd: tmp });
    const hand = findTerm(loaded.merged, 'Hand')!;
    expect('never' in hand).toBe(false);
    expect('never' in findTerm(loaded.merged, 'Fresh')!).toBe(false);
    expect(findTerm(loaded.merged, 'Blocked')?.never).toEqual(['Block']);
    expect(loaded.global.lexicon.settings).toBeUndefined();

    const io = makeIO();
    expect(await runList({ json: true, cwd: tmp }, io)).toBe(0);
    const listed = JSON.parse(io.out) as Term[];
    expect(listed.filter((t) => 'never' in t).map((t) => t.canonical)).toEqual(['Blocked']);

    await writeLexiconFile(loaded.global);
    const text = await fs.readFile(globalPath, 'utf8');
    expect(text).not.toMatch(/never: \[\]|protectedWords|packs/);
    expect(text.match(/never:/g)).toHaveLength(1);
  });
});
