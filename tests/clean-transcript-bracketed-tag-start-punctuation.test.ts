import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. A tag directly before
// closing punctuation takes its leading space, so `send [MUSIC].` is `send.`.
// At the start of a transcript there is no leading space to take: the tag is
// dropped all the same and the punctuation stays where whisper wrote it,
// leading the cleaned text. That is docs/transcript-cleaning-scope.md's rule
// too: cleaning strips annotation shapes only, and the `. , ; : ! ?` after a
// removed tag is transcript content, not tag residue. So `[MUSIC]. send`
// cleans to `. send` - the tag is gone and every following word remains.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript bracketed tag at the start before punctuation', () => {
  it('is named by docs/CONTRACT.md as an always-dropped tag that takes its leading space before closing punctuation', () => {
    expect(bullet).toContain('`[...]` tags always');
    expect(bullet).toContain('takes its leading space');
  });

  it.each([
    ['a period', '[MUSIC]. send the report', '. send the report'],
    ['a comma', '[BLANK_AUDIO], send the report', ', send the report'],
    ['a semicolon', '[noise]; send the report', '; send the report'],
    ['a colon', '[inaudible]: send the report', ': send the report'],
    ['an exclamation mark', '[MUSIC]! send the report', '! send the report'],
    ['a question mark', '[static]? send the report', '? send the report'],
    ['an empty tag', '[]. send the report', '. send the report'],
    ['leading whitespace before the tag', '  [MUSIC]. send the report', '. send the report'],
    ['a space between tag and punctuation', '[MUSIC] . send the report', '. send the report'],
    ['punctuation glued to the first word', '[MUSIC].send the report', '.send the report'],
    ['a punctuation run', '[MUSIC]... send the report', '... send the report'],
    ['a second tag before the punctuation', '[noise][MUSIC]. send the report', '. send the report'],
  ])('removes the leading tag before %s and keeps the punctuation with the following words', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('binds the same punctuation to the preceding word mid-line, where a leading space exists to take', () => {
    expect(cleanTranscript('send [MUSIC]. the report')).toBe('send. the report');
    expect(cleanTranscript('[MUSIC]. send the report')).toBe('. send the report');
  });

  it('keeps the punctuation even when the tagged annotation was the whole transcript', () => {
    expect(cleanTranscript('[MUSIC].')).toBe('.');
    expect(cleanTranscript('  [BLANK_AUDIO] ?  ')).toBe('?');
  });

  it('keeps every following word in order behind the stranded punctuation', () => {
    const cleaned = cleanTranscript('[MUSIC], alpha beta gamma delta');
    expect(cleaned).toBe(', alpha beta gamma delta');
    expect(cleaned.endsWith('alpha beta gamma delta')).toBe(true);
  });

  it.each([
    ['Whisper JSON segments', JSON.stringify({ transcription: [
      { text: '[MUSIC].' },
      { text: 'send the report' },
    ] }), 'ignored stdout'],
    ['a tag and punctuation leading the first JSON segment', JSON.stringify({ transcription: [
      { text: '[MUSIC]. send' },
      { text: 'the report' },
    ] }), 'ignored stdout'],
    ['malformed whisper JSON', '{"transcription": [{"text":', '[MUSIC]. send the report'],
    ['stdout fallback', undefined, '  [BLANK_AUDIO]. send the report  '],
  ])('removes the leading tag and keeps the punctuation from %s', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('. send the report');
  });
});
