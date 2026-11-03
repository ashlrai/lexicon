import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `*...*` of one to three plain words only, so a four-word starred span is
// dictated emphasis and must survive untouched.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript four-word asterisk span', () => {
  it('is limited by docs/CONTRACT.md to one to three words', () => {
    expect(bullet).toContain('`*...*` of one to three plain words always');
  });

  it.each([
    ['mid sentence', 'Please send *keep these four words* today.', 'Please send *keep these four words* today.'],
    ['at the start', '*keep these four words* then continue.', '*keep these four words* then continue.'],
    ['at the end', 'Then continue *keep these four words*', 'Then continue *keep these four words*'],
    ['as the whole transcript', '*keep these four words*', '*keep these four words*'],
    ['with extra whitespace', '  Please   *keep these four words*\n today. ', 'Please *keep these four words* today.'],
  ])('preserves the span %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('preserves the span while still dropping a short annotation beside it', () => {
    expect(cleanTranscript('Hello *laughs* and *keep these four words* now.'))
      .toBe('Hello and *keep these four words* now.');
  });

  it('preserves the span in whisper JSON output', () => {
    const json = JSON.stringify({
      transcription: [{ text: 'Please send' }, { text: '*keep these four words*' }, { text: 'today.' }],
    });
    expect(cleanTranscript(parseWhisperOutput(json, 'ignored stdout')))
      .toBe('Please send *keep these four words* today.');
  });
});
