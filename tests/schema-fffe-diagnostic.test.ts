import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { learnCorrection } from '../src/core/learn.js';
import { UNENCODABLE_NOTE, escapeUnencodable, parseLexicon } from '../src/core/schema.js';
import { addTerm, addTerms } from '../src/core/store.js';
import type { Term } from '../src/core/types.js';

const FFFE = '\uFFFE';
const reason = `must not contain U+FFFE (${UNENCODABLE_NOTE})`;

// docs/CONTRACT.md: U+FFFE is a Unicode noncharacter no lexicon file format
// can carry, and every diagnostic that reports it identifies the code unit
// as text - "U+FFFE" in the reason, \uFFFE where a value is shown - never
// echoing the raw unit into a terminal, log or model context it could not be
// written back from. The read path (the zod issues and the parseLexicon
// error at every field) is pinned per field by schema-fields-fffe.test.ts
// and per position by schema-canonical-fffe.test.ts. This file pins the
// write path the same contract paragraph promises: addTerm, addTerms and
// learnCorrection, the calls behind the CLI, the MCP tools, POST /add and
// POST /learn, refuse as `term not added: <field> (<entry>): ...` and write
// nothing, where <entry> is JSON.stringify of the offending list item with
// the unit written \uFFFE.

describe('the diagnostic identifies U+FFFE as text, never raw', () => {
  it('escapeUnencodable writes U+FFFE as \\uFFFE and changes nothing else', () => {
    expect(escapeUnencodable(`Ash${FFFE}lr`)).toBe('Ash\\uFFFElr');
    expect(escapeUnencodable(`${FFFE}a${FFFE}`)).toBe('\\uFFFEa\\uFFFE');
    // A surrogate pair and a literal backslash-u are not code units to escape.
    expect(escapeUnencodable('Rocket 🚀')).toBe('Rocket 🚀');
    expect(escapeUnencodable('a\\uFFFEb')).toBe('a\\uFFFEb');
  });

  it('parseLexicon names the code unit at each field path and echoes no raw unit', () => {
    let message = '';
    try {
      parseLexicon({ terms: [{ canonical: `Ash${FFFE}lr`, aliases: [`a${FFFE}`], notes: `n${FFFE}` }] });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    expect(message).toBe(
      'Invalid lexicon:\n' +
        `  - terms[0].canonical: ${reason} in term "Ash\\uFFFElr"\n` +
        `  - terms[0].aliases[0]: ${reason} in term "Ash\\uFFFElr"\n` +
        `  - terms[0].notes: ${reason} in term "Ash\\uFFFElr"`,
    );
    expect(message).not.toContain(FFFE);
  });
});

describe('the write path identifies U+FFFE and writes nothing', () => {
  let tmp: string;
  let globalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-fffe-'));
    globalPath = path.join(tmp, 'lexicon.yaml');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  const opts = () => ({ globalPath, home: tmp });

  // The `term not added: <field> (...)` the contract promises: a list entry's
  // `(...)` shows it JSON-quoted with the unit written \uFFFE.
  const WRITE_FIELDS: ReadonlyArray<readonly [string, () => Term, string]> = [
    ['canonical', () => ({ canonical: `Ash${FFFE}lr`, aliases: [] }), `canonical: ${reason} in term "Ash\\uFFFElr"`],
    ['an alias', () => ({ canonical: 'X', aliases: ['ok', `a${FFFE}b`] }), `aliases[1] ("a\\uFFFEb"): ${reason} in term "X"`],
    ['a never word', () => ({ canonical: 'X', aliases: [], never: [`n${FFFE}`] }), `never[0] ("n\\uFFFE"): ${reason} in term "X"`],
    ['a context word', () => ({ canonical: 'X', aliases: [], context: [`c${FFFE}`] }), `context[0] ("c\\uFFFE"): ${reason} in term "X"`],
    ['phonetic', () => ({ canonical: 'X', aliases: [], phonetic: `p${FFFE}` }), `phonetic: ${reason} in term "X"`],
    ['notes', () => ({ canonical: 'X', aliases: [], notes: `n${FFFE}` }), `notes: ${reason} in term "X"`],
    ['createdAt', () => ({ canonical: 'X', aliases: [], createdAt: `2026${FFFE}` }), `createdAt: ${reason} in term "X"`],
  ];

  it.each(WRITE_FIELDS)('addTerm refuses U+FFFE in %s, naming it as text, and writes nothing', async (_field, makeTerm, refusal) => {
    const err = await addTerm(makeTerm(), opts()).catch((e: unknown) => e);
    const message = err instanceof Error ? err.message : '';
    expect(message).toBe(`term not added: ${refusal}. Nothing was written; fix that field and try again.`);
    expect(message).not.toContain(FFFE);
    expect(existsSync(globalPath)).toBe(false);
  });

  it('refuses the whole addTerms batch when one term carries U+FFFE, leaving an existing file untouched', async () => {
    await addTerm({ canonical: 'Existing', aliases: [] }, opts());
    const before = await fs.readFile(globalPath, 'utf8');
    await expect(addTerms([{ canonical: 'Fine', aliases: [] }, { canonical: `Bad${FFFE}`, aliases: [] }], opts())).rejects.toThrow(
      `term not added: canonical: ${reason} in term "Bad\\uFFFE". Nothing was written`,
    );
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
  });

  it('learnCorrection refuses a heard carrying U+FFFE, on a new term and on a merge', async () => {
    // meant names no term yet: heard becomes aliases[0] of the created term.
    await expect(learnCorrection({ heard: `a${FFFE}b`, meant: 'Fresh' }, opts())).rejects.toThrow(
      `term not added: aliases[0] ("a\\uFFFEb"): ${reason} in term "Fresh". Nothing was written`,
    );
    // meant names an existing term: the same refusal names that term.
    await addTerm({ canonical: 'SaaS', aliases: ['sass'] }, opts());
    const before = await fs.readFile(globalPath, 'utf8');
    await expect(learnCorrection({ heard: `sa${FFFE}s`, meant: 'SaaS' }, opts())).rejects.toThrow(
      `term not added: aliases[0] ("sa\\uFFFEs"): ${reason} in term "SaaS". Nothing was written`,
    );
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
  });

  it('learnCorrection refuses a meant carrying U+FFFE, naming the canonical', async () => {
    await expect(learnCorrection({ heard: 'Ashler', meant: `Ash${FFFE}lr` }, opts())).rejects.toThrow(
      `term not added: canonical: ${reason} in term "Ash\\uFFFElr". Nothing was written`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('escapes U+FFFE inside a non-string entry the blank-entry refusal echoes', async () => {
    // A list entry that is not a string counts as blank; its JSON.stringify
    // echo would otherwise carry a raw U+FFFE inside a nested string.
    const term = { canonical: 'X', aliases: [{ word: `a${FFFE}b` }] } as unknown as Term;
    const err = await addTerm(term, opts()).catch((e: unknown) => e);
    const message = err instanceof Error ? err.message : '';
    expect(message).toBe(
      'term not added: aliases[0] ({"word":"a\\uFFFEb"}) is blank. Nothing was written; drop that entry or give the word and try again.',
    );
    expect(message).not.toContain(FFFE);
    expect(existsSync(globalPath)).toBe(false);
  });

  it('names U+FFFE even when it falls past the cut of the echoed entry', async () => {
    // The `(...)` of `term not added` shows at most 24 characters of the
    // entry: a unit further in is cut from the preview but still identified
    // in the reason.
    const alias = `${'a'.repeat(24)}${FFFE}tail`;
    const err = await addTerm({ canonical: 'X', aliases: [alias] }, opts()).catch((e: unknown) => e);
    const message = err instanceof Error ? err.message : '';
    expect(message).toBe(
      `term not added: aliases[0] ("${'a'.repeat(24)}..."): ${reason} in term "X". Nothing was written; fix that field and try again.`,
    );
    expect(message).not.toContain(FFFE);
    expect(existsSync(globalPath)).toBe(false);
  });
});
