import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `[...]` always and `*...*` of one to three plain words always; the doc names
// `*laughs*` and `*door slams*`. Whisper mixes both kinds into one line, so a
// transcript carrying one of each must lose both and keep its spoken words.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';
const starredExamples = [...bullet.matchAll(/`\*([A-Za-z]+(?: [A-Za-z]+){0,2})\*`/g)].map((m) => m[1]);

describe('cleanTranscript mixed bracket and asterisk annotations', () => {
  it('is named by docs/CONTRACT.md as dropping both annotation kinds always', () => {
    expect(bullet).toContain('`[...]` tags always');
    expect(bullet).toContain('`*...*` of one to three plain words always');
    expect(starredExamples).toContain('laughs');
    expect(starredExamples).toContain('door slams');
  });

  it.each(starredExamples)('drops [MUSIC] and *%s* from one transcript while keeping every spoken word', (example) => {
    expect(cleanTranscript(`Please send [MUSIC] the report *${example}* today.`))
      .toBe('Please send the report today.');
  });

  it.each([
    ['the tag first and the annotation last', '[noise] Please send the report *laughs*', 'Please send the report'],
    ['the annotation first and the tag last', '*laughs* Please send the report [noise]', 'Please send the report'],
    ['the tag then the annotation between words', 'Please [MUSIC] send *door slams* the report.', 'Please send the report.'],
    ['the annotation then the tag between words', 'Please *door slams* send [MUSIC] the report.', 'Please send the report.'],
    ['the two annotations adjacent', 'Please send [MUSIC]*laughs* the report.', 'Please send the report.'],
    ['the two annotations adjacent, reversed', 'Please send *laughs*[MUSIC] the report.', 'Please send the report.'],
  ])('removes a bracketed tag and a starred annotation with %s while the spoken words stay in order', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('drops both annotations while retaining a four-word starred phrase and a spoken parenthetical', () => {
    expect(cleanTranscript('[MUSIC] Please *laughs* keep *these four spoken words* (the new build) today.'))
      .toBe('Please keep *these four spoken words* (the new build) today.');
  });

  it.each([
    ['Whisper JSON segments', JSON.stringify({ transcription: [
      { text: 'Please send [MUSIC] the report' },
      { text: '*laughs*' },
      { text: 'to the team.' },
    ] }), 'ignored stdout'],
    ['stdout fallback', undefined, 'Please send [MUSIC] the report *laughs* to the team.'],
  ])('removes both annotation kinds from %s while keeping the spoken words', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('Please send the report to the team.');
  });
});
