import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. A bracketed tag is
// dropped and the words around it stay; a tag right before closing
// punctuation must not leave a space ahead of that punctuation.
describe('cleanTranscript bracketed tag before punctuation', () => {
  it.each([
    ['a period', 'send [MUSIC]. Report', 'send. Report'],
    ['a comma', 'send [MUSIC], then report', 'send, then report'],
    ['a question mark', 'what [inaudible]?', 'what?'],
    ['a tag touching the word', 'send[MUSIC]. Report', 'send. Report'],
    ['a tag inside a parenthetical', 'ok (see [MUSIC]) fine', 'ok (see ) fine'],
  ])('removes the tag before %s and keeps the words', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('still separates words when the tag is followed by a space', () => {
    expect(cleanTranscript('send [MUSIC] report.')).toBe('send report.');
  });

  it('applies to the stdout fallback', () => {
    expect(cleanTranscript(parseWhisperOutput(undefined, 'send [MUSIC]. Report'))).toBe('send. Report');
  });
});
