import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. The documented rule
// is that `cleanTranscript` drops starred runs of one to three plain words.
// A four-word starred span exceeds that boundary and must be preserved as
// dictated emphasis or content.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('transcribe asterisks: annotations', () => {
  it.each([
    ['one word', 'Please *laughs* continue speaking.', 'Please continue speaking.'],
    ['three words', 'Please *door slams loudly* continue speaking.', 'Please continue speaking.'],
  ])('removes a %s annotation and retains surrounding speech', (_length, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });
});

describe('transcribe asterisks: four-word span', () => {
  it('documents the one-to-three-word rule in docs/CONTRACT.md', () => {
    expect(bullet).toContain('`*...*` of one to three plain words always');
  });

  it('preserves a four-word asterisk span in the middle of a sentence', () => {
    expect(cleanTranscript('Please *keep these four words* in the report.')).toBe(
      'Please *keep these four words* in the report.',
    );
  });

  it('preserves a four-word asterisk span at the start of a transcript', () => {
    expect(cleanTranscript('*keep these four words* then continue.')).toBe(
      '*keep these four words* then continue.',
    );
  });

  it('preserves a four-word asterisk span at the end of a transcript', () => {
    expect(cleanTranscript('Continue then *keep these four words*')).toBe(
      'Continue then *keep these four words*',
    );
  });

  it('preserves a four-word asterisk span that is the entire transcript', () => {
    expect(cleanTranscript('*keep these four words*')).toBe('*keep these four words*');
  });

  it('preserves the four-word span while still dropping a one-word tag beside it', () => {
    expect(cleanTranscript('Hello *laughs* and *keep these four words* now.')).toBe(
      'Hello and *keep these four words* now.',
    );
  });

  it('preserves the four-word span through whisper JSON output', () => {
    const json = JSON.stringify({
      transcription: [
        { text: 'Please send' },
        { text: '*keep these four words*' },
        { text: 'today.' },
      ],
    });
    expect(cleanTranscript(parseWhisperOutput(json, 'ignored stdout'))).toBe(
      'Please send *keep these four words* today.',
    );
  });

  it('preserves a five-word asterisk span as well, since it also exceeds three', () => {
    expect(cleanTranscript('Say *all five of these words* clearly.')).toBe(
      'Say *all five of these words* clearly.',
    );
  });
});
