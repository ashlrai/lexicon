import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `[...]` spans always, and docs/transcript-cleaning-scope.md spells out that
// "an unmatched opening bracket is left in the transcript". An opener that
// never meets a `]` is dictated text like any other punctuation: the mark and
// the words beside it must come through untouched. (A later `]` closes the
// span by design, see clean-transcript-multiple-bracketed-tags.test.ts.)
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';
const scopeDoc = readFileSync(new URL('../docs/transcript-cleaning-scope.md', import.meta.url), 'utf8');

describe('cleanTranscript unmatched opening bracket', () => {
  it('is excluded by the docs from the bracketed tag', () => {
    expect(bullet).toContain('`[...]` tags always');
    // The scope doc hard-wraps its prose, so compare on collapsed whitespace.
    expect(scopeDoc.replace(/\s+/g, ' ')).toContain('An unmatched opening bracket is left in the transcript');
  });

  it.each([
    ['mid sentence', 'Please keep [unfinished intact.'],
    ['at the very start', '[ Please continue.'],
    ['at the very end', 'Please continue. ['],
    ['the whole transcript', '['],
    ['two lone marks', 'Keep [ and [ here.'],
    ['a stray closing bracket', 'Keep unfinished] intact.'],
    ['a closing mark before the opening one', 'a ] b [ c'],
    ['an unmatched opener right before punctuation', 'Send it [. tomorrow'],
    ['an unmatched opener holding digits and a space', 'Keep [room 2 here'],
  ])('preserves %s', (_label, input) => {
    expect(cleanTranscript(input)).toBe(input);
  });

  it.each([
    ['a tag before it', '[MUSIC] keep [unfinished here.', 'keep [unfinished here.'],
    ['tags on both sides of the words', 'One [noise] two [music] three [unfinished', 'One two three [unfinished'],
    ['a complete tag before punctuation beside it', 'Send [MUSIC]. and [rest', 'Send. and [rest'],
    ['an empty complete span beside it', 'Keep [] and [unfinished here', 'Keep and [unfinished here'],
    ['a noise parenthesis after it', 'Tell [unclosed (applause) now.', 'Tell [unclosed now.'],
    ['a noise parenthesis inside its tail', 'Tell me [a (applause) story', 'Tell me [a story'],
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
