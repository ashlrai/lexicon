import { describe, expect, it } from 'vitest';
import { cleanTranscript } from './transcribe.js';

describe('cleanTranscript', () => {
  it.each([
    ['empty input', ''],
    ['spaces', '   '],
    ['tabs and line breaks', '\t\r\n\n'],
    ['mixed Unicode whitespace', ' \u00a0\u2003\u2028\u2029\ufeff\t'],
    ['noise annotations and whitespace', ' \t[BLANK_AUDIO]\n(soft music) *laughs*  '],
  ])('returns an empty string for %s', (_description, input) => {
    expect(cleanTranscript(input)).toBe('');
  });

  it('preserves ordinary prose without annotations', () => {
    const prose = "Let's review the report, then send it to the team. Does that work?";
    expect(cleanTranscript(prose)).toBe(prose);
  });

  it('preserves multiline prose and spoken parentheticals while normalizing whitespace', () => {
    const prose = '  Please review the café menu (including the specials),\n\tthen send it to Zoë.  ';
    expect(cleanTranscript(prose)).toBe('Please review the café menu (including the specials), then send it to Zoë.');
  });

  it.each([
    ['an unmatched opening bracket', 'Please keep [unfinished speech.', 'Please keep [unfinished speech.'],
    ['an unmatched closing bracket', 'Please keep unfinished] speech.', 'Please keep unfinished] speech.'],
    ['an opening bracket after a complete tag', '  Please [noise] continue [unfinished\nthought  ', 'Please continue [unfinished thought'],
    ['a closing bracket before a complete tag', '  Please unfinished] [noise] continue\nnow  ', 'Please unfinished] continue now'],
  ])('preserves %s', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('removes a one-word asterisk tag while preserving surrounding speech', () => {
    expect(cleanTranscript('Please continue *whispers* with the rollout.')).toBe('Please continue with the rollout.');
  });

  it('removes up to three starred words but preserves a four-word span', () => {
    expect(cleanTranscript('Please continue *door slams loudly* with the rollout.')).toBe('Please continue with the rollout.');
    expect(cleanTranscript('Please keep *these four spoken words* intact.')).toBe('Please keep *these four spoken words* intact.');
  });
});
