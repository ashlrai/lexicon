import { describe, expect, it } from 'vitest';
import { cleanTranscript } from './transcribe.js';

describe('cleanTranscript bracketed tags adjacent to ordinary words', () => {
  it.each([
    ['glued on both sides', 'foo[noise]bar', 'foo bar'],
    ['glued to the previous word', 'Hello[noise] world', 'Hello world'],
    ['glued to the next word', 'Hello [noise]world', 'Hello world'],
    ['one space before only', 'Ship [MUSIC]it today', 'Ship it today'],
    ['one space after only', 'Ship[MUSIC] it today', 'Ship it today'],
    ['hyphenated neighbours', 'well-known[noise]well-made', 'well-known well-made'],
    ['digits and punctuation inside words', 'v2.1[BLANK_AUDIO]release', 'v2.1 release'],
    ['a canonical term next to a tag', 'Send it to Ashlr.AI[noise] today', 'Send it to Ashlr.AI today'],
  ])('keeps both words when the tag is %s', (_name, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['period', 'Done[noise].', 'Done.'],
    ['comma', 'Done [noise], then deploy', 'Done, then deploy'],
    ['question mark', 'Ready[ pause ]? Go', 'Ready? Go'],
    ['exclamation after a spaced tag', 'Go now [laughs]!', 'Go now!'],
  ])('leaves no stray space before trailing %s', (_name, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('removes several adjacent tags between words', () => {
    expect(cleanTranscript('one[a][b]two')).toBe('one two');
    expect(cleanTranscript('one [a] [b] two')).toBe('one two');
    expect(cleanTranscript('a[x]b[y]c[z]d')).toBe('a b c d');
  });

  it('removes tags at the edges of the text without touching the words', () => {
    expect(cleanTranscript('[MUSIC]hello')).toBe('hello');
    expect(cleanTranscript('hello[MUSIC]')).toBe('hello');
    expect(cleanTranscript('[a]hello[b]')).toBe('hello');
  });

  it('handles tags next to line breaks and tabs', () => {
    expect(cleanTranscript('one\n[noise]\ntwo')).toBe('one two');
    expect(cleanTranscript('one\t[noise]\ttwo')).toBe('one two');
  });

  it('does not touch unmatched brackets next to words', () => {
    expect(cleanTranscript('one[two three')).toBe('one[two three');
    expect(cleanTranscript('one]two')).toBe('one]two');
  });
});
