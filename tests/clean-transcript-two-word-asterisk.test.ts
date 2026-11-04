import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `*...*` of one to three plain words always, and the doc names `*door slams*`
// (two words) as an example.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript two-word asterisk tag', () => {
  it('is named by docs/CONTRACT.md as a documented two-word example', () => {
    expect(bullet).toContain('`*...*` of one to three plain words always');
    expect(bullet).toContain('`*door slams*`');
  });

  it('removes the tag and keeps every surrounding word in order', () => {
    expect(cleanTranscript('Please send *door slams* the report today.'))
      .toBe('Please send the report today.');
  });

  it.each([
    ['at the start', '*door slams* Please send the report.', 'Please send the report.'],
    ['at the end', 'Please send the report. *door slams*', 'Please send the report.'],
    ['touching the speech', 'Please*door slams*continue.', 'Please continue.'],
    ['with a tab and newline between its words', 'Please *door\t\nslams* continue.', 'Please continue.'],
    ['twice', 'One *door slams* two *phone rings* three.', 'One two three.'],
    ['as the whole transcript', '*door slams*', ''],
  ])('removes it %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['a comma', '*door, slams*'],
    ['a digit', '*door 2*'],
    ['a space inside the opening asterisk', '* door slams*'],
    ['a space inside the closing asterisk', '*door slams *'],
  ])('keeps a starred pair with %s', (_label, tag) => {
    expect(cleanTranscript(`Before ${tag} after.`)).toBe(`Before ${tag} after.`);
  });

  it('removes a two-word segment from whisper JSON output', () => {
    const json = JSON.stringify({
      transcription: [{ text: 'Please send the report' }, { text: '*door slams*' }, { text: 'to the team.' }],
    });
    expect(cleanTranscript(parseWhisperOutput(json, 'ignored stdout')))
      .toBe('Please send the report to the team.');
  });
});
