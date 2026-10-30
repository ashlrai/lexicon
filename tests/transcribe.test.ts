import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

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
});

describe('cleanTranscript asterisk tags', () => {
  it('removes a one-word annotation and preserves the surrounding speech', () => {
    expect(cleanTranscript('Please*whispers*send the report.')).toBe('Please send the report.');
  });
});
