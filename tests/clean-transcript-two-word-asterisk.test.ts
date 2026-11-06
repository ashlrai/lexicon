import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `*...*` of one to three plain words always, whatever the words are (unlike
// `( ... )`, which must look like a noise annotation), and the doc names
// `*door slams*` (two words) as an example. A starred pair stops being two
// plain words, and so survives, once it holds a comma, a digit or a stray
// space just inside an asterisk.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';
const starredExamples = [...bullet.matchAll(/`\*([A-Za-z]+(?: [A-Za-z]+){0,2})\*`/g)].map((m) => m[1]);
const twoWordExamples = starredExamples.filter((e) => e.split(' ').length === 2);

describe('cleanTranscript two-word asterisk tag', () => {
  it('is named by docs/CONTRACT.md as a documented two-word example', () => {
    expect(bullet).toContain('`*...*` of one to three plain words always');
    expect(bullet).toContain('`*door slams*`');
    expect(twoWordExamples).toContain('door slams');
  });

  it.each(twoWordExamples)('drops the documented *%s* between spoken words', (example) => {
    expect(cleanTranscript(`Please send *${example}* the report.`)).toBe('Please send the report.');
  });

  it('removes the tag and keeps every surrounding word in order', () => {
    expect(cleanTranscript('Please send *door slams* the report today.'))
      .toBe('Please send the report today.');
  });

  it('preserves the surrounding sentence when cleaned again', () => {
    const cleaned = cleanTranscript('After the meeting, *phone rings* please call the team.');
    expect(cleaned).toBe('After the meeting, please call the team.');
    expect(cleanTranscript(cleaned)).toBe(cleaned);
  });

  it.each([
    ['at the start', '*door slams* Please send the report.', 'Please send the report.'],
    ['at the end', 'Please send the report. *door slams*', 'Please send the report.'],
    ['touching the speech', 'Please*door slams*continue.', 'Please continue.'],
    ['with a tab and newline between its words', 'Please *door\t\nslams* continue.', 'Please continue.'],
    ['with several spaces between its words', 'Please *door   slams* continue.', 'Please continue.'],
    ['with a non-breaking space between its words', 'Please *door\u00a0slams* continue.', 'Please continue.'],
    ['capitalized', 'Please *Door Slams* continue.', 'Please continue.'],
    ['in all caps', 'Please *DOOR SLAMS* continue.', 'Please continue.'],
    ['with arbitrary words, not a noise', 'Please *ice cream* continue.', 'Please continue.'],
    ['twice', 'One *door slams* two *phone rings* three.', 'One two three.'],
    ['adjacent to a second tag', 'One *door slams**phone rings* two.', 'One two.'],
    ['with punctuation touching it', 'Wait,*door slams*go.', 'Wait, go.'],
    ['beside a parenthesised noise tag', 'Please (applause) *door slams* continue.', 'Please continue.'],
    ['as the whole transcript', '*door slams*', ''],
  ])('removes it %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['a comma', '*door, slams*'],
    ['a digit', '*door 2*'],
    ['an exclamation mark', '*door slams!*'],
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

  it('removes a tag split across two whisper JSON segments', () => {
    const json = JSON.stringify({
      transcription: [{ text: 'Please send the report' }, { text: '*door' }, { text: 'slams*' }, { text: 'to the team.' }],
    });
    expect(cleanTranscript(parseWhisperOutput(json, 'ignored stdout')))
      .toBe('Please send the report to the team.');
  });

  it('removes the tag from the stdout fallback', () => {
    expect(cleanTranscript(parseWhisperOutput(undefined, 'Please *door slams* continue.')))
      .toBe('Please continue.');
  });
});
