import { describe, expect, it } from 'vitest';
import { LIMITS, parseLexicon, TermSchema } from '../src/core/schema.js';

/** A brand-like canonical (words, dot, digit) cut or padded to exactly `length` characters. */
function brandOfLength(length: number): string {
  const base = 'Ashlr.AI Voice Lexicon Pro 2 ';
  return (base + 'Enterprise '.repeat(8)).slice(0, length).trimEnd().padEnd(length, 'X');
}

describe('valid-looking canonical one character over the limit', () => {
  const atLimit = brandOfLength(LIMITS.word);
  const overLimit = brandOfLength(LIMITS.word + 1);

  it('builds inputs that differ only by one character', () => {
    expect(atLimit).toHaveLength(LIMITS.word);
    expect(overLimit).toHaveLength(LIMITS.word + 1);
    expect(overLimit.startsWith(atLimit)).toBe(true);
  });

  it('accepts the word at the limit and rejects it one character above, with only the length issue', () => {
    const ok = TermSchema.safeParse({ canonical: atLimit, aliases: ['ashler'], phonetic: 'ASH-ler' });
    expect(ok.success).toBe(true);

    const bad = TermSchema.safeParse({ canonical: overLimit, aliases: ['ashler'], phonetic: 'ASH-ler' });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues).toHaveLength(1);
      expect(bad.error.issues[0].path).toEqual(['canonical']);
      expect(bad.error.issues[0].message).toBe(`must be at most ${LIMITS.word} characters`);
    }
  });

  it('fails a whole lexicon file because of that one term, naming its position', () => {
    expect(() =>
      parseLexicon({ terms: [{ canonical: 'Ashlr.AI' }, { canonical: overLimit }] }),
    ).toThrow(`terms[1].canonical: must be at most ${LIMITS.word} characters`);
  });
});
