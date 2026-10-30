import { describe, expect, it } from 'vitest';
import { cleanTranscript } from './transcribe.js';

describe('cleanTranscript', () => {
  it('preserves ordinary prose without annotations', () => {
    const prose = "Let's review the report, then send it to the team. Does that work?";
    expect(cleanTranscript(prose)).toBe(prose);
  });

  it('removes a one-word asterisk tag while preserving surrounding speech', () => {
    expect(cleanTranscript('Please continue *whispers* with the rollout.')).toBe('Please continue with the rollout.');
  });
});
