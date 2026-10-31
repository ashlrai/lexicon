/**
 * The `word` limit of docs/CONTRACT.md's LIMITS paragraph: 80 characters on a
 * canonical and on every word-list entry (an alias, a never word, a protected
 * word, a pack name). It is measured in code points on the cleaned spelling
 * (invisible characters stripped, ends trimmed), so a raw field longer than
 * 80 can land exactly on it, while a field that still cleans to 81 is
 * refused. The write path runs the same schema, so addTerm/addTerms refuse an
 * over-limit word as `term not added: ... Nothing was written` before any
 * file is touched.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, parseLexicon } from './schema.js';
import { addTerm, addTerms } from './store.js';
import type { Term } from './types.js';

const ZW = '\u200b'; // a zero-width space: stripped before the limit is measured

const atLimit = 'w'.repeat(LIMITS.word);
const overLimit = `${atLimit}w`;

/** The field value written into a list-entry error message (first 24 chars + "..."). */
const shownWord = JSON.stringify(`${'w'.repeat(24)}...`);

describe('the word limit (LIMITS.word)', () => {
  it('is 80, the number docs/CONTRACT.md documents', () => {
    expect(LIMITS.word).toBe(80);
  });

  it.each([
    { field: 'a canonical', input: (w: string) => ({ terms: [{ canonical: w }] }), path: 'terms[0].canonical' },
    { field: 'an alias', input: (w: string) => ({ terms: [{ canonical: 'X', aliases: [w] }] }), path: 'terms[0].aliases[0]' },
    { field: 'a never word', input: (w: string) => ({ terms: [{ canonical: 'X', never: [w] }] }), path: 'terms[0].never[0]' },
    { field: 'a protected word', input: (w: string) => ({ settings: { protectedWords: [w] } }), path: 'settings.protectedWords[0]' },
    { field: 'a pack name', input: (w: string) => ({ settings: { packs: [w] } }), path: 'settings.packs[0]' },
  ])('accepts $field at the limit and refuses it one character over', ({ input, path: at }) => {
    expect(parseLexicon(input(atLimit))).toMatchObject(input(atLimit));
    expect(() => parseLexicon(input(overLimit))).toThrow(`Invalid lexicon:\n  - ${at}: must be at most 80 characters`);
  });

  it('measures the cleaned word: invisibles and padding are stripped before the count', () => {
    // 81 code units on the wire, 80 once the zero-width space is gone.
    const raw = `${'w'.repeat(40)}${ZW}${'w'.repeat(40)}`;
    expect(Array.from(raw)).toHaveLength(LIMITS.word + 1);
    expect(parseLexicon({ terms: [{ canonical: raw }] }).terms[0].canonical).toBe(atLimit);
    expect(parseLexicon({ terms: [{ canonical: `  ${atLimit}  ` }] }).terms[0].canonical).toBe(atLimit);

    // Stripping does not rescue a word that stays over the limit without it.
    expect(() => parseLexicon({ terms: [{ canonical: `${atLimit}${ZW}w` }] })).toThrow(
      /terms\[0\]\.canonical: must be at most 80 characters/,
    );
  });

  it('reports a canonical that cleans to nothing as empty, not as over the limit', () => {
    // min(1) runs on the cleaned value, so 81 strippable characters read as "".
    expect(() => parseLexicon({ terms: [{ canonical: `${' '.repeat(40)}${ZW.repeat(41)}` }] })).toThrow(
      /terms\[0\]\.canonical: must not be empty/,
    );
  });

  it('counts code points without normalizing: combining marks count separately', () => {
    // The schema never folds input to NFC, so 'é' written decomposed is two
    // code points: a name that looks 40 characters long can already be at the
    // cap, and its composed twin fits 80 of them.
    const decomposed = 'e\u0301';
    const composed = '\u00e9';
    expect(parseLexicon({ terms: [{ canonical: decomposed.repeat(40) }] }).terms[0].canonical).toBe(decomposed.repeat(40));
    expect(parseLexicon({ terms: [{ canonical: composed.repeat(80) }] }).terms[0].canonical).toBe(composed.repeat(80));
    expect(() => parseLexicon({ terms: [{ canonical: decomposed.repeat(41) }] })).toThrow(
      /terms\[0\]\.canonical: must be at most 80 characters/,
    );
  });

  it('lists every violation, field by field', () => {
    // Both problems on one canonical are reported, not just the first.
    expect(() => parseLexicon({ terms: [{ canonical: `${atLimit}\nw` }] })).toThrow(
      /terms\[0\]\.canonical: must be at most 80 characters[\s\S]*terms\[0\]\.canonical: must not contain control characters or newlines/,
    );
    // And two over-limit fields each get their own path.
    expect(() => parseLexicon({ terms: [{ canonical: overLimit, aliases: ['ok', overLimit] }] })).toThrow(
      /terms\[0\]\.canonical: must be at most 80 characters[\s\S]*terms\[0\]\.aliases\[1\]: must be at most 80 characters/,
    );
  });

  it('indexes a word-list error at its position after empties are dropped', () => {
    // Blank entries are dropped before validation, so the path counts the
    // entries that remain rather than the lines of the file.
    expect(() => parseLexicon({ terms: [{ canonical: 'X', aliases: ['', '  ', overLimit] }] })).toThrow(
      /terms\[0\]\.aliases\[0\]: must be at most 80 characters/,
    );
  });

  it('does not reach the free-text fields: notes and phonetic use the 200 text cap', () => {
    const between = 't'.repeat(100); // over the word cap, under the text cap
    const lex = parseLexicon({ terms: [{ canonical: 'X', notes: between, phonetic: between }] });
    expect(lex.terms[0].notes).toBe(between);
    expect(lex.terms[0].phonetic).toBe(between);
  });
});

