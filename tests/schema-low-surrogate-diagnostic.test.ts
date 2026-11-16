import { describe, expect, it } from 'vitest';
import { LexiconSchema, TermSchema, UNENCODABLE_NOTE, findUnencodableChar, parseLexicon } from '../src/core/schema.js';

describe('unpaired low surrogate diagnostics', () => {
  it.each([
    ['first low surrogate', '\uDC00Ashlr', 'U+DC00', '\\uDC00Ashlr'],
    ['last low surrogate', 'Ashlr\uDFFF', 'U+DFFF', 'Ashlr\\uDFFF'],
    ['low surrogate after a valid pair', 'Rocket\u{1F680}\uDC01', 'U+DC01', 'Rocket\u{1F680}\\uDC01'],
  ])('rejects a canonical with the %s and identifies its code unit', (_description, canonical, unit, shown) => {
    const message = `must not contain ${unit} (${UNENCODABLE_NOTE}) in term "${shown}"`;
    expect(findUnencodableChar(canonical)).toBe(unit);
    const result = TermSchema.safeParse({ canonical });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an unpaired low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message: text }) => ({ path, message: text }))).toEqual([
      { path: ['canonical'], message },
    ]);
    expect(() => parseLexicon({ terms: [{ canonical }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: ${message}`,
    );
  });

  it('reports an unpaired low surrogate in an alias at its indexed path', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'Rocket', aliases: ['valid', 'bad\uDC42'] }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an unpaired low surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'aliases', 1], message: `must not contain U+DC42 (${UNENCODABLE_NOTE}) in term "Rocket"` },
    ]);
  });

  it('accepts a low surrogate paired with a preceding high surrogate', () => {
    expect(findUnencodableChar('Rocket\uD83D\uDE80')).toBeUndefined();
    expect(TermSchema.parse({ canonical: 'Rocket\uD83D\uDE80' }).canonical).toBe('Rocket\u{1F680}');
  });
});
