import { describe, expect, it } from 'vitest';
import { LexiconSchema, TermSchema, UNENCODABLE_NOTE, findUnencodableChar, parseLexicon } from '../src/core/schema.js';

const reason = `must not contain U+FFFF (${UNENCODABLE_NOTE})`;

// U+FFFF is a Unicode noncharacter: no lexicon file can carry it, so any
// free-text field holding one is refused and the message names the code point.
const WORDS: ReadonlyArray<readonly [string, string]> = [
  ['in the middle', 'Ash￿lr'],
  ['at the start', '￿Ashlr'],
  ['at the end', 'Ashlr￿'],
  ['alone', '￿'],
  ['after a valid surrogate pair', 'Rocket \u{1F680}￿'],
];

describe('U+FFFF in a term', () => {
  it.each(WORDS)('findUnencodableChar reports U+FFFF %s', (_label, word) => {
    expect(findUnencodableChar(word)).toBe('U+FFFF');
  });

  it.each(WORDS)('TermSchema rejects U+FFFF %s at the canonical path', (_label, canonical) => {
    const result = TermSchema.safeParse({ canonical });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['canonical']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it.each(WORDS)('LexiconSchema rejects U+FFFF %s and points at the term', (_label, canonical) => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'Valid' }, { canonical }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['terms', 1, 'canonical']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it('rejects U+FFFF in an alias at its index', () => {
    const result = TermSchema.safeParse({ canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ash￿lar'] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues[0]?.path).toEqual(['aliases', 1]);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it('rejects U+FFFF in notes', () => {
    const result = TermSchema.safeParse({ canonical: 'Ashlr.AI', notes: 'brand￿' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues[0]?.path).toEqual(['notes']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it('parseLexicon throws an error that lists the path and the code point', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 'Ash￿lr' }] })).toThrow(
      `terms[0].canonical: ${reason}`,
    );
  });

  it('accepts the neighbouring code points U+FFFD and U+FFFC', () => {
    expect(TermSchema.safeParse({ canonical: 'Ash�lr￼' }).success).toBe(true);
  });
});
