import { describe, expect, it } from 'vitest';
import {
  LexiconSchema,
  TermSchema,
  UNENCODABLE_NOTE,
  escapeUnencodable,
  findUnencodableChar,
  parseLexicon,
} from '../src/core/schema.js';

// The Unicode contract in one file: a low surrogate with no high surrogate in
// front of it (U+DC00..U+DFFF) is the invalid code unit the schema must name,
// while a well-formed surrogate pair is an ordinary character and is accepted
// everywhere free text is allowed. The sibling schema-* files pin each shape
// position by position; this one pins the contrast end to end: the same
// document rejects the unpaired half and accepts the pair.

const LOW = '\uDC00'; // U+DC00, the first low surrogate
const PAIR = '\u{1F680}'; // U+1F680 ROCKET, one valid surrogate pair

const reason = (unit: string) => `must not contain ${unit} (${UNENCODABLE_NOTE})`;

describe('U+FFFE is rejected', () => {
  it('identifies and escapes U+FFFE in the offending field', () => {
    const result = TermSchema.safeParse({ canonical: 'word\uFFFE' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['canonical'], message: `${reason('U+FFFE')} in term "word\\uFFFE"` },
    ]);
  });

  it.each(['\uFFFD', '\u{10000}'])('accepts nearby valid character %j', (character) => {
    expect(findUnencodableChar(character)).toBeUndefined();
    const result = TermSchema.safeParse({ canonical: `word${character}` });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected acceptance');
    expect(result.data.canonical).toBe(`word${character}`);
  });
});

describe('U+FFFF is rejected', () => {
  it('identifies and escapes U+FFFF in the offending field', () => {
    const result = TermSchema.safeParse({ canonical: 'word\uFFFF' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['canonical'], message: `${reason('U+FFFF')} in term "word\\uFFFF"` },
    ]);
  });

  it('names U+FFFF in every free-text field and reports it by code point', () => {
    expect(findUnencodableChar('a\uFFFFb')).toBe('U+FFFF');
    expect(findUnencodableChar(escapeUnencodable('a\uFFFFb'))).toBeUndefined();
    const result = LexiconSchema.safeParse({
      terms: [{ canonical: 'Fine', aliases: ['ok', 'bad\uFFFF'] }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'aliases', 1], message: `${reason('U+FFFF')} in term "Fine"` },
    ]);
  });

  it('reports the first of U+FFFE and U+FFFF by position', () => {
    expect(findUnencodableChar('\uFFFFx\uFFFE')).toBe('U+FFFF');
    expect(findUnencodableChar('\uFFFEx\uFFFF')).toBe('U+FFFE');
  });

  it('accepts U+10FFFF, the astral character that ends in FFFF', () => {
    expect(findUnencodableChar('\u{10FFFF}')).toBeUndefined();
  });
});

describe('unpaired low surrogate is identified by its code unit', () => {
  it.each([
    ['at the start of the string', `${LOW}Rocket`, 'U+DC00'],
    ['at the end of the string', `Rocket${LOW}`, 'U+DC00'],
    ['in the middle of the string', `Ro${LOW}cket`, 'U+DC00'],
    ['the last low surrogate', `Ro\uDFFFket`, 'U+DFFF'],
    ['right after a valid pair', `${PAIR}${LOW}`, 'U+DC00'],
    ['right before a valid pair', `${LOW}${PAIR}`, 'U+DC00'],
    ['after a lone high surrogate', '\uD800x' + LOW, 'U+D800'],
  ])('findUnencodableChar reports the unit %s', (_d, s, unit) => {
    expect(findUnencodableChar(s)).toBe(unit);
    // The escape leaves the valid pair intact and writes only the orphaned
    // unit as \uXXXX, so the result holds no unencodable code unit at all.
    expect(findUnencodableChar(escapeUnencodable(s))).toBeUndefined();
  });

  it('reports the FIRST unencodable unit, not a later one', () => {
    expect(findUnencodableChar(`a${LOW}b\uDFFFc`)).toBe('U+DC00');
  });

  it('rejects the term naming the unit while the pair beside it stays clean', () => {
    const result = TermSchema.safeParse({ canonical: `Rocket ${PAIR}${LOW}` });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      {
        path: ['canonical'],
        message: `${reason('U+DC00')} in term "Rocket ${PAIR}\\uDC00"`,
      },
    ]);
  });

  it('rejects the one field holding the unit and names its index', () => {
    const result = LexiconSchema.safeParse({
      terms: [
        { canonical: 'Fine', aliases: [`rock${PAIR}et`] },
        { canonical: 'Rocket', never: [PAIR, `bad${LOW}`] },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 1, 'never', 1], message: `${reason('U+DC00')} in term "Rocket"` },
    ]);
  });
});

describe('a valid surrogate pair is accepted', () => {
  it.each([PAIR, '\u{1D7D8}', '\u{20000}'])('findUnencodableChar accepts %j', (s) => {
    expect(findUnencodableChar(s)).toBeUndefined();
    expect(findUnencodableChar(`${PAIR}${s}${PAIR}`)).toBeUndefined();
  });

  it('accepts a lexicon mixing pairs in every free-text field', () => {
    const lexicon = parseLexicon({
      terms: [
        {
          canonical: `Rocket ${PAIR}`,
          aliases: [`rock${PAIR}et`, 'ship'],
          never: [PAIR],
          phonetic: `rok${PAIR}`,
          notes: `launch ${PAIR}`,
          context: [`${PAIR}pad`],
        },
      ],
      settings: { protectedWords: [PAIR] },
    });
    expect(lexicon.terms).toHaveLength(1);
    expect(lexicon.terms[0].canonical).toBe(`Rocket ${PAIR}`);
    expect(lexicon.terms[0].aliases).toEqual([`rock${PAIR}et`, 'ship']);
    expect(lexicon.terms[0].never).toEqual([PAIR]);
  });

  it('the same document rejects when a pair is swapped for an unpaired low surrogate', () => {
    const base = {
      canonical: 'Rocket',
      aliases: ['fine', `bad${LOW}`],
      never: [PAIR],
      notes: `note ${PAIR}`,
    };
    const rejected = TermSchema.safeParse(base);
    expect(rejected.success).toBe(false);
    if (rejected.success) throw new Error('Expected rejection');
    expect(rejected.error.issues.map((i) => i.path)).toEqual([['aliases', 1]]);

    const accepted = TermSchema.safeParse({ ...base, aliases: ['fine', `rock${PAIR}et`] });
    expect(accepted.success).toBe(true);
    if (!accepted.success) throw new Error('Expected the valid pair to be accepted');
    expect(accepted.data.aliases).toEqual(['fine', `rock${PAIR}et`]);
  });
});
