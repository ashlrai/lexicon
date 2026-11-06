import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// only `[...]` tags, `*...*` of one to three plain words and noise `(...)`,
// then collapses whitespace and trims. Ordinary transcript text - dictated
// words carrying no annotation marker - has nothing to drop, so it must come
// through unchanged.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript ordinary text', () => {
  it('drops only the annotation forms docs/CONTRACT.md names, never ordinary text', () => {
    expect(bullet).toContain('`cleanTranscript(text)`');
    expect(bullet).toContain('`[...]` tags always');
    expect(bullet).toContain('`*...*` of one to three plain words always');
    expect(bullet).toContain('`(...)` only when');
    expect(bullet).toContain('collapses whitespace, trims');
  });

  it.each([
    ['a plain statement', 'Please send the report to the team.'],
    ['a question', 'Did Zoë already ship the café menu?'],
    ['an exclamation', 'Ship it tonight!'],
    ['quoted speech', 'Mason said "ship it" and left.'],
    ['commas, a semicolon and a colon', 'First draft: review, revise; then send it, please.'],
    ['contractions and a possessive', "Let's ping Mason's team about Friday's deploy."],
    ['numbers, a time and decimals', 'Version 2.5 shipped at 3:45 pm with 0 errors.'],
    ['currency and a percent', 'The invoice is $1,250.75, up 3% from last month.'],
    ['a hyphenated word and a date', 'The post-mortem is 2026-11-03, not 10/11.'],
    ['a URL and an email address', 'See https://example.com/path?q=1 or mail zoe@example.com.'],
    ['non-ASCII names', 'Zoë met José at the café in Créteil.'],
    ['an emoji', 'Ship it 🚀 tonight.'],
    ['a multi-sentence paragraph', 'First we ship. Then we tell the team. After that, we rest.'],
    ['spaced math asterisks', 'The total is 2 * 3 * 4, not 24.'],
    ['a lone asterisk', 'The rate is a * b, times c.'],
    ['a spoken parenthetical', 'Please review (the new build) today.'],
    ['a spoken parenthetical mid sentence', 'The talk (version two) ran long.'],
    ['a parenthetical holding a digit', 'Call +1 (555) 010-2030, or meet at 5 (not 6) pm.'],
  ])('preserves %s verbatim', (_label, sentence) => {
    expect(cleanTranscript(sentence)).toBe(sentence);
  });

  it.each([
    '  Please   review\nthe \tcafé   menu.  ',
    'First we ship.\nThen we tell the team.\tAfter that, we rest.',
    '\tOne  two three ',
  ])('changes only whitespace in tag-free text: %j', (input) => {
    const cleaned = cleanTranscript(input);
    expect(cleaned).toBe(input.replace(/\s+/g, ' ').trim());
    expect(cleaned.replace(/\s/g, '')).toBe(input.replace(/\s/g, ''));
  });

  it.each([
    ['Whisper JSON segments', JSON.stringify({ transcription: [
      { text: 'Please send the report' },
      { text: 'to the team,' },
      { text: 'then go home.' },
    ] }), 'ignored stdout', 'Please send the report to the team, then go home.'],
    ['a stdout fallback', undefined, 'Did Zoë already ship the café menu?', 'Did Zoë already ship the café menu?'],
    ['stdout with a trailing newline', undefined, 'Ship it tonight!\n', 'Ship it tonight!'],
  ])('preserves ordinary text from %s', (_source, json, stdout, expected) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe(expected);
  });

  it('returns identical text when its own cleaned output is cleaned again', () => {
    const sentence = 'Did Zoë already ship the café menu at 3:45 pm?';
    expect(cleanTranscript(cleanTranscript(sentence))).toBe(sentence);
  });

  it('still removes a real annotation added to the same ordinary text', () => {
    expect(cleanTranscript('Please send the report to the team. [MUSIC]'))
      .toBe('Please send the report to the team.');
    expect(cleanTranscript('Did Zoë *laughs* already ship the café menu?'))
      .toBe('Did Zoë already ship the café menu?');
    expect(cleanTranscript('Ship it (soft music) tonight!'))
      .toBe('Ship it tonight!');
  });
});
