import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// An opening bracket that never closes is dictated text, not a tag: the mark
// and the words after it must survive. (A later `]` closes the span by design,
// see clean-transcript-multiple-bracketed-tags.test.ts.)
describe('cleanTranscript unmatched opening bracket', () => {
  it.each([
    ['mid sentence', 'Please keep [unfinished intact.'],
    ['at the very start', '[ Please continue.'],
    ['at the very end', 'Please continue. ['],
    ['the whole transcript', '['],
    ['two lone marks', 'Keep [ and [ here.'],
    ['a stray closing bracket', 'Keep unfinished] intact.'],
  ])('preserves %s', (_label, input) => {
    expect(cleanTranscript(input)).toBe(input);
  });

  it.each([
    ['a tag before it', '[MUSIC] keep [unfinished here.', 'keep [unfinished here.'],
    ['tags on both sides of the words', 'One [noise] two [music] three [unfinished', 'One two three [unfinished'],
    ['a noise parenthesis after it', 'Tell [unclosed (applause) now.', 'Tell [unclosed now.'],
    ['a starred tag after it', 'Say [unfinished *laughs* today.', 'Say [unfinished today.'],
  ])('keeps the bracket and its text while dropping %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('collapses whitespace and is idempotent', () => {
    expect(cleanTranscript('  Keep   [unfinished\nhere  ')).toBe('Keep [unfinished here');
    const once = cleanTranscript('[MUSIC] Keep [unfinished here');
    expect(cleanTranscript(once)).toBe(once);
  });

  it('preserves it through Whisper JSON and stdout fallback', () => {
    const json = JSON.stringify({ transcription: [{ text: '[MUSIC] Please keep [unfinished' }, { text: 'here' }, { text: 'today.' }] });
    expect(cleanTranscript(parseWhisperOutput(json, 'ignored'))).toBe('Please keep [unfinished here today.');
    expect(cleanTranscript(parseWhisperOutput(undefined, 'Please keep [unfinished here today.'))).toBe('Please keep [unfinished here today.');
  });
});
