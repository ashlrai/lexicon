import { describe, expect, it } from 'vitest';
import { LexiconSchema, TermSchema, UNENCODABLE_NOTE, findUnencodableChar, parseLexicon } from '../src/core/schema.js';

const reason = `must not contain U+FFFE (${UNENCODABLE_NOTE})`;

// U+FFFE is a Unicode noncharacter: no lexicon file can carry it, so a
// canonical word holding one is refused and the message names the code point.
const WORDS: ReadonlyArray<readonly [string, string]> = [
  ['in the middle', 'Ash￾lr'],
  ['at the start', '￾Ashlr'],
  ['at the end', 'Ashlr￾'],
  ['alone', '￾'],
  ['after a valid surrogate pair', 'Rocket \u{1F680}￾'],
];

describe('U+FFFE in a canonical word', () => {
  it.each(WORDS)('findUnencodableChar reports U+FFFE %s', (_label, word) => {
    expect(findUnencodableChar(word)).toBe('U+FFFE');
  });

  it.each(WORDS)('TermSchema rejects U+FFFE %s at the canonical path', (_label, canonical) => {
    const result = TermSchema.safeParse({ canonical });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['canonical']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it.each(WORDS)('LexiconSchema rejects U+FFFE %s and points at the term', (_label, canonical) => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'Valid' }, { canonical }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFE to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['terms', 1, 'canonical']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it('parseLexicon throws an error that lists the path and the code point', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 'Ash￾lr' }] })).toThrow(
      `terms[0].canonical: ${reason}`,
    );
  });

  it('accepts the neighbouring code points U+FFFD and U+FFFC', () => {
    expect(TermSchema.safeParse({ canonical: 'Ash�lr￼' }).success).toBe(true);
  });
});
