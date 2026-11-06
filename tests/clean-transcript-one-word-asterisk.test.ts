import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `*...*` of one to three plain words always, whatever the word is (unlike
// `( ... )`, which must look like a noise annotation), and the doc names
// `*laughs*` and `*door slams*` as the examples. A starred single word stops
// being one plain word, and so survives, once it holds a digit, a punctuation
// mark or a stray space just inside an asterisk.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';
const starredExamples = [...bullet.matchAll(/`\*([A-Za-z]+(?: [A-Za-z]+){0,2})\*`/g)].map((m) => m[1]);

describe('cleanTranscript one-word asterisk annotation', () => {
  it('is named by docs/CONTRACT.md as an always-dropped starred annotation', () => {
    expect(bullet).toContain('`*...*` of one to three plain words always');
    expect(starredExamples).toContain('laughs');
    expect(starredExamples).toContain('door slams');
  });

  it.each(starredExamples)('drops the documented *%s* between spoken words', (example) => {
    expect(cleanTranscript(`Please send *${example}* the report.`)).toBe('Please send the report.');
  });

  it('removes *laughs* while preserving the surrounding spoken text', () => {
    expect(cleanTranscript('I thought that was funny *laughs* but let us continue.'))
      .toBe('I thought that was funny but let us continue.');
    expect(cleanTranscript('Please continue *laughs* with the rollout.'))
      .toBe('Please continue with the rollout.');
  });

  it.each([
    ['at the start', '*laughs* Please send the report.', 'Please send the report.'],
    ['at the end', 'Please send the report. *laughs*', 'Please send the report.'],
    ['touching the speech', 'Please*laughs*continue.', 'Please continue.'],
    ['with a question mark before it', 'Really?*laughs*I doubt it.', 'Really? I doubt it.'],
    ['with a comma before it', 'Wait,*laughs*go.', 'Wait, go.'],
    ['with a newline and tab around it', 'Please\n*laughs*\tcontinue.', 'Please continue.'],
    ['capitalized', 'Please *Laughs* continue.', 'Please continue.'],
    ['in all caps', 'Please *LAUGHS* continue.', 'Please continue.'],
    ['with an arbitrary word, not a noise', 'Please *banana* continue.', 'Please continue.'],
    ['twice', 'One *laughs* two *sighs* three.', 'One two three.'],
    ['adjacent to a second tag', 'One *laughs**sighs* two.', 'One two.'],
    ['beside a parenthesised noise tag', 'Please (applause) *laughs* continue.', 'Please continue.'],
    ['as the whole transcript', '*laughs*', ''],
  ])('removes the tag %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['an exclamation mark inside', '*laughs!*'],
    ['a digit inside', '*laughs2*'],
    ['only digits', '*123*'],
    ['a space inside the opening asterisk', '* laughs*'],
    ['a space inside the closing asterisk', '*laughs *'],
    ['no word at all', '**'],
  ])('keeps a starred span with %s, no longer one plain word', (_label, tag) => {
    expect(cleanTranscript(`Before ${tag} after.`)).toBe(`Before ${tag} after.`);
  });

  it('drops a starred word a parenthesis would keep, since the starred run needs no noise word', () => {
    expect(cleanTranscript('Please send *banana* the (banana) report.'))
      .toBe('Please send the (banana) report.');
  });

  describe('transcript that is only a one-word asterisk tag', () => {
    it.each(['*laughs*', '*music*', '*Applause*', '*x*', '  *laughs*  ', '\n*laughs*\n', '*laughs* *sighs*'])(
      'cleans %j to an empty string',
      (input) => {
        expect(cleanTranscript(input)).toBe('');
      },
    );

    it('cleans whisper JSON output holding only the tag to an empty string', () => {
      const json = JSON.stringify({ transcription: [{ text: ' *laughs*' }] });
      expect(cleanTranscript(parseWhisperOutput(json, 'ignored stdout'))).toBe('');
    });

    it('keeps a lone asterisk or unclosed tag from being treated as a tag', () => {
      expect(cleanTranscript('*laughs')).toBe('*laughs');
    });
  });

  it('removes a *laughs* segment from whisper JSON output', () => {
    const json = JSON.stringify({
      transcription: [
        { text: 'Please send the report' },
        { text: '*laughs*' },
        { text: 'to the team.' },
      ],
    });
    expect(cleanTranscript(parseWhisperOutput(json, 'ignored stdout')))
      .toBe('Please send the report to the team.');
  });

  it('removes the tag inside a whisper JSON segment that also holds speech', () => {
    const json = JSON.stringify({
      transcription: [{ text: 'Please send the report *laughs* to the team.' }],
    });
    expect(cleanTranscript(parseWhisperOutput(json, 'ignored stdout')))
      .toBe('Please send the report to the team.');
  });

  it('removes the tag from the stdout fallback', () => {
    expect(cleanTranscript(parseWhisperOutput(undefined, 'Please *laughs* continue.')))
      .toBe('Please continue.');
  });
});
