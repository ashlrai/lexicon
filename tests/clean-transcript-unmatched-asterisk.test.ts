import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `*...*` of one to three plain words always, and docs/transcript-cleaning-scope.md
// spells out that "unmatched asterisks do not match this short-tag shape". An
// asterisk that never pairs into a complete span is dictated text like any
// other punctuation: the mark and the words beside it must come through
// untouched, whether it opens without closing, closes without opening, or
// stands alone.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';
const scopeDoc = readFileSync(new URL('../docs/transcript-cleaning-scope.md', import.meta.url), 'utf8');

describe('cleanTranscript unmatched asterisk', () => {
  it('is excluded by the docs from the one-to-three-word starred tag', () => {
    expect(bullet).toContain('`*...*` of one to three plain words always');
    expect(scopeDoc).toContain('unmatched asterisks do not match this short-tag shape');
  });

  it.each([
    ['an opening mark mid sentence', 'Please keep *unfinished intact.'],
    ['a closing mark mid sentence', 'Please keep unfinished* intact.'],
    ['a lone mark between words', 'The rate is a * b, times c.'],
    ['a mark inside a word', 'The formula a*b holds.'],
    ['a mark at the very start', '* Please continue.'],
    ['a mark at the very end', 'Please continue. *'],
    ['the whole transcript', '*'],
    ['two lone marks', 'Keep * and * here.'],
    ['an empty pair', 'Keep ** here.'],
    ['a space inside the would-be closing mark', 'Keep * note * here.'],
    ['spaced math marks', 'The total is 2 * 3 * 4, not 24.'],
  ])('preserves %s and the words beside it', (_label, input) => {
    expect(cleanTranscript(input)).toBe(input);
  });

  it.each([
    ['a removable tag after the opening mark', 'Keep *unfinished *laughs* here.', 'Keep *unfinished here.'],
    ['a removable tag before the closing mark', '*laughs* keep unfinished* here.', 'keep unfinished* here.'],
    ['removable tags on both flanks', '*laughs* keep *unfinished *sighs* here.', 'keep *unfinished here.'],
    ['a removable tag without reaching across spoken words', 'First *unfinished then *laughs* done.', 'First *unfinished then done.'],
    ['a bracketed tag beside it', 'Say *unfinished [MUSIC] today.', 'Say *unfinished today.'],
    ['a noise parenthesis beside it', 'Tell *unclosed (applause) now.', 'Tell *unclosed now.'],
    ['a complete span before an in-word mark', 'a*b*c*d', 'a c*d'],
  ])('keeps the mark and its neighbours while dropping %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('still collapses whitespace around the preserved mark and words', () => {
    expect(cleanTranscript('  Keep   *unfinished\nhere  ')).toBe('Keep *unfinished here');
    expect(cleanTranscript('\tPlease\tkeep unfinished*\n\nintact.\t')).toBe('Please keep unfinished* intact.');
  });

  it('returns identical text when its own output is cleaned again', () => {
    const sentence = 'Please keep *unfinished intact.';
    expect(cleanTranscript(cleanTranscript(sentence))).toBe(sentence);
  });

  it.each([
    ['Whisper JSON segments', JSON.stringify({ transcription: [
      { text: 'Please keep *unfinished' },
      { text: 'here [MUSIC]' },
      { text: 'today.' },
    ] }), 'ignored stdout'],
    ['a stdout fallback', undefined, 'Please keep *unfinished here today.'],
  ])('preserves the mark and adjacent words from %s', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('Please keep *unfinished here today.');
  });
});
