import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md. cleanTranscript drops a starred run of
// one to three plain words, so three words is the longest tag it removes.
describe('cleanTranscript three-word asterisk tag', () => {
  it('documents the three-word boundary in the voice contract', () => {
    const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
    const voice = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';
    expect(voice).toContain('`*...*` of one to three plain words always');
  });

  it('removes the tag and keeps every surrounding word in order', () => {
    expect(cleanTranscript('Please send *door slams shut* the report today.'))
      .toBe('Please send the report today.');
  });

  it.each([
    ['at the start', '*door slams shut* Please send the report.', 'Please send the report.'],
    ['at the end', 'Please send the report. *door slams shut*', 'Please send the report.'],
    ['touching the speech', 'Please*door slams shut*continue.', 'Please continue.'],
    ['with a tab and newline between words', 'Please *door\tslams\nshut* continue.', 'Please continue.'],
    ['capitalized', 'Please *Door Slams Shut* continue.', 'Please continue.'],
    ['with arbitrary words', 'Please *ice cream sandwich* continue.', 'Please continue.'],
    ['twice', 'One *door slams shut* two *phone rings loudly* three.', 'One two three.'],
    ['as the whole transcript', '*door slams shut*', ''],
  ])('removes it %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['a comma', '*door, slams shut*'],
    ['a digit', '*door slams 2*'],
    ['four words', '*the door slams shut*'],
    ['a space inside the opening asterisk', '* door slams shut*'],
  ])('keeps a starred triple with %s', (_label, tag) => {
    expect(cleanTranscript(`Before ${tag} after.`)).toBe(`Before ${tag} after.`);
  });

  it('removes a three-word segment from whisper JSON output', () => {
    const json = JSON.stringify({
      transcription: [{ text: 'Please send the report' }, { text: '*door slams shut*' }, { text: 'to the team.' }],
    });
    expect(cleanTranscript(parseWhisperOutput(json, 'ignored stdout')))
      .toBe('Please send the report to the team.');
  });
});
