import { describe, expect, it } from 'vitest';
import { parseLexicon } from '../src/core/schema.js';

/** True when `s` holds a surrogate code unit that is not half of a valid pair. */
const hasLoneSurrogate = (s: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

function messageFor(raw: unknown): string {
  try {
    parseLexicon(raw);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('Expected the lexicon to be rejected');
}

describe('unpaired surrogate error rendering', () => {
  it.each([
    ['canonical', { terms: [{ canonical: 'Ro\uD800cket' }] }, 'terms[0].canonical'],
    ['alias', { terms: [{ canonical: 'Rocket', aliases: ['ro\uDC00ket'] }] }, 'terms[0].aliases[0]'],
    ['protected word', { terms: [], settings: { protectedWords: ['x\uDBFF'] } }, 'settings.protectedWords[0]'],
  ])('writes the offending %s unit as a literal escape, never as a raw character', (_field, raw, path) => {
    const message = messageFor(raw);
    expect(message).toContain(path);
    expect(message).toMatch(/must not contain U\+D[89A-F][0-9A-F]{2} /);
    expect(hasLoneSurrogate(message)).toBe(false);
  });

  it('names the term with a literal backslash-u escape', () => {
    const message = messageFor({ terms: [{ canonical: 'Rocket', aliases: ['a\uD800'] }, { canonical: 'Ro\uDFFFcket' }] });
    expect(message).toContain('in term "Ro\\uDFFFcket"');
    expect(message).toContain('in term "Rocket"');
    expect(hasLoneSurrogate(message)).toBe(false);
  });

  it('keeps a valid pair readable next to a lone unit', () => {
    const message = messageFor({ terms: [{ canonical: '🚀 \uD800 🚀' }] });
    expect(message).toContain('in term "🚀 \\uD800 🚀"');
    expect(hasLoneSurrogate(message)).toBe(false);
  });
});
