import { describe, expect, it } from 'vitest';
import { TermSchema, UNENCODABLE_NOTE, parseLexicon } from '../src/core/schema.js';

// A lone high surrogate (U+D800 to U+DBFF) that is followed by a character the
// schema strips or trims (whitespace, zero-width, newline) or by a combining
// mark is still unpaired: nothing in the input completes it. It must be
// rejected with the offending code unit named, not silently cleaned up.
const FOLLOWED_BY: ReadonlyArray<readonly [string, string]> = [
  ['a space', ' '],
  ['a zero-width space', '​'],
  ['a newline', '\n'],
  ['a combining mark', '́'],
  ['a BMP letter', 'x'],
];

const message = (unit: string) => `must not contain ${unit} (${UNENCODABLE_NOTE}) in term "Ashlr.AI"`;

describe('lone high surrogate before a stripped or combining character', () => {
  it.each(FOLLOWED_BY)('rejects one followed by %s in an alias and names U+D800', (_d, next) => {
    const result = TermSchema.safeParse({ canonical: 'Ashlr.AI', aliases: [`a\uD800${next}`] });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the lone high surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['aliases', 0], message: message('U+D800') },
    ]);
  });

  it.each(FOLLOWED_BY)('names the exact unit (U+DBFF) when followed by %s in notes', (_d, next) => {
    const result = TermSchema.safeParse({ canonical: 'Ashlr.AI', notes: `n\uDBFF${next}` });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the lone high surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['notes'], message: message('U+DBFF') },
    ]);
  });

  it('reports the lone high surrogate through parseLexicon with its path', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 'Ashlr.AI', aliases: ['ok', '\uD83D '] }] })).toThrow(
      `terms[0].aliases[1]: ${message('U+D83D')}`,
    );
  });
});
