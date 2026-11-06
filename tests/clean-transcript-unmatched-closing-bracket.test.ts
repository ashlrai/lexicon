import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `[...]` spans always, and docs/transcript-cleaning-scope.md spells out that
// "a closing bracket with no opening one" is left in the transcript. A `]`
// that never pairs into a complete span is dictated text like any other
// punctuation: the mark and the words beside it must come through untouched.
// (A `]` after an unmatched `[` does close that span, see
// clean-transcript-multiple-bracketed-tags.test.ts.)
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';
const scopeDoc = readFileSync(new URL('../docs/transcript-cleaning-scope.md', import.meta.url), 'utf8');

describe('cleanTranscript unmatched closing bracket', () => {
  it('is excluded by the docs from the bracketed tag', () => {
    expect(bullet).toContain('`[...]` tags always');
    // The scope doc hard-wraps its prose, so compare on collapsed whitespace.
    expect(scopeDoc.replace(/\s+/g, ' ')).toContain('a closing bracket with no opening one');
    expect(scopeDoc).toContain('`Keep unfinished] here` | `Keep unfinished] here`');
  });

  it.each([
    ['mid sentence', 'Please keep unfinished] intact.'],
    ['at the very start', '] Please continue.'],
    ['at the very end', 'Please continue. ]'],
    ['the whole transcript', ']'],
    ['two lone marks', 'Keep ] and ] here.'],
    ['marks attached to words', 'The list reads a] b] c].'],
    ['a mark holding a digit', 'Keep room 2] rates here.'],
    ['a stray mark before punctuation', 'Send it ]. tomorrow'],
    ['a closer before a later unmatched opener', 'a ] b [ c'],
  ])('preserves %s', (_label, input) => {
    expect(cleanTranscript(input)).toBe(input);
  });

  it.each([
    ['a tag before it', '[MUSIC] keep ]unfinished here.', 'keep ]unfinished here.'],
    ['a tag after it', 'a ] b [MUSIC] c', 'a ] b c'],
    ['a tag on each side', 'Tags ]out [MUSIC][noise] end', 'Tags ]out end'],
    ['a tag before punctuation beside it', 'Send ]it [MUSIC]. tomorrow', 'Send ]it. tomorrow'],
    ['a noise parenthesis after it', 'Tell ]unclosed (applause) now.', 'Tell ]unclosed now.'],
    ['a starred tag after it', 'Say ]unfinished *laughs* today.', 'Say ]unfinished today.'],
    ['a complete span a later closer ends', 'a ] b [ c ] d', 'a ] b d'],
    ['a span an earlier closer ends', 'a [ b ] ] c', 'a ] c'],
    ['a span ending before it', 'x [a ] b] y', 'x b] y'],
    ['a tag as the only other text', '] [MUSIC]', ']'],
    ['a noise parenthesis as the only neighbour', 'Keep it] (soft music) tonight', 'Keep it] tonight'],
    ['a tag between it and the words', 'One [noise] two] three.', 'One two] three.'],
  ])('keeps the bracket and its text while dropping %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('collapses whitespace and is idempotent', () => {
    expect(cleanTranscript('  Keep   unfinished]\nhere  ')).toBe('Keep unfinished] here');
    const once = cleanTranscript('[MUSIC] Keep ]unfinished here');
    expect(cleanTranscript(once)).toBe(once);
  });

  it('preserves it through Whisper JSON and stdout fallback', () => {
    const json = JSON.stringify({ transcription: [{ text: '[MUSIC] Please keep ]unfinished' }, { text: 'here' }, { text: 'today.' }] });
    expect(cleanTranscript(parseWhisperOutput(json, 'ignored'))).toBe('Please keep ]unfinished here today.');
    expect(cleanTranscript(parseWhisperOutput(undefined, 'Please keep ]unfinished here today.'))).toBe('Please keep ]unfinished here today.');
  });
});
