import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

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
    ['between sentences', 'First sentence. *VERY loud noise* Second sentence!', 'First sentence. Second sentence!'],
    ['touching surrounding text', 'Keep*random three words*both sides.', 'Keep both sides.'],
    ['before speech', '*birds sing softly* The meeting starts now.', 'The meeting starts now.'],
    ['after speech', 'The meeting starts now. *birds sing softly*', 'The meeting starts now.'],
    ['with mixed whitespace', 'Send the report *door\tcloses\nloudly* to the team.', 'Send the report to the team.'],
  ])('removes a three-word annotation %s without losing transcript text', (_position, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('cleans tags and whitespace while preserving a four-word phrase', () => {
    const input = ' \t[MUSIC] Please *door slams loudly* keep *these four spoken words*\n(soft music) intact.  ';
    expect(cleanTranscript(input)).toBe('Please keep *these four spoken words* intact.');
  });
});
