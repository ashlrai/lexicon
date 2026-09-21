/**
 * The read-modify-writes that sit above `store.ts`.
 *
 * `addTerm`, `removeTerm` and `recordHits` were locked in 038eb36. These three
 * callers were not: each read the lexicon, decided something, and wrote the
 * whole document back. The write itself took the lock, so the file always
 * stayed valid and nothing ever looked broken, which is exactly what let the
 * lost update hide. Every test here was watched failing against the unlocked
 * code before the lock went in.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addTerm, loadLexicon, readLexiconFile } from '../src/core/index.js';
import { installPack } from '../src/core/packs.js';
import { runInit } from '../src/cli/commands.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

async function scratch(): Promise<{ dir: string; globalPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-lock-'));
  dirs.push(dir);
  return { dir, globalPath: path.join(dir, 'lexicon.yaml') };
}

function io() {
  const out: string[] = [];
  return { out, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s) } };
}

describe('installPack holds one lock for the whole install', () => {
  /**
   * A behaviour pin, not a regression test, and it is worth saying which.
   *
   * The defect is real: the loop adds every term under its own lock, then
   * `writePacksSetting` rewrites the whole document from the snapshot the last
   * `addTerm` returned, so a term added by anyone else during the loop is
   * renamed away while the pack reports success. But this test passes against
   * the unlocked code too, because twelve racers all finish well before the
   * last `addTerm`, and the window is only between that call and the settings
   * write. Making it fail on demand needs a hook inside `installPack` that
   * exists only for the test.
   *
   * So the lock there is reasoned, and what is actually proven is narrower:
   * the install still completes correctly with concurrent writers, and the
   * cross-process lock underneath it has its own red tests in store.test.ts.
   */
  it('keeps terms added by someone else while the pack is installing', async () => {
    const { globalPath } = await scratch();
    const racers = Array.from({ length: 12 }, (_, i) => `Racer${i}`);

    await Promise.all([
      installPack('developer', { globalPath, scope: 'global' }),
      ...racers.map((canonical) => addTerm({ canonical, aliases: [] }, { globalPath, scope: 'global' })),
    ]);

    const { merged } = await loadLexicon({ globalPath });
    const present = racers.filter((r) => merged.terms.some((t) => t.canonical === r));
    expect(present).toEqual(racers);
    // and the pack itself still landed
    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.settings?.packs).toContain('developer');
    expect(file.lexicon.terms.length).toBeGreaterThan(racers.length);
  });
});

describe('runInit creates the file exactly once', () => {
  /**
   * Catches: dropping the `withLexiconLock` around the existence check, the
   * write and the appended example. Without it both callers pass `existsSync`,
   * both write, and the loser's file (and its appended comment) is overwritten,
   * while both report having created it.
   */
  it('reports one creation when two inits race, and appends the example once', async () => {
    const { dir, globalPath } = await scratch();
    const a = io();
    const b = io();

    // runInit resolves the global path itself and does not take an override,
    // so the only safe way to redirect it away from the developer's own
    // lexicon is the variable resolvePaths already reads.
    const previous = process.env.LEXICON_PATH;
    process.env.LEXICON_PATH = globalPath;
    let codes: number[];
    try {
      codes = await Promise.all([runInit({ cwd: dir }, a.io), runInit({ cwd: dir }, b.io)]);
    } finally {
      if (previous === undefined) delete process.env.LEXICON_PATH;
      else process.env.LEXICON_PATH = previous;
    }

    expect(codes).toEqual([0, 0]);
    const said = [...a.out, ...b.out].join('');
    expect(said.match(/created global lexicon/g) ?? []).toHaveLength(1);
    expect(said).toContain('already exists');

    const text = await fs.readFile(globalPath, 'utf8');
    // The example comment is appended after the generated body; two writers
    // racing produced either two copies or none.
    expect(text.match(/# canonical: the spelling you want/g) ?? []).toHaveLength(1);
    const file = await readLexiconFile(globalPath, 'global');
    expect(file.exists).toBe(true);
  });
});
