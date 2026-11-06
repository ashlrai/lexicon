import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `[...]` tags always, collapses whitespace and trims;
// docs/transcript-cleaning-scope.md adds that every complete `[...]` span is
// replaced with a space and an unmatched opening bracket is left in the
// transcript. A tag at the start is no exception: it becomes a space, the
// space collapses and trims away, and the first spoken word leads the result.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript bracketed tag at the start', () => {
  it('is named by docs/CONTRACT.md as an always-dropped tag, with the trim removing its residue', () => {
    expect(bullet).toContain('`[...]` tags always');
    expect(bullet).toContain('collapses whitespace, trims');
  });

  it.each([
    ['a spaced noise tag', '[BLANK_AUDIO] send the report', 'send the report'],
    ['a tag touching the first word', '[MUSIC]send the report', 'send the report'],
    ['leading whitespace before the tag', '  [inaudible]  send the report', 'send the report'],
    ['a newline after the tag', '[speaker 1]\nsend the report', 'send the report'],
    ['adjacent tags', '[noise][MUSIC] send the report', 'send the report'],
    ['an empty tag', '[] send the report', 'send the report'],
    ['a multi-word tag', '[background music playing] send the report', 'send the report'],
    ['a tag spanning a newline', '[back\nground] send the report', 'send the report'],
    ['non-ASCII tag content', '[ruido de fondo] send the report', 'send the report'],
    ['punctuation on the first word', '[noise] send, then report.', 'send, then report.'],
  ])('removes %s at the start while every following word remains', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('keeps every following word in order', () => {
    expect(cleanTranscript('[MUSIC] alpha beta gamma delta')).toBe('alpha beta gamma delta');
  });

  it('leaves no residue, so the first spoken word leads the cleaned transcript', () => {
    const cleaned = cleanTranscript('[MUSIC] send the report');
    expect(cleaned.startsWith('send')).toBe(true);
    expect(cleaned).toBe(cleaned.trim());
  });

  it('preserves an unmatched opening bracket at the start, which is not a tag', () => {
    expect(cleanTranscript('[unfinished send the report')).toBe('[unfinished send the report');
    expect(cleanTranscript('[MUSIC] send [unfinished report')).toBe('send [unfinished report');
  });

  it('removes a start tag alongside the other annotation kinds', () => {
    expect(cleanTranscript(' [MUSIC] send (applause) the *laughs* report [noise] '))
      .toBe('send the report');
  });

  it.each([
    ['Whisper JSON segments', JSON.stringify({ transcription: [
      { text: '[MUSIC]' },
      { text: 'send' },
      { text: 'the report' },
    ] }), 'ignored stdout'],
    ['a tag leading the first JSON segment', JSON.stringify({ transcription: [
      { text: '[MUSIC] send' },
      { text: 'the report' },
    ] }), 'ignored stdout'],
    ['stdout fallback', undefined, '[MUSIC] send the report'],
    ['stdout fallback with leading whitespace', undefined, '  [BLANK_AUDIO]\nsend the report  '],
  ])('removes the leading tag from %s while the following words remain', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('send the report');
  });
});
