/**
 * The alias end of docs/CONTRACT.md's `word` limit: `LIMITS.word` (80
 * characters) on every entry of a term's `aliases` list. It is measured in
 * code points on the cleaned spelling (invisible characters stripped, ends
 * trimmed, empties dropped before the index is counted), so a raw alias
 * longer than 80 can land exactly on it, while one that still cleans to 81
 * is refused at `terms[<n>].aliases[<i>]`. The cap is per entry and
 * independent of the list cap (`LIMITS.aliases`): sixty-four 80-character
 * aliases all fit.
 *
 * The write path runs the same schema, so `addTerm`/`addTerms` refuse an
 * over-limit alias as `term not added: aliases[<i>] ("<first 24 code
 * units>..."): must be at most 80 characters. Nothing was written` before
 * any file is touched.
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
const EMOJI = '\u{1F642}'; // one code point, two UTF-16 code units

const atLimit = 'a'.repeat(LIMITS.word);
const overLimit = `${atLimit}a`;

const lexiconWith = (aliases: string[]) => ({ terms: [{ canonical: 'X', aliases }] });

describe('the alias word limit (LIMITS.word on aliases entries)', () => {
  it('is 80, the number docs/CONTRACT.md documents for a canonical or alias', () => {
    expect(LIMITS.word).toBe(80);
  });

  it('accepts an alias at the limit and refuses one a code unit beyond it', () => {
    expect(parseLexicon(lexiconWith([atLimit])).terms[0].aliases).toEqual([atLimit]);
    expect(() => parseLexicon(lexiconWith([overLimit]))).toThrow(
      `Invalid lexicon:\n  - terms[0].aliases[0]: must be at most ${LIMITS.word} characters`,
    );
    // Far past the boundary is the same refusal, not a worse one.
    expect(() => parseLexicon(lexiconWith(['a'.repeat(1000)]))).toThrow(
      /terms\[0\]\.aliases\[0\]: must be at most 80 characters/,
    );
  });

  it('counts code points, not UTF-16 units: 80 emoji fit', () => {
    // The cap is the character count a reader sees, not the byte budget of a
    // file format: 80 code points pass even at 160 code units on the wire,
    // and an alias one code unit over the cap but under it in code points
    // (79 letters + one emoji = 81 units, 80 points) is inside the limit.
    const emoji = EMOJI.repeat(LIMITS.word);
    expect(emoji).toHaveLength(LIMITS.word * 2);
    expect(parseLexicon(lexiconWith([emoji])).terms[0].aliases).toEqual([emoji]);
    expect(parseLexicon(lexiconWith([`${'a'.repeat(79)}${EMOJI}`])).terms[0].aliases).toEqual([
      `${'a'.repeat(79)}${EMOJI}`,
    ]);
    expect(() => parseLexicon(lexiconWith([EMOJI.repeat(LIMITS.word + 1)]))).toThrow(
      /terms\[0\]\.aliases\[0\]: must be at most 80 characters/,
    );
  });

  it('measures the cleaned alias: invisibles and padding are stripped before the count', () => {
    // 81 code units on the wire, 80 once the zero-width space is gone, and
    // the stored alias does not carry the stripped character.
    const raw = `${'a'.repeat(40)}${ZW}${'a'.repeat(40)}`;
    expect(raw).toHaveLength(LIMITS.word + 1);
    expect(parseLexicon(lexiconWith([raw])).terms[0].aliases).toEqual([atLimit]);
    expect(parseLexicon(lexiconWith([`  ${atLimit}  `])).terms[0].aliases).toEqual([atLimit]);

    // Stripping does not rescue an alias that stays over the limit without it.
    expect(() => parseLexicon(lexiconWith([`${atLimit}${ZW}a`]))).toThrow(
      /terms\[0\]\.aliases\[0\]: must be at most 80 characters/,
    );
  });

  it('applies at every position: an over-limit alias is named by its index', () => {
    expect(parseLexicon(lexiconWith(['one', atLimit, 'two'])).terms[0].aliases).toEqual(['one', atLimit, 'two']);
    expect(() => parseLexicon(lexiconWith(['one', 'two', overLimit]))).toThrow(
      /terms\[0\]\.aliases\[2\]: must be at most 80 characters/,
    );
  });

  it('drops blank entries before the boundary is checked', () => {
    // Empties are removed by the same transform that trims, so a blank line
    // in hand-edited YAML is not a word that fails the cap: the entries that
    // survive are what the limit and the error index count.
    expect(parseLexicon(lexiconWith(['', '  ', ZW, atLimit])).terms[0].aliases).toEqual([atLimit]);
  });

  it('is per entry, not per list: LIMITS.aliases aliases at the limit all fit', () => {
    const full = Array.from({ length: LIMITS.aliases }, (_, i) => `${'a'.repeat(LIMITS.word - String(i).length)}${i}`);
    for (const alias of full) expect(alias).toHaveLength(LIMITS.word);
    expect(parseLexicon(lexiconWith(full)).terms[0].aliases).toEqual(full);
  });
});

describe('the same alias limit on the write path', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-alias-limit-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const opts = () => ({ globalPath, home: tmp });

  it('writes an alias at the limit verbatim, and it reads back', async () => {
    const { term, created } = await addTerm({ canonical: 'X', aliases: [atLimit] }, opts());
    expect(created).toBe(true);
    expect(term.aliases).toEqual([atLimit]);

    const yaml = await fs.readFile(globalPath, 'utf8');
    expect(parseLexicon(parseYaml(yaml)).terms[0].aliases).toEqual([atLimit]);
  });

  it('refuses an alias a code unit over the limit and writes nothing', async () => {
    const shown = JSON.stringify(`${'a'.repeat(24)}...`);
    await expect(addTerm({ canonical: 'X', aliases: [overLimit] }, opts())).rejects.toThrow(
      `term not added: aliases[0] (${shown}): must be at most 80 characters. Nothing was written; fix that field and try again.`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('names the offending entry by its index and quotes it cut to 24 code units', async () => {
    // The quote is a diagnostic, so it is cut in code units (half an emoji
    // pair would still print), while the limit itself counts code points.
    const shownEmoji = JSON.stringify(`${EMOJI.repeat(12)}...`);
    await expect(addTerm({ canonical: 'X', aliases: [EMOJI.repeat(81)] }, opts())).rejects.toThrow(
      `term not added: aliases[0] (${shownEmoji}): must be at most 80 characters.`,
    );
    await expect(addTerm({ canonical: 'X', aliases: ['ok', overLimit] }, opts())).rejects.toThrow(
      'term not added: aliases[1] (',
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('refuses the whole addTerms batch on one over-limit alias', async () => {
    const terms: Term[] = [
      { canonical: 'Fine', aliases: ['ok'] },
      { canonical: 'Other', aliases: [overLimit] },
    ];
    await expect(addTerms(terms, opts())).rejects.toThrow(
      'term not added: aliases[0] (',
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('leaves an existing file byte-for-byte untouched on a refused merge', async () => {
    await addTerm({ canonical: 'X', aliases: ['ok'] }, opts());
    const before = await fs.readFile(globalPath, 'utf8');
    // An over-limit alias merged into the existing term is refused before
    // the merge, so nothing the file already held changes.
    await expect(addTerm({ canonical: 'X', aliases: [overLimit] }, opts())).rejects.toThrow('term not added:');
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
  });
});
