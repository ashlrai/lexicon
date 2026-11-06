/**
 * `lexicon terms add`: the deterministic term write -- explicit --heard
 * aliases only, no suggestions, a second identical run reports `unchanged`
 * -- and `lexicon terms` delegating the table to `list`. Handlers run
 * against real lexicon files in a temp directory, as packs.test.ts does.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLexiconFile } from '../src/core/index.js';
import { runTermsAdd } from '../src/cli/cmd-terms.js';
import type { TermsAddOptions } from '../src/cli/cmd-terms.js';
import { runList } from '../src/cli/commands.js';
import { buildProgram } from '../src/cli/program.js';
import { makeIO } from './helpers.js';

describe('lexicon terms', () => {
  let dir: string;
  let globalPath: string;
  let savedPath: string | undefined;

  beforeEach(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-terms-')));
    globalPath = path.join(dir, 'lexicon.yaml');
    savedPath = process.env.LEXICON_PATH;
    process.env.LEXICON_PATH = globalPath;
  });

  afterEach(async () => {
    if (savedPath === undefined) delete process.env.LEXICON_PATH;
    else process.env.LEXICON_PATH = savedPath;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const addOpts = (over: Partial<TermsAddOptions> = {}): TermsAddOptions => ({ cwd: dir, globalPath, ...over });

  it('terms add writes exactly what --heard says, nothing more', async () => {
    const io = makeIO();
    expect(await runTermsAdd('locus', addOpts({ heard: ['Lucas'], context: ['ashlr', 'phantom'], json: true }), io)).toBe(0);
    const doc = JSON.parse(io.out) as Record<string, unknown>;
    expect(doc).toMatchObject({ ok: true, created: true, scope: 'global', path: globalPath });
    expect(doc.term).toMatchObject({ canonical: 'locus', aliases: ['Lucas'], context: ['ashlr', 'phantom'] });
    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms).toHaveLength(1);
    // None of `add`'s suggested aliases sneaked in.
    expect(file.lexicon.terms[0].aliases).toEqual(['Lucas']);
    expect(file.lexicon.terms[0].context).toEqual(['ashlr', 'phantom']);
  });

  it('a second identical run changes nothing: deterministic and idempotent', async () => {
    const args = (): [string, TermsAddOptions] => ['locus', addOpts({ heard: ['Lucas', 'lucus'], json: true })];
    expect(await runTermsAdd(...args(), makeIO())).toBe(0);
    const first = await fs.readFile(globalPath, 'utf8');
    const io = makeIO();
    expect(await runTermsAdd(...args(), io)).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ ok: true, created: false, unchanged: true });
    expect(await fs.readFile(globalPath, 'utf8')).toBe(first);
    // Merging a new alias is a change; repeating that call is not.
    expect(await runTermsAdd('locus', addOpts({ heard: ['locas'], json: true }), makeIO())).toBe(0);
    const again = makeIO();
    await runTermsAdd('locus', addOpts({ heard: ['locas'], json: true }), again);
    expect(JSON.parse(again.out)).toMatchObject({ unchanged: true });
  });

  it('refuses a call with no --heard rather than inventing aliases', async () => {
    const io = makeIO();
    expect(await runTermsAdd('locus', addOpts({ json: true }), io)).toBe(1);
    expect(JSON.parse(io.out)).toMatchObject({ ok: false });
    expect(JSON.parse(io.out).error).toMatch(/--heard/);
    await expect(fs.stat(globalPath)).rejects.toThrow();
  });

  it('writes context only when given, so the file has no empty list', async () => {
    await runTermsAdd('Starks', addOpts({ heard: ['storks'] }), makeIO());
    expect(await fs.readFile(globalPath, 'utf8')).not.toContain('context');
    await runTermsAdd('locus', addOpts({ heard: ['Lucas'], context: ['phantom'] }), makeIO());
    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms.find((t) => t.canonical === 'locus')?.context).toEqual(['phantom']);
    expect(file.lexicon.terms.find((t) => t.canonical === 'Starks')?.context).toBeUndefined();
  });

  it('context words merge into an existing term case-insensitively', async () => {
    await runTermsAdd('locus', addOpts({ heard: ['Lucas'], context: ['ashlr'] }), makeIO());
    await runTermsAdd('locus', addOpts({ heard: ['Lucas'], context: ['Ashlr', 'phantom'] }), makeIO());
    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms[0].context).toEqual(['ashlr', 'phantom']);
  });

  it('a blank context word is refused and nothing is written', async () => {
    const io = makeIO();
    expect(await runTermsAdd('locus', addOpts({ heard: ['Lucas'], context: ['  '] }), io)).toBe(1);
    await expect(fs.stat(globalPath)).rejects.toThrow();
  });

  it('the commander wiring reaches the same handler: terms add, then terms --json', async () => {
    const program = buildProgram(makeIO());
    await program.parseAsync(['node', 'lexicon', 'terms', 'add', 'locus', '--heard', 'Lucas', '--context', 'phantom']);
    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms[0]).toMatchObject({ canonical: 'locus', aliases: ['Lucas'], context: ['phantom'] });

    // `lexicon terms --json` is runList's bare array.
    const io = makeIO();
    expect(await runList({ cwd: dir, json: true }, io)).toBe(0);
    expect(JSON.parse(io.out)).toEqual([expect.objectContaining({ canonical: 'locus', aliases: ['Lucas'] })]);
  });
});
