import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `[...]` tags always, collapses whitespace and trims;
// docs/transcript-cleaning-scope.md adds that every complete `[...]` span is
// replaced with a space and an unmatched closing bracket is left in the
// transcript. A tag at the end is no exception: it becomes a space, the
// space collapses and trims away, and the last spoken word ends the result.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript bracketed tag at the end', () => {
  it('is named by docs/CONTRACT.md as an always-dropped tag, with the trim removing its residue', () => {
    expect(bullet).toContain('`[...]` tags always');
    expect(bullet).toContain('collapses whitespace, trims');
  });

  it.each([
    ['a spaced noise tag', 'send the report [BLANK_AUDIO]', 'send the report'],
    ['a tag touching the last word', 'send the report[MUSIC]', 'send the report'],
    ['a tag after the final punctuation', 'send the report. [inaudible]', 'send the report.'],
    ['trailing whitespace after the tag', 'send the report [noise]  \n', 'send the report'],
    ['adjacent tags', 'send the report[noise][MUSIC]', 'send the report'],
    ['an empty tag', 'send the report[]', 'send the report'],
    ['a multi-word tag', 'send the report [background music playing]', 'send the report'],
    ['a tag spanning a newline', 'send the report[back\nground]', 'send the report'],
    ['non-ASCII tag content', 'send the report [ruido de fondo]', 'send the report'],
    ['non-ASCII preceding words', 'Zoë sends the café menu [phone rings]', 'Zoë sends the café menu'],
  ])('removes %s at the end while every preceding word remains', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('keeps every preceding word in order', () => {
    expect(cleanTranscript('alpha beta gamma delta [noise]')).toBe('alpha beta gamma delta');
  });

  it('leaves no residue, so the last spoken word ends the cleaned transcript', () => {
    const cleaned = cleanTranscript('send the report [MUSIC]');
    expect(cleaned.endsWith('report')).toBe(true);
    expect(cleaned).toBe(cleaned.trim());
  });

  it('preserves an unmatched closing bracket at the end, which is not a tag', () => {
    expect(cleanTranscript('send the report unfinished]')).toBe('send the report unfinished]');
    expect(cleanTranscript('send the report[MUSIC] over]')).toBe('send the report over]');
  });

  it('preserves an unmatched opening bracket at the end, which is not a tag', () => {
    expect(cleanTranscript('send the report [unfinished')).toBe('send the report [unfinished');
  });

  it('removes an end tag alongside the other annotation kinds', () => {
    expect(cleanTranscript(' [noise] send (applause) the *laughs* report [MUSIC] '))
      .toBe('send the report');
  });

  it.each([
    ['Whisper JSON segments', JSON.stringify({ transcription: [
      { text: 'send' },
      { text: 'the report' },
      { text: '[MUSIC]' },
    ] }), 'ignored stdout'],
    ['a tag ending the last JSON segment', JSON.stringify({ transcription: [
      { text: 'send' },
      { text: 'the report [MUSIC]' },
    ] }), 'ignored stdout'],
    ['stdout fallback', undefined, 'send the report [BLANK_AUDIO]'],
    ['stdout fallback with trailing whitespace', undefined, '  send the report\n[inaudible]  '],
  ])('removes the trailing tag from %s while the preceding words remain', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('send the report');
  });
});
