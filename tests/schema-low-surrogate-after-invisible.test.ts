import { describe, expect, it } from 'vitest';
import { LexiconSchema, TermSchema, UNENCODABLE_NOTE, parseLexicon } from '../src/core/schema.js';

// docs/CONTRACT.md: no unpaired surrogate in any field, and the schema names
// the offending code unit as `U+XXXX`. Zero-width characters are stripped
// before that check, so what counts is the text left after stripping: a
// zero-width character between a high and a low surrogate does not stop them
// pairing, and one in front of a low surrogate does not hide it.

const reason = (unit: string) => `must not contain ${unit} (${UNENCODABLE_NOTE})`;

describe('low surrogate next to a stripped zero-width character', () => {
  it('rejects a low surrogate that only a zero-width character precedes, naming its code unit', () => {
    const result = TermSchema.safeParse({ canonical: 'a​\uDE80' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['canonical'], message: `${reason('U+DE80')} in term "a\\uDE80"` },
    ]);
  });

  it('rejects one in front of a trailing zero-width character in an alias, at its index', () => {
    const result = TermSchema.safeParse({ canonical: 'Rocket', aliases: ['ok', '\uDE80​'] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['aliases', 1], message: `${reason('U+DE80')} in term "Rocket"` },
    ]);
  });

  it('keeps a pair whose halves a zero-width character separated', () => {
    const result = TermSchema.safeParse({ canonical: 'a\uD83D​\uDE80', aliases: ['\uD83D​\uDE80'] });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Expected the healed pair to be accepted');
    expect(result.data.canonical).toBe('a\u{1F680}');
    expect(result.data.aliases).toEqual(['\u{1F680}']);
  });

  it('parseLexicon names the unit by its path without echoing it raw', () => {
    let message = '';
    try {
      parseLexicon({ terms: [{ canonical: 'Fine' }, { canonical: 'x​\uDC00' }] });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      message = error.message;
    }
    expect(message).toBe(`Invalid lexicon:\n  - terms[1].canonical: ${reason('U+DC00')} in term "x\\uDC00"`);
    expect(message).not.toMatch(/[\uD800-\uDFFF]/);
    expect(LexiconSchema.safeParse({ terms: [{ canonical: 'x​\uDC00' }] }).success).toBe(false);
  });
});

describe('high surrogate next to a stripped zero-width character', () => {
  it('reports U+D800 at the alias path after stripping the character', () => {
    const raw = { terms: [{ canonical: 'Rocket', aliases: ['ok', 'x\uD800\u200B'] }] };
    const result = LexiconSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['terms', 0, 'aliases', 1], message: `${reason('U+D800')} in term "Rocket"` },
    ]);
    expect(() => parseLexicon(raw)).toThrow(
      `terms[0].aliases[1]: ${reason('U+D800')} in term "Rocket"`,
    );
  });
});
