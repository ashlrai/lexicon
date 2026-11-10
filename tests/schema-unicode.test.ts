import { describe, expect, it } from 'vitest';
import { LexiconSchema, UNENCODABLE_NOTE, findUnencodableChar, parseLexicon } from '../src/core/schema.js';

// A high surrogate (U+D800 to U+DBFF) that is not followed by a low surrogate
// (U+DC00 to U+DFFF) names the offending code unit in the diagnostic as
// U+XXXX while leaving a valid surrogate pair, an emoji or any supplementary
// code point, fully legal in every free-text field.

const reason = (unit: string) => `must not contain ${unit} (${UNENCODABLE_NOTE})`;

describe('schema unicode handling', () => {
  it.each([
    ['a lone high surrogate at the end', 'Ashlr\uD800', 'U+D800'],
    ['a high surrogate before a BMP letter', '\uDBFFx', 'U+DBFF'],
    ['a high surrogate followed by another high surrogate', 'a\uD800\uD801b', 'U+D800'],
  ])('identifies the invalid code unit in %s', (_description, input, unit) => {
    expect(findUnencodableChar(input)).toBe(unit);
  });

  it.each([
    { canonical: 'Ashlr\uD800.AI' },
    { canonical: 'Ashlr.AI', aliases: ['ok', 'Ash\uD800ler'] },
    { canonical: 'Ashlr.AI', notes: 'see\uDBFF' },
  ])('refuses an unpaired high surrogate at schema parse %#', (term) => {
    const result = LexiconSchema.safeParse({ terms: [term] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the unpaired high surrogate to be rejected');
    const [issue] = result.error.issues;
    expect(issue?.message).toMatch(/^must not contain U\+D[89AB][0-9A-F]{2} \(/);
    expect(issue?.message).toContain(UNENCODABLE_NOTE);
  });

  it('rejects it through parseLexicon naming the unit and the term', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 'Ashlr\uD800.AI', aliases: [] }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: ${reason('U+D800')} in term "Ashlr\\uD800.AI"`,
    );
  });

  it.each([
    ['an emoji pair', 'Rocket 🚀'],
    ['the first supplementary code point', 'LINE\uD800\uDC00'],
    ['the last code point', 'END\uDBFF\uDFFF'],
  ])('accepts %s written as a valid surrogate pair', (_description, text) => {
    expect(findUnencodableChar(text)).toBeUndefined();
    const result = LexiconSchema.safeParse({
      terms: [{ canonical: 'Rocket', aliases: [text], never: [text], phonetic: text, notes: text }],
      settings: { protectedWords: [text], packs: [text] },
    });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected the valid surrogate pair to be accepted');
    expect(result.data.terms[0].aliases).toEqual([text]);
    expect(result.data.terms[0].notes).toBe(text);
  });

  it('accepts a valid pair through parseLexicon unchanged', () => {
    const lexicon = parseLexicon({ terms: [{ canonical: 'Rocket 🚀', aliases: ['🚀 ship'] }] });
    expect(lexicon.terms[0].canonical).toBe('Rocket 🚀');
    expect(lexicon.terms[0].aliases).toEqual(['🚀 ship']);
  });
});
