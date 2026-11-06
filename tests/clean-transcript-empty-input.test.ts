import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `[...]` tags always, `*...*` of one to three plain words always, noise
// `(...)`, collapses whitespace and trims, so an empty transcript - or one
// that is nothing but annotations and whitespace - cleans to '' and never
// throws. '' is what transcribeFile hands to normalize() when whisper heard
// silence, and normalize('') must get a string, not an exception.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript empty input', () => {
  it('collapses whitespace and trims per docs/CONTRACT.md, so empty input yields an empty string', () => {
    expect(bullet).toContain('collapses whitespace, trims');
  });

  it('returns an empty string for empty input without throwing', () => {
    expect(() => cleanTranscript('')).not.toThrow();
    expect(cleanTranscript('')).toBe('');
  });

  it.each([
    ['spaces', '   '],
    ['tabs and line breaks', '\t\r\n\n'],
    ['mixed Unicode whitespace', ' \u00a0\u2003\u2028\u2029\ufeff\t'],
  ])('returns an empty string for whitespace-only input without throwing: %s', (_label, input) => {
    expect(() => cleanTranscript(input)).not.toThrow();
    expect(cleanTranscript(input)).toBe('');
  });

  it.each([
    ['a single bracketed tag', '[BLANK_AUDIO]'],
    ['adjacent bracketed tags', '[BLANK_AUDIO][MUSIC][inaudible]'],
    ['a starred noise annotation', '*laughs*'],
    ['a starred three-word annotation', '*door slams loudly*'],
    ['a parenthesised noise tag', '(applause)'],
    ['a parenthesised qualified noise tag', '(soft music)'],
    ['every annotation kind mixed with whitespace', ' \t[BLANK_AUDIO]\n(soft music) *laughs*  '],
    ['annotations separated only by whitespace', '[MUSIC]  \n*laughs*\t(applause)'],
  ])('cleans %s down to an empty string', (_label, input) => {
    expect(cleanTranscript(input)).toBe('');
  });

  it('stays empty when its own empty output is cleaned again', () => {
    expect(cleanTranscript(cleanTranscript(''))).toBe('');
    expect(cleanTranscript(cleanTranscript(' \t[BLANK_AUDIO]\n(soft music) *laughs*  '))).toBe('');
  });

  it.each([
    ['empty stdout', undefined, ''],
    ['whitespace-only stdout', undefined, '  \n\t '],
    ['empty JSON and empty stdout', '', ''],
    ['invalid JSON and empty stdout', '{', ''],
    ['an empty transcription array', '{"transcription":[]}', 'ignored stdout'],
    ['a segment with empty text', '{"transcription":[{"text":""}]}', 'ignored stdout'],
    ['a segment without text', '{"transcription":[{}]}', 'ignored stdout'],
    ['segments of only annotations', '{"transcription":[{"text":"[BLANK_AUDIO]"},{"text":"*laughs*"},{"text":"(applause)"}]}', 'ignored stdout'],
  ])('produces an empty transcript from whisper output with %s', (_label, json, stdout) => {
    const transcript = parseWhisperOutput(json, stdout);
    expect(() => cleanTranscript(transcript)).not.toThrow();
    expect(cleanTranscript(transcript)).toBe('');
  });

  it('does not turn non-empty input into an empty string', () => {
    expect(cleanTranscript('a')).toBe('a');
    expect(cleanTranscript(' [MUSIC] Please send the report. *laughs* ')).toBe('Please send the report.');
  });
});
