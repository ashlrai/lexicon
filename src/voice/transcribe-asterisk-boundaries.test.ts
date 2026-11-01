import { describe, expect, it } from 'vitest';
import { cleanTranscript } from './transcribe.js';

describe('cleanTranscript asterisk boundaries', () => {
  it.each([
    ['one word', 'Please *whispers* continue.', 'Please continue.'],
    ['two words', 'Please *door slams* continue.', 'Please continue.'],
    ['three words', 'Please *door slams loudly* continue.', 'Please continue.'],
    ['mixed whitespace', 'Please *door\t slams\nloudly* continue.', 'Please continue.'],
    ['an arbitrary word', 'Please *banana* continue.', 'Please continue.'],
    ['touching speech', 'Please*door slams loudly*continue.', 'Please continue.'],
    ['at the beginning', '*laughs* Please continue.', 'Please continue.'],
    ['at the end', 'Please continue. *laughs*', 'Please continue.'],
    ['the entire transcript', '*door slams loudly*', ''],
    ['multiple spans', 'Please *laughs* continue *door slams* now.', 'Please continue now.'],
  ])('removes %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['four words', 'Please keep *these four spoken words* intact.'],
    ['more than four words', 'Please keep *all five of these words* intact.'],
    ['punctuation', 'Please keep *hello, world* intact.'],
    ['a hyphen', 'Please keep *well-known* intact.'],
    ['a digit', 'Please keep *version 2* intact.'],
    ['an opening delimiter', 'Please keep *unfinished intact.'],
    ['a closing delimiter', 'Please keep unfinished* intact.'],
  ])('preserves %s', (_label, input) => {
    expect(cleanTranscript(input)).toBe(input);
  });

  it.each([
    ['a leading quote', '*"laughs*'],
    ['a trailing period', '*laughs.*'],
    ['a comma between words', '*door, slams*'],
    ['a hyphen between words', '*door-slams*'],
    ['an apostrophe', "*it's working*"],
    ['a slash', '*yes/no*'],
    ['a colon', '*noise: static*'],
    ['question and exclamation marks', '*really?!*'],
    ['Unicode punctuation', '*door’s open*'],
  ])('preserves starred content containing %s', (_label, content) => {
    expect(cleanTranscript(`Before ${content} after.`)).toBe(`Before ${content} after.`);
    expect(cleanTranscript(content)).toBe(content);
  });

  it('removes plain-word tags while keeping punctuation outside their delimiters', () => {
    expect(cleanTranscript('Ready, *laughs*! Then *door slams*, and *door slams loudly*.'))
      .toBe('Ready, ! Then , and .');
  });

  it('preserves punctuation-bearing content alongside removable plain-word tags', () => {
    expect(cleanTranscript('Before *laughs* keep *door, slams* and *well-known* after *door slams loudly*.'))
      .toBe('Before keep *door, slams* and *well-known* after .');
  });

  it('normalizes whitespace in punctuation-bearing content without removing it', () => {
    expect(cleanTranscript('  Before\n*door,\t slams*\tafter  ')).toBe('Before *door, slams* after');
  });
});
