import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { learnCorrection } from '../src/core/learn.js';
import {
  LexiconSchema,
  TermSchema,
  UNENCODABLE_NOTE,
  escapeUnencodable,
  findUnencodableChar,
  parseLexicon,
} from '../src/core/schema.js';
import { addTerm, addTerms } from '../src/core/store.js';
import type { Term } from '../src/core/types.js';

const FFFF = '￿';
const reason = `must not contain U+FFFF (${UNENCODABLE_NOTE})`;

// docs/CONTRACT.md: U+FFFF is a Unicode noncharacter no lexicon file format
// can carry, so the schema refuses it in every free-text field and every
// diagnostic that reports it identifies the code unit as text ("U+FFFF" in
// the reason, \uFFFF where a value is shown), never echoing the raw unit
// into a terminal, log or model context. That holds on the read path (the
// zod issues and the parseLexicon error) and on the write path, where
// addTerm, addTerms and learnCorrection refuse as
// `term not added: <field> (...): ...` and write nothing - the surface CLI,
// MCP, POST /add and POST /learn relay.
describe('U+FFFF is identified on the read path', () => {
  it('findUnencodableChar returns U+FFFF for a string holding one, undefined when there is none', () => {
    expect(findUnencodableChar(`Ash${FFFF}lr`)).toBe('U+FFFF');
    expect(findUnencodableChar(FFFF)).toBe('U+FFFF');
    expect(findUnencodableChar(`ok${FFFF}${FFFF}`)).toBe('U+FFFF');
    // The contract's escape hatches: clean text and a surrogate pair are fine.
    expect(findUnencodableChar('Ashlr.AI')).toBeUndefined();
    expect(findUnencodableChar('Rocket 🚀')).toBeUndefined();
  });

  it('UNENCODABLE_NOTE is the string the contract pins', () => {
    expect(UNENCODABLE_NOTE).toBe('U+FFFE, U+FFFF and unpaired surrogates fit no file format');
  });

  it('escapeUnencodable writes U+FFFF as \\uFFFF and changes nothing else', () => {
    expect(escapeUnencodable(`Ash${FFFF}lr`)).toBe('Ash\\uFFFFlr');
    expect(escapeUnencodable(`${FFFF}a${FFFF}`)).toBe('\\uFFFFa\\uFFFF');
    // A surrogate pair and a literal backslash-u are not code units to escape.
    expect(escapeUnencodable('Ashlr.AI 🚀')).toBe('Ashlr.AI 🚀');
    expect(escapeUnencodable('a\\uFFFFb')).toBe('a\\uFFFFb');
  });

  // One row per field the term-level check walks (TERM_TEXT_FIELDS): the term
  // object, the zod path the issue lands on and the term label the message
  // carries (the canonical itself escaped when it holds the unit).
  const FIELDS: ReadonlyArray<readonly [string, Record<string, unknown>, readonly (string | number)[], string]> = [
    ['canonical', { canonical: `Ash${FFFF}lr` }, ['canonical'], 'Ash\\uFFFFlr'],
    ['an alias', { canonical: 'X', aliases: ['ok', `a${FFFF}b`] }, ['aliases', 1], 'X'],
    ['a never word', { canonical: 'X', never: [`n${FFFF}`] }, ['never', 0], 'X'],
    ['phonetic', { canonical: 'X', phonetic: `p${FFFF}` }, ['phonetic'], 'X'],
    ['notes', { canonical: 'X', notes: `n${FFFF}` }, ['notes'], 'X'],
    ['createdAt', { canonical: 'X', createdAt: `c${FFFF}` }, ['createdAt'], 'X'],
  ];

  it.each(FIELDS)('TermSchema identifies U+FFFF in %s at its own path, naming the term', (_field, term, path, name) => {
    const result = TermSchema.safeParse(term);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(path);
    expect(result.error.issues[0]?.message).toBe(`${reason} in term "${name}"`);
  });

  it.each(FIELDS)('LexiconSchema identifies U+FFFF in %s under terms[0]', (_field, term, path, name) => {
    const result = LexiconSchema.safeParse({ terms: [term] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['terms', 0, ...path]);
    expect(result.error.issues[0]?.message).toBe(`${reason} in term "${name}"`);
  });

  it.each(['protectedWords', 'packs'] as const)('identifies U+FFFF in settings.%s with no term name', (field) => {
    const result = LexiconSchema.safeParse({ terms: [], settings: { [field]: ['ok', `w${FFFF}`] } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['settings', field, 1]);
    expect(result.error.issues[0]?.message).toBe(reason);
  });

  it('parseLexicon names U+FFFF in every offending field and echoes no raw code unit', () => {
    let message = '';
    try {
      parseLexicon({ terms: [{ canonical: `Ash${FFFF}lr`, aliases: [`a${FFFF}`], notes: `n${FFFF}` }] });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    expect(message).toBe(
      'Invalid lexicon:\n' +
        `  - terms[0].canonical: ${reason} in term "Ash\\uFFFFlr"\n` +
        `  - terms[0].aliases[0]: ${reason} in term "Ash\\uFFFFlr"\n` +
        `  - terms[0].notes: ${reason} in term "Ash\\uFFFFlr"`,
    );
    expect(message).not.toContain(FFFF);
  });
});

describe('the write path identifies U+FFFF and writes nothing', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-ffff-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const opts = () => ({ globalPath, home: tmp });

  // The `term not added: <field> (...)` the contract promises: a list entry's
  // `(...)` shows it JSON-quoted with the unit written \uFFFF.
  const WRITE_FIELDS: ReadonlyArray<readonly [string, () => Term, string]> = [
    ['canonical', () => ({ canonical: `Ash${FFFF}lr`, aliases: [] }), `canonical: ${reason} in term "Ash\\uFFFFlr"`],
    ['an alias', () => ({ canonical: 'X', aliases: ['ok', `a${FFFF}b`] }), `aliases[1] ("a\\uFFFFb"): ${reason} in term "X"`],
    ['a never word', () => ({ canonical: 'X', aliases: [], never: [`n${FFFF}`] }), `never[0] ("n\\uFFFF"): ${reason} in term "X"`],
    ['a context word', () => ({ canonical: 'X', aliases: [], context: [`c${FFFF}`] }), `context[0] ("c\\uFFFF"): ${reason} in term "X"`],
    ['phonetic', () => ({ canonical: 'X', aliases: [], phonetic: `p${FFFF}` }), `phonetic: ${reason} in term "X"`],
    ['notes', () => ({ canonical: 'X', aliases: [], notes: `n${FFFF}` }), `notes: ${reason} in term "X"`],
    ['createdAt', () => ({ canonical: 'X', aliases: [], createdAt: `2026${FFFF}` }), `createdAt: ${reason} in term "X"`],
  ];

  it.each(WRITE_FIELDS)('addTerm refuses U+FFFF in %s, naming it as text, and writes nothing', async (_field, makeTerm, refusal) => {
    const err = await addTerm(makeTerm(), opts()).catch((e: unknown) => e);
    const message = err instanceof Error ? err.message : '';
    expect(message).toBe(`term not added: ${refusal}. Nothing was written; fix that field and try again.`);
    expect(message).not.toContain(FFFF);
    expect(existsSync(globalPath)).toBe(false);
  });

  it('refuses the whole addTerms batch when one term carries U+FFFF, leaving an existing file untouched', async () => {
    await addTerm({ canonical: 'Existing', aliases: [] }, opts());
    const before = await fs.readFile(globalPath, 'utf8');
    await expect(addTerms([{ canonical: 'Fine', aliases: [] }, { canonical: `Bad${FFFF}`, aliases: [] }], opts())).rejects.toThrow(
      `term not added: canonical: ${reason} in term "Bad\\uFFFF". Nothing was written`,
    );
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
  });

  it('learnCorrection refuses a heard or meant spelling carrying U+FFFF the same way', async () => {
    await expect(learnCorrection({ heard: `a${FFFF}b`, meant: 'Ashlr.AI' }, opts())).rejects.toThrow(
      `term not added: aliases[0] ("a\\uFFFFb"): ${reason} in term "Ashlr.AI". Nothing was written`,
    );
    await expect(learnCorrection({ heard: 'Ashler', meant: `Ash${FFFF}lr` }, opts())).rejects.toThrow(
      `term not added: canonical: ${reason} in term "Ash\\uFFFFlr". Nothing was written`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('learnCorrection refuses a heard carrying U+FFFF on a merge, leaving the existing term untouched', async () => {
    // meant names an existing term: the same refusal names that term.
    await addTerm({ canonical: 'SaaS', aliases: ['sass'] }, opts());
    const before = await fs.readFile(globalPath, 'utf8');
    await expect(learnCorrection({ heard: `sa${FFFF}s`, meant: 'SaaS' }, opts())).rejects.toThrow(
      `term not added: aliases[0] ("sa\\uFFFFs"): ${reason} in term "SaaS". Nothing was written`,
    );
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
  });

  it('names U+FFFF even when it falls past the cut of the echoed entry', async () => {
    // The `(...)` of `term not added` shows at most 24 characters of the
    // entry: a unit further in is cut from the preview but still identified
    // in the reason.
    const alias = `${'a'.repeat(24)}${FFFF}tail`;
    const err = await addTerm({ canonical: 'X', aliases: [alias] }, opts()).catch((e: unknown) => e);
    const message = err instanceof Error ? err.message : '';
    expect(message).toBe(
      `term not added: aliases[0] ("${'a'.repeat(24)}..."): ${reason} in term "X". Nothing was written; fix that field and try again.`,
    );
    expect(message).not.toContain(FFFF);
    expect(existsSync(globalPath)).toBe(false);
  });

  it('escapes U+FFFF inside a non-string entry the blank-entry refusal echoes', async () => {
    // A list entry that is not a string counts as blank; its JSON.stringify
    // echo would otherwise carry a raw U+FFFF inside a nested string.
    const term = { canonical: 'X', aliases: [{ word: `a${FFFF}b` }] } as unknown as Term;
    const err = await addTerm(term, opts()).catch((e: unknown) => e);
    const message = err instanceof Error ? err.message : '';
    expect(message).toBe(
      'term not added: aliases[0] ({"word":"a\\uFFFFb"}) is blank. Nothing was written; drop that entry or give the word and try again.',
    );
    expect(message).not.toContain(FFFF);
    expect(existsSync(globalPath)).toBe(false);
  });
});
