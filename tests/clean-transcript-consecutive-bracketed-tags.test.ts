import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// `[...]` tags always; docs/transcript-cleaning-scope.md adds that adjacent
// spans are removed independently, so two tags in a row clean like one and a
// tag touching words does not join those words.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript consecutive bracketed tags', () => {
  it('is named by docs/CONTRACT.md as an always-dropped tag', () => {
    expect(bullet).toContain('`[...]` tags always');
  });

  it.each([
    ['adjacent noise tags', 'send [MUSIC][noise] report', 'send report'],
    ['tags separated by a space', 'send [MUSIC] [noise] report', 'send report'],
    ['tags separated by a newline', 'send [MUSIC]\n[noise] report', 'send report'],
    ['tags touching both words', 'send[MUSIC][inaudible]report', 'send report'],
    ['tags touching the first word', 'send[MUSIC][noise] report', 'send report'],
    ['tags touching the second word', 'send [MUSIC][noise]report', 'send report'],
    ['an empty tag before a noise tag', 'send [][BLANK_AUDIO] report', 'send report'],
    ['an empty tag after a noise tag', 'send [MUSIC][] report', 'send report'],
    ['multi-word tags', 'send [background music][speaker 2: hello] report', 'send report'],
    ['a tag spanning a newline', 'send [one\ntwo][noise] report', 'send report'],
    ['three tags in a row', 'send [MUSIC][inaudible][static] report', 'send report'],
    ['non-ASCII tag content', 'Zoë [ruido][música] Méndez', 'Zoë Méndez'],
    ['punctuation on the surrounding words', 'send, [MUSIC][noise] report.', 'send, report.'],
  ])('removes %s between two ordinary words and preserves both', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('removes both tags and keeps the surrounding words', () => {
    const cleaned = cleanTranscript('send [MUSIC][inaudible] report');
    expect(cleaned).toBe('send report');
    expect(cleaned).not.toContain('MUSIC');
    expect(cleaned).not.toContain('inaudible');
  });

  it('leaves a single space between the surrounding words, never joining them', () => {
    const cleaned = cleanTranscript('send[MUSIC][noise]report');
    expect(cleaned).toBe('send report');
    expect(cleaned).not.toContain('sendreport');
  });

  it('cleans a run of only tags to an empty string', () => {
    expect(cleanTranscript('[MUSIC][noise]')).toBe('');
    expect(cleanTranscript(' [MUSIC] [noise] ')).toBe('');
  });

  it('preserves both surrounding words while a noisier transcript is cleaned', () => {
    expect(cleanTranscript(' send [MUSIC][noise] report (applause) *laughs* '))
      .toBe('send report');
  });

  it.each([
    ['adjacent Whisper JSON segments', JSON.stringify({ transcription: [
      { text: 'send' },
      { text: '[MUSIC]' },
      { text: '[noise]' },
      { text: 'report' },
    ] }), 'ignored stdout'],
    ['both tags in one JSON segment', JSON.stringify({ transcription: [
      { text: 'send [MUSIC][noise] report' },
    ] }), 'ignored stdout'],
    ['stdout fallback', undefined, 'send [MUSIC][noise] report'],
    ['stdout fallback with spaced tags', undefined, '  send [MUSIC] [inaudible] report  '],
  ])('removes both tags between the two words from %s', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('send report');
  });
});
