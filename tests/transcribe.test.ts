import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('voice cleaning reference', () => {
  const reference = readFileSync(new URL('../docs/voice-cleaning-reference.md', import.meta.url), 'utf8');
  const examples = [...reference.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gm)];

  it('keeps every published example in sync with the cleaner', () => {
    expect(examples.length).toBeGreaterThanOrEqual(18);
    for (const [, input, output] of examples) {
      expect(cleanTranscript(input), input).toBe(output === '""' ? '' : output);
    }
  });

  it('collapses whitespace after cleaning and leaves unmatched delimiters', () => {
    expect(cleanTranscript(' \tHello\n[MUSIC]\tthere  *unfinished ')).toBe('Hello there *unfinished');
  });
});

describe('cleanTranscript bracketed tags', () => {
  it('removes an arbitrary tag while preserving the spoken text around it', () => {
    expect(cleanTranscript('Please send [background noise] the report.')).toBe('Please send the report.');
  });

  it('separates spoken words when bracketed tags touch them', () => {
    expect(cleanTranscript('Please[door closes]send[unrecognized sound]the report.')).toBe('Please send the report.');
  });

  it('removes adjacent bracketed tags while preserving surrounding speech', () => {
    expect(cleanTranscript('Please [MUSIC][inaudible] continue speaking.')).toBe('Please continue speaking.');
  });

  it('removes several consecutive bracketed tags while preserving surrounding speech', () => {
    expect(cleanTranscript('Please [MUSIC][inaudible][static] continue speaking.')).toBe('Please continue speaking.');
    expect(cleanTranscript('Please [MUSIC] [inaudible] [laughter] continue speaking.')).toBe('Please continue speaking.');
    expect(cleanTranscript('Please[MUSIC][inaudible][static]send the report.')).toBe('Please send the report.');
    expect(cleanTranscript('[BLANK_AUDIO][MUSIC][inaudible]Only this remains. [NOISE][silence]')).toBe('Only this remains.');
    expect(cleanTranscript('[BLANK_AUDIO][MUSIC][inaudible]')).toBe('');
  });
});

describe('cleanTranscript asterisk tags', () => {
  it('removes a one-word annotation and preserves the surrounding speech', () => {
    expect(cleanTranscript('Please*whispers*send the report.')).toBe('Please send the report.');
  });

  it('removes a one-word sound tag without altering surrounding text', () => {
    expect(cleanTranscript('Ready, *cough* set, go!')).toBe('Ready, set, go!');
  });
});
