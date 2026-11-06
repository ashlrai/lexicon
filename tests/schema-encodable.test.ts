import { describe, expect, it } from 'vitest';
import { findUnencodableChar, LexiconSchema, UNENCODABLE_NOTE } from '../src/core/schema.js';

// A single term field can carry two distinct invalid code units. The
// diagnostic must name the first one the walker encounters, not the
// second or both.
describe('two different invalid code units', () => {
  it('identifies the first invalid unit in a string with two distinct unencodable code points', () => {
    // U+FFFE and U+FFFF are both noncharacters but are different code points.
    // findUnencodableChar reports the first match, which is U+FFFE.
    const value = 'Ash\uFFFE lr \uFFFFtest';
    expect(findUnencodableChar(value)).toBe('U+FFFE');

    const result = LexiconSchema.safeParse({
      terms: [{ canonical: 'Rocket', notes: value }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');

    const reason = `must not contain U+FFFE (${UNENCODABLE_NOTE})`;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['terms', 0, 'notes']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });
});
