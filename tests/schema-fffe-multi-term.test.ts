import { describe, expect, it } from 'vitest';
import { UNENCODABLE_NOTE, parseLexicon } from '../src/core/schema.js';

const reason = `must not contain U+FFFE (${UNENCODABLE_NOTE})`;

// A file with U+FFFE in several terms reports every one in a single pass,
// each at its own path, so a hand editor fixes them all at once.
describe('U+FFFE in several terms of one lexicon', () => {
  const raw = {
    terms: [
      { canonical: 'Ash￾lr' },
      { canonical: 'Fine', aliases: ['ok'] },
      { canonical: 'Third', aliases: ['a', 'b￾'], notes: 'x￾' },
    ],
  };

  it('parseLexicon names every offending path and U+FFFE', () => {
    let message = '';
    try {
      parseLexicon(raw);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`terms[0].canonical: ${reason}`);
    expect(message).toContain(`terms[2].aliases[1]: ${reason}`);
    expect(message).toContain(`terms[2].notes: ${reason}`);
    expect(message).not.toContain('terms[1]');
  });

  it('never echoes the raw code point', () => {
    expect(() => parseLexicon(raw)).toThrow(/U\+FFFE/);
    try {
      parseLexicon(raw);
    } catch (e) {
      expect((e as Error).message).not.toContain('￾');
    }
  });
});
