import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `[...]` tags always; docs/transcript-cleaning-scope.md adds that a tag
// touching words does not join those words.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript bracketed tag between words', () => {
  it('is named by docs/CONTRACT.md as an always-dropped tag', () => {
    expect(bullet).toContain('`[...]` tags always');
  });

  it.each([
    ['a sound tag', 'send [MUSIC] report', 'send report'],
    ['an arbitrary tag', 'before [speaker 2: hello] after', 'before after'],
    ['a multi-word tag', 'Keep [this important phrase] please', 'Keep please'],
    ['an empty tag', 'Keep [] here', 'Keep here'],
    ['a tag touching both words', 'send[MUSIC]report', 'send report'],
    ['a tag touching the first word', 'send[MUSIC] report', 'send report'],
    ['a tag touching the second word', 'send [MUSIC]report', 'send report'],
    ['a tag spanning a newline', 'before[one\ntwo]after', 'before after'],
    ['punctuation on the surrounding words', 'send, [MUSIC] report.', 'send, report.'],
    ['non-ASCII words', 'Zoë [phone rings] Méndez', 'Zoë Méndez'],
  ])('removes %s between two ordinary words and preserves both', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('leaves a single space between the surrounding words, never joining them', () => {
    const cleaned = cleanTranscript('send[MUSIC]report');
    expect(cleaned).toBe('send report');
    expect(cleaned).not.toContain('sendreport');
  });

  it('preserves both surrounding words while a noisier transcript is cleaned', () => {
    expect(cleanTranscript(' [BLANK_AUDIO] send [MUSIC] report (applause) *laughs* '))
      .toBe('send report');
  });

  it.each([
    ['Whisper JSON segments', JSON.stringify({ transcription: [
      { text: 'send' },
      { text: '[MUSIC]' },
      { text: 'report' },
    ] }), 'ignored stdout'],
    ['stdout fallback', undefined, 'send [MUSIC] report'],
  ])('removes the tag between the two words from %s', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('send report');
  });
});
