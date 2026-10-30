import { describe, expect, it } from 'vitest';
import { cleanTranscript } from './transcribe.js';

describe('cleanTranscript', () => {
  it('removes a one-word asterisk tag while preserving surrounding speech', () => {
    expect(cleanTranscript('Please continue *whispers* with the rollout.')).toBe('Please continue with the rollout.');
  });

  it('removes up to three starred words but preserves a four-word span', () => {
    expect(cleanTranscript('Please continue *door slams loudly* with the rollout.')).toBe('Please continue with the rollout.');
    expect(cleanTranscript('Please keep *these four spoken words* intact.')).toBe('Please keep *these four spoken words* intact.');
  });
});
