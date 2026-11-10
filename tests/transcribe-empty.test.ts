import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('cleanTranscript empty results', () => {
  it.each(['', '  \n\t '])('returns an empty string for empty input %j', (input) => {
    expect(cleanTranscript(input)).toBe('');
  });

  it.each(['[BLANK_AUDIO]', ' [MUSIC] (applause) *laughs* '])(
    'returns an empty string for annotation-only input %j',
    (input) => {
      expect(cleanTranscript(input)).toBe('');
    },
  );
});
