import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts.
describe('cleanTranscript contract', () => {
  it.each([
    ['arbitrary bracketed tags', 'Before [speaker 2: hello] after.', 'Before after.'],
    ['adjacent bracketed tags', 'Before the release[noise][MUSIC]after the vote.', 'Before the release after the vote.'],
    ['a laughter action within speech', 'I thought that was funny *laughs* but let us continue.', 'I thought that was funny but let us continue.'],
    ['one plain starred word', 'Before *anything* after.', 'Before after.'],
    ['two plain starred words', 'Before *any words* after.', 'Before after.'],
    ['three plain starred words', 'Before *any three words* after.', 'Before after.'],
    ['four plain starred words', 'Before *keep these four words* after.', 'Before *keep these four words* after.'],
    ['a noise parenthetical', 'Before (soft music) after.', 'Before after.'],
    ['a spoken parenthetical', 'Before (the new build) after.', 'Before (the new build) after.'],
  ])('handles %s', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['Whisper JSON segments', JSON.stringify({ transcription: [
      { text: 'Please send the report' },
      { text: '*whispers*' },
      { text: 'to the team.' },
    ] }), 'ignored stdout'],
    ['stdout fallback', undefined, 'Please send the report *whispers* to the team.'],
  ])('removes a one-word annotation from %s while preserving the transcript', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('Please send the report to the team.');
  });

  it.each([
    ['Whisper JSON segments', JSON.stringify({ transcription: [
      { text: 'Before *door slams loudly*' },
      { text: '*keep these four words* after.' },
    ] }), 'ignored stdout'],
    ['stdout fallback', undefined, 'Before *door slams loudly* *keep these four words* after.'],
  ])('retains a four-word starred span from %s', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('Before *keep these four words* after.');
  });

  it('cleans tags and whitespace while preserving a four-word phrase', () => {
    const input = ' \t[MUSIC] Please *door slams loudly* keep *these four spoken words*\n(soft music) intact.  ';
    expect(cleanTranscript(input)).toBe('Please keep *these four spoken words* intact.');
  });
});
