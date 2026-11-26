import { describe, expect, it } from 'vitest';
import { parseLexicon } from '../src/core/schema.js';

describe('unpaired surrogates in notes', () => {
  it.each([
    ['high', '\uD83D', 'D83D'],
    ['low', '\uDC00', 'DC00'],
  ])('rejects an unpaired %s surrogate with a safe diagnostic', (_kind, unit, hex) => {
    const raw = { terms: [{ canonical: 'Rocket 🚀', notes: `before ${unit} after` }] };
    let message = '';
    try {
      parseLexicon(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      message = (error as Error).message;
    }
    expect(message).toBe(
      `Invalid lexicon:\n  - terms[0].notes: must not contain U+${hex} (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket 🚀"`,
    );
    expect(Buffer.from(message, 'utf8').toString('utf8')).toBe(message);
  });

  it('accepts a valid surrogate pair in notes', () => {
    expect(parseLexicon({ terms: [{ canonical: 'Rocket', notes: 'Ready 🚀' }] }).terms[0].notes).toBe('Ready 🚀');
  });
});
