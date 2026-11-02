import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `*...*` of one to three plain words always, and the doc names `*laughs*`
// and `*door slams*` as the examples.
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
    ['as the whole transcript', '*laughs*', ''],
  ])('removes *laughs* %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
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
});
