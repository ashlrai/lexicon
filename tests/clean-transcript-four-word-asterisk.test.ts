import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `*...*` of one to three plain words only, and docs/transcript-cleaning-scope.md
// spells out that "Four or more words ... do not match this short-tag shape", so
// a four-word starred span is dictated emphasis and must survive untouched.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';
const scopeDoc = readFileSync(new URL('../docs/transcript-cleaning-scope.md', import.meta.url), 'utf8');

describe('cleanTranscript four-word asterisk span', () => {
  it('is limited by the docs to spans shorter than four words', () => {
    expect(bullet).toContain('`*...*` of one to three plain words always');
    expect(scopeDoc).toContain('Four or more words,');
    expect(scopeDoc).toContain('do not match this short-tag shape');
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

  it.each([
    ['capitalized', 'Please send *Keep These Four Words* today.'],
    ['in all caps', 'Please send *KEEP THESE FOUR WORDS* today.'],
    ['touching the speech', 'Please*keep these four words*continue.'],
    ['twice in one transcript', 'Say *keep these four words* and *those four words too* now.'],
  ])('preserves the span %s', (_label, input) => {
    expect(cleanTranscript(input)).toBe(input);
  });

  // Any whitespace separates the words, so a tab, newline or non-breaking
  // space inside still counts four words; the span survives and only the
  // whitespace inside it collapses.
  it.each([
    ['a tab', 'Please *keep\tthese four words* today.'],
    ['a newline', 'Please *keep these\nfour words* today.'],
    ['a non-breaking space', 'Please *keep\u00a0these four words* today.'],
  ])('preserves the span across %s between its words', (_label, input) => {
    expect(cleanTranscript(input)).toBe('Please *keep these four words* today.');
  });

  // The starred rule is a plain word count, not the noise-word check a
  // parenthesis gets: even four words that each name a sound stay, because
  // the span is past the one-to-three shape a sound annotation takes.
  it('preserves the span even when every word names a sound', () => {
    expect(cleanTranscript('Please *applause laughter music sighs* continue.'))
      .toBe('Please *applause laughter music sighs* continue.');
    expect(cleanTranscript('Please *the door slams loudly* continue.'))
      .toBe('Please *the door slams loudly* continue.');
  });

  it('still holds four words after a bracketed tag inside it is dropped', () => {
    expect(cleanTranscript('Keep *keep [MUSIC] these four words* here.'))
      .toBe('Keep *keep these four words* here.');
  });

  // The passes run in order (docs/transcript-cleaning-scope.md): a noise
  // parenthesis is removed before the starred count, so a span that read as
  // four words can shrink into the one-to-three shape and be dropped.
  it('drops the span once a noise parenthesis inside it shrinks the count to three', () => {
    expect(cleanTranscript('Keep *a (applause) b c* here.')).toBe('Keep here.');
  });

  it('keeps the span when an inner parenthesis is dictated text, not a noise tag', () => {
    expect(cleanTranscript('Keep *a (the build) b c* here.')).toBe('Keep *a (the build) b c* here.');
  });

  // `**bold**` loses its inner `*bold*` (docs/transcript-cleaning-scope.md),
  // but inside `**...**` a four-word span has no one-to-three-word match, so
  // the whole double-starred phrase survives untouched.
  it('preserves the span inside double asterisks', () => {
    expect(cleanTranscript('Keep **keep these four words** here.')).toBe('Keep **keep these four words** here.');
  });

  it('returns identical text when its own output is cleaned again', () => {
    const cleaned = cleanTranscript('Please *door slams* send *keep these four words* today.');
    expect(cleaned).toBe('Please send *keep these four words* today.');
    expect(cleanTranscript(cleaned)).toBe(cleaned);
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
