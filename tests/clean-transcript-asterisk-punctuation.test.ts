import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops a
// `*...*` span only when it holds one to three plain words, and a word is
// ASCII letters alone (docs/transcript-cleaning-scope.md). Punctuation, a
// digit or a non-ASCII letter anywhere inside the delimiters means the span is
// dictated text, not a sound annotation, so it comes through unchanged.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';
const scopeDoc = readFileSync(new URL('../docs/transcript-cleaning-scope.md', import.meta.url), 'utf8');

describe('cleanTranscript asterisk phrase with punctuation', () => {
  it('is limited by the docs to spans of one to three plain ASCII-letter words', () => {
    expect(bullet).toContain('`*...*` of one to three plain words always');
    expect(scopeDoc).toContain('a word consists only of ASCII letters');
    expect(scopeDoc).toContain('digits, punctuation, and unmatched asterisks do not match this short-tag shape');
  });

  it.each([
    ['a comma between words', 'Please keep *hello, world* intact.'],
    ['a hyphen', 'Please keep *well-known* intact.'],
    ['an apostrophe', "Please keep *it's working* intact."],
    ['a slash', 'Please keep *yes/no* intact.'],
    ['a colon', 'Please keep *noise: static* intact.'],
    ['a question and an exclamation mark', 'Please keep *really?!* intact.'],
    ['a trailing period', 'Please keep *laughs.* intact.'],
    ['a leading period', 'Please keep *.dotfiles* intact.'],
    ['double quotes', 'Please keep *"quoted" words* intact.'],
    ['an ampersand', 'Please keep *rock & roll* intact.'],
    ['plus signs', 'Please keep *C++ notes* intact.'],
    ['a percent sign', 'Please keep *50% off* intact.'],
    ['a digit', 'Please keep *room 2* intact.'],
    ['abbreviation periods', 'Please keep *e.g. this* intact.'],
    ['an underscore', 'Please keep *under_score* intact.'],
    ['a semicolon', 'Please keep *semi;colon* intact.'],
    ['an equals sign', 'Please keep *a=b* intact.'],
    ['angle brackets', 'Please keep *<aside>* intact.'],
    ['a hash', 'Please keep *#hashtag* intact.'],
    ['an at sign', 'Please keep *@mention* intact.'],
    ['a non-ASCII letter', 'Please keep *café menu* intact.'],
    ['an emoji', 'Please keep *nice 👍* intact.'],
    ['a Unicode apostrophe', 'Please keep *door’s open* intact.'],
  ])('preserves a starred phrase containing %s', (_label, input) => {
    expect(cleanTranscript(input)).toBe(input);
  });

  it.each([
    ['at the start', '*hello, world* then continue.'],
    ['at the end', 'Then keep *well-known*'],
    ['touching speech on both sides', 'Please*hello, world*intact.'],
    ['as the whole transcript', '*really?!*'],
    ['several times in one transcript', 'Keep *hello, world* and *well-known* here.'],
  ])('preserves the punctuated span %s', (_label, input) => {
    expect(cleanTranscript(input)).toBe(input);
  });

  it.each([
    ['a one-word annotation before it', 'Before *laughs* keep *hello, world* after.', 'Before keep *hello, world* after.'],
    ['a three-word annotation after it', 'Keep *hello, world* and *door slams loudly* here.', 'Keep *hello, world* and here.'],
    ['annotations on both sides', 'Say *laughs* keep *well-known* and *door slams* done.', 'Say keep *well-known* and done.'],
    ['a bracketed tag beside it', 'Say *hello, world* [MUSIC] today.', 'Say *hello, world* today.'],
    ['a noise parenthesis beside it', 'Tell *yes/no* (applause) now.', 'Tell *yes/no* now.'],
  ])('keeps the punctuated span while dropping %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['a bracketed tag removed first', 'Before *hello [noise] world* after.', 'Before after.'],
    ['a noise parenthesis removed first', 'Keep *a (applause) b* here.', 'Keep here.'],
    ['a plain-word span inside parentheses', 'Keep (*laughs*) here.', 'Keep ( ) here.'],
  ])('removes a span that becomes plain words once %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('keeps the span when an inner parenthesis is dictated text, not a noise tag', () => {
    expect(cleanTranscript('Keep *a (the build) b* here.')).toBe('Keep *a (the build) b* here.');
  });

  it('removes the same words once the punctuation is gone', () => {
    expect(cleanTranscript('Please keep *hello world* intact.')).toBe('Please keep intact.');
    expect(cleanTranscript('Please keep *really* intact.')).toBe('Please keep intact.');
  });

  it('collapses whitespace inside a punctuated span without removing it', () => {
    expect(cleanTranscript('  Keep\n*door,\t slams*\there  ')).toBe('Keep *door, slams* here');
  });

  it('returns identical text when its own output is cleaned again', () => {
    const sentence = 'Please keep *hello, world* intact.';
    expect(cleanTranscript(cleanTranscript(sentence))).toBe(sentence);
  });

  it.each([
    ['Whisper JSON segments', JSON.stringify({ transcription: [
      { text: 'Please keep' },
      { text: '*hello, world*' },
      { text: 'intact.' },
    ] }), 'ignored stdout'],
    ['a stdout fallback', undefined, 'Please keep *hello, world* intact.'],
  ])('preserves the punctuated span from %s', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('Please keep *hello, world* intact.');
  });
});
