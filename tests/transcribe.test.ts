import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('cleanTranscript bracketed tags', () => {
  it('removes an arbitrary tag while preserving the spoken text around it', () => {
    expect(cleanTranscript('Please send [background noise] the report.')).toBe('Please send the report.');
  });

  it('separates spoken words when bracketed tags touch them', () => {
    expect(cleanTranscript('Please[door closes]send[unrecognized sound]the report.')).toBe('Please send the report.');
  });
});
