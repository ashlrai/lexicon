import { describe, expect, it } from 'vitest';
import { LexiconSchema, TermSchema, UNENCODABLE_NOTE, findUnencodableChar } from '../src/core/schema.js';

const reason = `must not contain U+FFFF (${UNENCODABLE_NOTE})`;

// U+FFFF is the last code point of the Basic Multilingual Plane and a Unicode
// noncharacter: no file format can carry it. Its neighbors on either side of
// the boundary are ordinary encodable characters and must still parse.
describe('U+FFFF rejection in the term schema', () => {
  it('findUnencodableChar reports U+FFFF', () => {
    expect(findUnencodableChar('Ash\uFFFFlr')).toBe('U+FFFF');
  });

  it('TermSchema rejects U+FFFF and the error names the code point', () => {
    const result = TermSchema.safeParse({ canonical: 'Ash\uFFFFlr' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['canonical']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it('LexiconSchema rejects U+FFFF at the offending term path', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'Valid' }, { canonical: 'Bad\uFFFF' }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['terms', 1, 'canonical']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it.each([
    ['U+FFFD, the replacement character', 'Ash\uFFFDlr'],
    ['U+FFFE-adjacent BMP text', 'Ash\u20AClr'],
    ['an astral character', 'Rocket \u{1F680}'],
    ['a supplementary-plane character', '\u{10000}test'],
    ['a valid surrogate pair', '\u{1F680}\u{1F681}'],
  ])('accepts %s next to where U+FFFF would sit', (_label, canonical) => {
    const result = TermSchema.safeParse({ canonical });
    expect(result.success).toBe(true);
  });

  it('accepts notes and aliases that carry valid neighboring Unicode', () => {
    const result = TermSchema.safeParse({
      canonical: 'Ashlr.AI',
      aliases: ['Ash\uFFFDler', 'Rocket \u{1F680}'],
      notes: 'dictated \u{1F4DD} on macOS',
    });
    expect(result.success).toBe(true);
  });

  it('still names U+FFFE distinctly, not U+FFFF', () => {
    const result = TermSchema.safeParse({ canonical: 'Ash\uFFFElr' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    expect(result.error.issues[0]?.message).toContain(`must not contain U+FFFE (${UNENCODABLE_NOTE})`);
  });
});
