import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. `[...]` tags are dropped
// always, and an empty `[]` is one too; the words around it survive.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript empty bracketed tag', () => {
  it('is covered by the contract wording for always-dropped tags', () => {
    expect(bullet).toContain('`[...]` tags always');
  });

  it.each([
    ['between spaced words', 'Keep [] here', 'Keep here'],
    ['touching both words', 'Keep[]here', 'Keep here'],
    ['at the start', '[] Keep here', 'Keep here'],
    ['at the end', 'Keep here []', 'Keep here'],
    ['before closing punctuation', 'Keep here [].', 'Keep here.'],
    ['repeated', 'Keep [][] [] here', 'Keep here'],
    ['mixed with a named tag', 'Keep [] [MUSIC] here', 'Keep here'],
    ['alone', '[]', ''],
    ['with inner whitespace', 'Keep [ ] here', 'Keep here'],
  ])('removes an empty tag %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('cleans an empty tag split across whisper segments', () => {
    const json = JSON.stringify({ transcription: [{ text: ' send [' }, { text: '] report' }] });
    expect(cleanTranscript(parseWhisperOutput(json, ''))).toBe('send report');
  });
});
