import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// A transcript that is only one bracketed tag cleans to an empty string.
describe('cleanTranscript transcript of only a bracketed tag', () => {
  it.each([
    ['a sound tag', '[BLANK_AUDIO]'],
    ['a lowercase tag', '[inaudible]'],
    ['a multi-word tag', '[speaker 2: hello there]'],
    ['an empty tag', '[]'],
    ['a tag spanning a newline', '[one\ntwo]'],
    ['a tag with surrounding whitespace', '  \t[MUSIC]\n '],
  ])('returns an empty string for %s', (_label, input) => {
    expect(cleanTranscript(input)).toBe('');
  });

  it.each([
    ['Whisper JSON segment', '{"transcription":[{"text":" [BLANK_AUDIO]"}]}', 'ignored stdout'],
    ['stdout fallback', undefined, '[BLANK_AUDIO]\n'],
  ])('returns an empty string from %s', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('');
  });
});
