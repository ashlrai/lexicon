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
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { addTerm, loadLexicon, readLexiconFile, writeLexiconFile } from '../src/core/index.js';
import { installPack, loadPack } from '../src/core/packs.js';
import { emptyLexicon } from '../src/core/schema.js';
import type { Term } from '../src/core/types.js';
import { runInit } from '../src/cli/commands.js';
import { runEdit } from '../src/cli/cmd-review.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PACKS_MODULE = new URL('../src/core/packs.ts', import.meta.url).href;
const STORE_MODULE = new URL('../src/core/store.ts', import.meta.url).href;

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

interface ChildResult {
  code: number;
  out: string;
}

/**
 * Run a script in a real, separate process. Only a second process can show
 * that a lock works between processes; an in-process test would pass on the
 * promise queue alone, which is how the defect below survived a suite that
 * already had a twelve-writer case.
 */
function runChild(script: string, args: readonly string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, LEXICON_PATH: '', XDG_CONFIG_HOME: '' },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, out: out.trim() }));
  });
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

describe('uninstallPack reads and writes inside the lock', () => {
  /**
   * Catches: `uninstallPack` reading the lexicon, deciding which terms
   * survive, reading the hits sidecar and only then writing, with none of it
   * locked. This is the fourth instance of the class the install lock was
   * added to fix, sitting directly below the one that was fixed.
   *
   * A `lexicon add` landing anywhere in that window was read by nobody here
   * and was renamed away by the write, with both commands reporting success
   * and exiting 0. Thirteen of thirteen concurrent runs lost the racing term.
   * The control is decisive: the locked `removeTerm` under identical
   * conditions either keeps the write or fails loudly.
   *
   * The lexicon is seeded large enough that the read and the serialize are
   * not instantaneous, which is what makes the window real rather than
   * theoretical. Two arrival times, because the window has a start and an end.
   */
  it('keeps a term another process adds while the pack is being removed', async () => {
    const uninstallScript = path.join((await scratch()).dir, 'uninstall.mts');
    await fs.writeFile(
      uninstallScript,
      [
        `import { uninstallPack } from ${JSON.stringify(PACKS_MODULE)};`,
        'const [globalPath] = process.argv.slice(2);',
        "const r = await uninstallPack('developer', { globalPath, scope: 'global', cwd: process.cwd() });",
        "process.stdout.write('removed=' + r.removed.length);",
      ].join('\n'),
    );
    const addScript = path.join(path.dirname(uninstallScript), 'add.mts');
    await fs.writeFile(
      addScript,
      [
        `import { addTerm } from ${JSON.stringify(STORE_MODULE)};`,
        'const [globalPath, canonical, delayMs] = process.argv.slice(2);',
        'await new Promise((r) => setTimeout(r, Number(delayMs)));',
        "await addTerm({ canonical, aliases: [] }, { globalPath, scope: 'global', cwd: process.cwd() });",
        "process.stdout.write('added ' + canonical);",
      ].join('\n'),
    );

    const pack = await loadPack('developer');
    for (const delayMs of ['0', '40']) {
      const { globalPath } = await scratch();
      const lexicon = emptyLexicon();
      for (const term of pack.lexicon.terms) {
        lexicon.terms.push({ ...term, aliases: [...term.aliases], scope: 'global', source: 'pack' } as Term);
      }
      for (let i = 0; i < 400; i++) {
        lexicon.terms.push({ canonical: `Filler${i}`, aliases: [`f${i}a`, `f${i}b`], scope: 'global', source: 'user' } as Term);
      }
      lexicon.settings = { packs: ['developer'] };
      await writeLexiconFile({ path: globalPath, scope: 'global', lexicon, exists: false });

      const [uninstalled, added] = await Promise.all([
        runChild(uninstallScript, [globalPath]),
        runChild(addScript, [globalPath, 'Racer', delayMs]),
      ]);

      expect(uninstalled.out).toBe('removed=70');
      const back = await readLexiconFile(globalPath, 'global');
      const present = back.lexicon.terms.some((t) => t.canonical === 'Racer');
      // Either the write is kept or the writer was told it failed. What must
      // never happen is the third thing: success reported, term gone.
      if (added.code === 0) {
        expect({ delayMs, said: added.out, present }).toEqual({ delayMs, said: 'added Racer', present: true });
      } else {
        expect(added.out).toContain('could not lock');
      }
      // The uninstall's own work still landed.
      expect(back.lexicon.settings?.packs ?? []).not.toContain('developer');
    }
  });
});

describe('runEdit creates the file exactly once', () => {
  /**
   * Catches: dropping the `withLexiconLock` around `runEdit`'s existence
   * check and its create. Apart, both callers pass `existsSync`, both write
   * an empty lexicon, and a term written into the gap by anyone else is
   * renamed away while both commands report having created the file. It is
   * the same shape `runInit` was fixed for, in the command directly beside it.
   */
  it('reports one creation when two edits race on a missing lexicon', async () => {
    const { dir, globalPath } = await scratch();
    const a = io();
    const b = io();
    // No $VISUAL or $EDITOR: runEdit does the create-if-missing work and then
    // prints where the file is, which is the half under test.
    const env = { PATH: process.env.PATH } as NodeJS.ProcessEnv;

    const codes = await Promise.all([
      runEdit({ cwd: dir, globalPath }, a.io, undefined, env),
      runEdit({ cwd: dir, globalPath }, b.io, undefined, env),
    ]);

    expect(codes).toEqual([0, 0]);
    const said = [...a.out, ...b.out].join('');
    expect(said.match(/created global lexicon/g) ?? []).toHaveLength(1);
    expect((await readLexiconFile(globalPath, 'global')).exists).toBe(true);
  });
});
