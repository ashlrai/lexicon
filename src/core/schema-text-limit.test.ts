/**
 * The `text` limit of docs/CONTRACT.md's LIMITS paragraph: 200 characters on
 * a term's free-text fields, `notes` and `phonetic`. It is measured in code
 * points on the cleaned value (invisible characters stripped, ends trimmed),
 * so a raw field longer than 200 can land exactly on it, while one that
 * still cleans to 201 is refused. There is no minimum: a field that cleans
 * to nothing parses as the empty string, where a canonical would be refused
 * as empty. The write path runs the same schema, so addTerm/addTerms refuse
 * an over-limit text field as `term not added: ... Nothing was written`
 * before any file is touched.
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

const atLimit = 't'.repeat(LIMITS.text);
const overLimit = `${atLimit}t`;

describe('the text limit (LIMITS.text)', () => {
  it('is 200, the number docs/CONTRACT.md documents', () => {
    expect(LIMITS.text).toBe(200);
  });

  it.each([
    { field: 'notes' as const, path: 'terms[0].notes' },
    { field: 'phonetic' as const, path: 'terms[0].phonetic' },
  ])('accepts a $field at the limit and refuses it past the limit', ({ field, path: at }) => {
    expect(parseLexicon({ terms: [{ canonical: 'X', [field]: atLimit }] }).terms[0][field]).toBe(atLimit);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', [field]: overLimit }] })).toThrow(
      `Invalid lexicon:\n  - ${at}: must be at most 200 characters`,
    );
    // Far past the boundary is the same refusal, not a worse one.
    expect(() => parseLexicon({ terms: [{ canonical: 'X', [field]: 't'.repeat(1000) }] })).toThrow(
      `${at}: must be at most 200 characters`,
    );
  });

  it('counts code points, not UTF-16 units: 200 emoji fit', () => {
    // 200 characters that take 400 code units on the wire still pass, so the
    // cap is the character count a reader sees, not the byte budget of a
    // file format.
    const emoji = '\u{1F642}'.repeat(LIMITS.text);
    expect(emoji).toHaveLength(LIMITS.text * 2);
    expect(parseLexicon({ terms: [{ canonical: 'X', notes: emoji }] }).terms[0].notes).toBe(emoji);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: `${emoji}\u{1F642}` }] })).toThrow(
      /terms\[0\]\.notes: must be at most 200 characters/,
    );
  });

  it('measures the cleaned text: invisibles and padding are stripped before the count', () => {
    // 201 code units on the wire, 200 once the zero-width space is gone.
    const raw = `${'t'.repeat(100)}${ZW}${'t'.repeat(100)}`;
    expect(Array.from(raw)).toHaveLength(LIMITS.text + 1);
    expect(parseLexicon({ terms: [{ canonical: 'X', notes: raw }] }).terms[0].notes).toBe(atLimit);
    expect(parseLexicon({ terms: [{ canonical: 'X', notes: `  ${atLimit}  ` }] }).terms[0].notes).toBe(atLimit);

    // Stripping does not rescue a field that stays over the limit without it.
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: `${atLimit}${ZW}t` }] })).toThrow(
      /terms\[0\]\.notes: must be at most 200 characters/,
    );
  });

  it('has no minimum: a field that cleans to nothing parses as the empty string', () => {
    // Whitespace and invisibles are stripped before validation and there is
    // no min(1) on a text field, so they read as absent content rather than
    // as a problem. Even newlines are trimmed away before the control
    // check runs, so this is not refused as a control character.
    const lex = parseLexicon({ terms: [{ canonical: 'X', notes: '   ', phonetic: `\n${ZW}\n` }] });
    expect(lex.terms[0].notes).toBe('');
    expect(lex.terms[0].phonetic).toBe('');
  });

  it.each([
    { what: 'a newline', text: `line one\nline two` },
    { what: 'a tab', text: `a\tb` },
    { what: 'NEL (U+0085)', text: `a\u0085b` },
    { what: 'U+2028', text: `a\u2028b` },
    { what: 'U+2029', text: `a\u2029b` },
  ])('still refuses $what under the cap', ({ text }) => {
    // CONTRACT.md: no control characters or line breaks in any field, the
    // Unicode line separators and NEL named. The cap and the content rule
    // are independent: a 3-line field of 10 characters is as refused as a
    // 201-character one.
    expect(text.length).toBeLessThan(LIMITS.text);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: text }] })).toThrow(
      /terms\[0\]\.notes: must not contain control characters or newlines/,
    );
  });

  it('lists every violation, field by field', () => {
    // Both problems on one field are reported, not just the first: an
    // interior newline survives the trim, so it is over the cap *and* a
    // line break.
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: `${'a'.repeat(100)}\n${'b'.repeat(100)}` }] })).toThrow(
      /terms\[0\]\.notes: must be at most 200 characters[\s\S]*terms\[0\]\.notes: must not contain control characters or newlines/,
    );
    // And the two free-text fields each get their own path.
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: overLimit, phonetic: overLimit }] })).toThrow(
      /terms\[0\]\.phonetic: must be at most 200 characters[\s\S]*terms\[0\]\.notes: must be at most 200 characters/,
    );
    // A field over the cap that also holds an unencodable code unit is
    // reported for both, the term-level check naming the term.
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: `${overLimit}\uFFFE` }] })).toThrow(
      /terms\[0\]\.notes: must be at most 200 characters[\s\S]*terms\[0\]\.notes: must not contain U\+FFFE \([^)]*\) in term "X"/,
    );
  });

  it('does not loosen the word fields: a canonical past 80 is still refused at the word cap', () => {
    const between = 'w'.repeat(100); // over the word cap, under the text cap
    expect(() => parseLexicon({ terms: [{ canonical: between }] })).toThrow(
      /terms\[0\]\.canonical: must be at most 80 characters/,
    );
  });

  it('reaches only notes and phonetic: createdAt keeps its own 64 cap, settings.phonetic is a flag', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 'X', createdAt: 'c'.repeat(100) }] })).toThrow(
      /terms\[0\]\.createdAt: must be at most 64 characters/,
    );
    expect(() => parseLexicon({ settings: { phonetic: 'x'.repeat(201) } })).toThrow(
      /settings\.phonetic: Invalid input: expected boolean, received string/,
    );
  });
});

describe('the same text limit on the write path', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-text-limit-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const opts = () => ({ globalPath, home: tmp });

  it('writes notes and phonetic at the limit verbatim, and they read back', async () => {
    const { term, created } = await addTerm({ canonical: 'X', aliases: [], notes: atLimit, phonetic: atLimit }, opts());
    expect(created).toBe(true);
    expect(term.notes).toBe(atLimit);
    expect(term.phonetic).toBe(atLimit);

    const yaml = await fs.readFile(globalPath, 'utf8');
    expect(parseLexicon(parseYaml(yaml)).terms[0]).toMatchObject({ notes: atLimit, phonetic: atLimit });
  });

  it.each([
    { field: 'notes' as const, error: 'notes: must be at most 200 characters' },
    { field: 'phonetic' as const, error: 'phonetic: must be at most 200 characters' },
  ])('refuses a $field one character over and writes nothing', async ({ field, error }) => {
    const term: Term = { canonical: 'X', aliases: [], [field]: overLimit };
    await expect(addTerm(term, opts())).rejects.toThrow(
      `term not added: ${error}. Nothing was written; fix that field and try again.`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('joins every violation into one refusal', async () => {
    // Two over-limit fields: phonetic leads because it is the earlier field
    // in the term schema.
    await expect(
      addTerm({ canonical: 'X', aliases: [], notes: overLimit, phonetic: overLimit }, opts()),
    ).rejects.toThrow(
      'term not added: phonetic: must be at most 200 characters; notes: must be at most 200 characters. Nothing was written; fix those fields and try again.',
    );
    expect(existsSync(globalPath)).toBe(false);

    // Two problems on one field: over the cap and a line break inside it.
    await expect(
      addTerm({ canonical: 'X', aliases: [], notes: `${'a'.repeat(100)}\n${'b'.repeat(100)}` }, opts()),
    ).rejects.toThrow(
      'term not added: notes: must be at most 200 characters; notes: must not contain control characters or newlines. Nothing was written; fix those fields and try again.',
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('cleans before measuring: notes that strip to the limit are written without the invisible', async () => {
    const { term } = await addTerm({ canonical: 'X', aliases: [], notes: `${'t'.repeat(100)}${ZW}${'t'.repeat(100)}` }, opts());
    expect(term.notes).toBe(atLimit);
    // The file holds the cleaned text, so its next read does not drop a character it was carrying.
    const yaml = await fs.readFile(globalPath, 'utf8');
    expect(yaml).not.toContain(ZW);
    expect(parseLexicon(parseYaml(yaml)).terms[0].notes).toBe(atLimit);
  });

  it('writes a blank text field as the empty string, not as a refusal', async () => {
    const { term } = await addTerm({ canonical: 'X', aliases: [], notes: ` ${ZW} ` }, opts());
    expect(term.notes).toBe('');
    expect(parseLexicon(parseYaml(await fs.readFile(globalPath, 'utf8'))).terms[0].notes).toBe('');
  });

  it('refuses the whole addTerms batch on one over-limit text field', async () => {
    await expect(
      addTerms([{ canonical: 'Fine', aliases: [] }, { canonical: 'X', aliases: [], notes: overLimit }], opts()),
    ).rejects.toThrow('term not added: notes: must be at most 200 characters. Nothing was written; fix that field and try again.');
    expect(existsSync(globalPath)).toBe(false);
  });

  it('leaves an existing file byte-for-byte untouched on a refused write', async () => {
    await addTerm({ canonical: 'Existing', aliases: [] }, opts());
    const before = await fs.readFile(globalPath, 'utf8');
    await expect(addTerm({ canonical: 'X', aliases: [], phonetic: overLimit }, opts())).rejects.toThrow('term not added:');
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
  });
});