describe('the same word limit on the write path', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-word-limit-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const opts = () => ({ globalPath, home: tmp });

  it('writes a canonical and alias at the limit verbatim, and they read back', async () => {
    const alias = 'a'.repeat(LIMITS.word);
    const { term, created } = await addTerm({ canonical: atLimit, aliases: [alias] }, opts());
    expect(created).toBe(true);
    expect(term.canonical).toBe(atLimit);
    expect(term.aliases).toEqual([alias]);

    const yaml = await fs.readFile(globalPath, 'utf8');
    expect(parseLexicon(parseYaml(yaml)).terms[0]).toMatchObject({ canonical: atLimit, aliases: [alias] });
  });

  it.each([
    {
      what: 'a canonical',
      term: (): Term => ({ canonical: overLimit, aliases: [] }),
      error: 'canonical: must be at most 80 characters',
    },
    {
      what: 'an alias',
      term: (): Term => ({ canonical: 'X', aliases: [overLimit] }),
      error: `aliases[0] (${shownWord}): must be at most 80 characters`,
    },
    {
      what: 'a never word',
      term: (): Term => ({ canonical: 'X', aliases: [], never: [overLimit] }),
      error: `never[0] (${shownWord}): must be at most 80 characters`,
    },
  ])('refuses $what over the limit and writes nothing', async ({ term, error }) => {
    await expect(addTerm(term(), opts())).rejects.toThrow(
      `term not added: ${error}. Nothing was written; fix that field and try again.`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('joins every violation on a term into one refusal', async () => {
    await expect(addTerm({ canonical: `${atLimit}\nw`, aliases: [] }, opts())).rejects.toThrow(
      'term not added: canonical: must be at most 80 characters; canonical: must not contain control characters or newlines. Nothing was written; fix those fields and try again.',
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('cleans before measuring: a canonical that strips to the limit is written without the invisible', async () => {
    const { term } = await addTerm({ canonical: `${'w'.repeat(40)}${ZW}${'w'.repeat(40)}`, aliases: [] }, opts());
    expect(term.canonical).toBe(atLimit);
    // The file holds the cleaned word, so its next read does not drop a character it was carrying.
    const yaml = await fs.readFile(globalPath, 'utf8');
    expect(yaml).not.toContain(ZW);
    expect(parseLexicon(parseYaml(yaml)).terms[0].canonical).toBe(atLimit);
  });

  it('refuses the whole addTerms batch on one over-limit term', async () => {
    await expect(
      addTerms([{ canonical: 'Fine', aliases: [] }, { canonical: overLimit, aliases: [] }], opts()),
    ).rejects.toThrow('term not added: canonical: must be at most 80 characters. Nothing was written; fix that field and try again.');
    expect(existsSync(globalPath)).toBe(false);
  });

  it('leaves an existing file byte-for-byte untouched on a refused write', async () => {
    await addTerm({ canonical: 'Existing', aliases: [] }, opts());
    const before = await fs.readFile(globalPath, 'utf8');
    await expect(addTerm({ canonical: overLimit, aliases: [] }, opts())).rejects.toThrow('term not added:');
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
  });
});
