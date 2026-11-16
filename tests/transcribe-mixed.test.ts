import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('cleanTranscript with mixed annotations', () => {
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
