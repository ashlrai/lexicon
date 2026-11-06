import { describe, expect, it } from 'vitest';
import { LexiconSchema, TermSchema, UNENCODABLE_NOTE, parseLexicon } from '../src/core/schema.js';

// A canonical word that STARTS with half of a surrogate pair: a high surrogate
// with no low surrogate after it, or a stray low surrogate.
const LEADING: ReadonlyArray<readonly [string, string, string, string]> = [
  ['a lone high surrogate', '\uD800', 'U+D800', '\\uD800'],
  ['a high surrogate before a BMP letter', '\uD800Ashlr', 'U+D800', '\\uD800Ashlr'],
  ['the last high surrogate before a letter', '\uDBFFAshlr', 'U+DBFF', '\\uDBFFAshlr'],
  ['a high surrogate before another high surrogate', '\uD800\uD83DAshlr', 'U+D800', '\\uD800\\uD83DAshlr'],
  ['a stray low surrogate', '\uDC00Ashlr', 'U+DC00', '\\uDC00Ashlr'],
];

describe('unpaired leading surrogate in a canonical word', () => {
  it.each(LEADING)('TermSchema rejects %s and names the code unit', (_d, canonical, unit, shown) => {
    const result = TermSchema.safeParse({ canonical });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the leading surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['canonical'], message: `must not contain ${unit} (${UNENCODABLE_NOTE}) in term "${shown}"` },
    ]);
  });

  it('LexiconSchema and parseLexicon report it at terms[0].canonical', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: '\uD800Ashlr' }] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the leading surrogate to be rejected');
    expect(result.error.issues[0].path).toEqual(['terms', 0, 'canonical']);
    expect(() => parseLexicon({ terms: [{ canonical: '\uD800Ashlr' }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: must not contain U+D800 (${UNENCODABLE_NOTE}) in term "\\uD800Ashlr"`,
    );
  });

  it('still accepts a leading surrogate that is half of a valid pair', () => {
    expect(TermSchema.parse({ canonical: '🚀 Rocket' }).canonical).toBe('\u{1F680} Rocket');
  });
});
