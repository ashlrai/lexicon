import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('cleanTranscript bracketed tags', () => {
  it('removes an arbitrary tag while preserving the spoken text around it', () => {
    expect(cleanTranscript('Please send [background noise] the report.')).toBe('Please send the report.');
  });
});
