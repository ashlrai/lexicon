import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  LexiconSchema,
  TermSchema,
  UNENCODABLE_NOTE,
  escapeUnencodable,
  findUnencodableChar,
  parseLexicon,
} from '../src/core/schema.js';

// An ISOLATED low surrogate (U+DC00 to U+DFFF): the only surrogate code unit
// in the field, with an ordinary character or a string boundary on each side,
// so nothing is there to pair with it. Round 77 refused unpaired surrogates
// because no UTF-8 file can hold one: the YAML written back was unreadable
// and the macos plist would not load. The sibling files pin mid-word and
// edge positions in canonical, aliases, never, notes and phonetic, plus the
// pair lookarounds; this one pins the refusal and the named code unit for
// the shapes they leave alone: a field that is only the unit, the context
// list, createdAt, a term deep in the file, and a unit a YAML escape carries.

const reason = (unit: string) => `must not contain ${unit} (${UNENCODABLE_NOTE})`;

describe('isolated low surrogate in a term', () => {
  it.each([
    ['U+DC00, the first low surrogate', '\uDC00', 'U+DC00'],
    ['U+DFFF, the last low surrogate', '\uDFFF', 'U+DFFF'],
  ])('rejects a canonical that is only %s, labelled by its escape', (_d, canonical, unit) => {
    const shown = `\\u${unit.slice(2)}`;
    expect(findUnencodableChar(canonical)).toBe(unit);
    expect(escapeUnencodable(canonical)).toBe(shown);

    const result = TermSchema.safeParse({ canonical });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the isolated low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['canonical'], message: `${reason(unit)} in term "${shown}"` },
    ]);
    // The diagnostic itself is encodable: the raw unit never reaches it.
    expect(result.error.issues[0].message).not.toMatch(/[\uD800-\uDFFF]/);

    expect(() => parseLexicon({ terms: [{ canonical }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: ${reason(unit)} in term "${shown}"`,
    );
  });

  it('rejects an isolated low surrogate in the context list at its index', () => {
    const result = LexiconSchema.safeParse({
      terms: [{ canonical: 'Ashlr.AI', context: ['deploy', 'prod\uDC00'] }],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the isolated low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'context', 1], message: `${reason('U+DC00')} in term "Ashlr.AI"` },
    ]);
    expect(() => parseLexicon({ terms: [{ canonical: 'Ashlr.AI', context: ['prod\uDC00'] }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].context[0]: ${reason('U+DC00')} in term "Ashlr.AI"`,
    );
  });

  it('reports a context entry that is only the unit at its post-filter index', () => {
    // Entries are trimmed and empties dropped before the term check runs, so
    // a whitespace-only entry disappears and the lone unit after it is
    // reported at index 0, not 1.
    const result = LexiconSchema.safeParse({
      terms: [{ canonical: 'Ashlr.AI', context: [' ', '\uDC00'] }],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the isolated low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'context', 0], message: `${reason('U+DC00')} in term "Ashlr.AI"` },
    ]);
  });

  it('rejects an isolated low surrogate in createdAt', () => {
    const result = TermSchema.safeParse({ canonical: 'Ashlr.AI', createdAt: '2026-11-05\uDC01' });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the isolated low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['createdAt'], message: `${reason('U+DC01')} in term "Ashlr.AI"` },
    ]);
  });

  it('points at the one term carrying the unit when its neighbours are clean', () => {
    const result = LexiconSchema.safeParse({
      terms: [
        { canonical: 'Fine' },
        { canonical: 'Also fine', aliases: ['ok'] },
        { canonical: 'Rocket', aliases: ['launch\uDC00'] },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the isolated low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 2, 'aliases', 0], message: `${reason('U+DC00')} in term "Rocket"` },
    ]);
  });

  it('keeps a valid pair in the term name readable beside the reported unit', () => {
    const result = TermSchema.safeParse({ canonical: 'Rocket 🚀', context: ['x\uDC00y'] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the isolated low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['context', 0], message: `${reason('U+DC00')} in term "Rocket 🚀"` },
    ]);
  });

  it('rejects one a hand-edited YAML file spells as a \\u escape, with an encodable message', () => {
    const input = parseYaml('terms:\n  - canonical: Ashlr.AI\n    context: ["ship\\uDE00it"]\n');
    let message = '';
    try {
      parseLexicon(input);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }

    expect(message).toBe(
      `Invalid lexicon:\n  - terms[0].context[0]: ${reason('U+DE00')} in term "Ashlr.AI"`,
    );
    // A thrown diagnostic must not carry the raw unit into a log or a model.
    expect(message).not.toMatch(/[\uD800-\uDFFF]/);
    expect(findUnencodableChar(message)).toBeUndefined();
  });
});
