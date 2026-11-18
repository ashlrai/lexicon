import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('cleanTranscript with mixed annotations', () => {
  it.each(['[MUSIC]*laughs*', '*laughs*[speaker 2]', '[noise] *COUGHS* [static]'])
    ('preserves surrounding prose when removing %s with different separators', (annotations) => {
      const before = "Zoë laughs, then says: send version 2.5";
      const after = 'to the café (the new location), please!';
      const expected = `${before} ${after}`;

      for (const separator of ['', ' ', '\t', '\r\n', '\u00a0']) {
        const input = `${before}${separator}${annotations}${separator}${after}`;
        const cleaned = cleanTranscript(input);
        expect(cleaned, JSON.stringify(input)).toBe(expected);
        expect(cleanTranscript(cleaned)).toBe(expected);
      }
    });

  it('removes every bracketed and eligible asterisk annotation while preserving spoken order', () => {
    expect(cleanTranscript('[MUSIC] Please *laughs* send [noise] the *door slams* report [static] today *deep breath*')).toBe(
      'Please send the report today',
    );
  });

  it('preserves a longer starred phrase among eligible annotations', () => {
    expect(cleanTranscript('[noise] Say *laughs* *these four spoken words* [music] now *sighs*')).toBe(
      'Say *these four spoken words* now',
    );
  });
});
