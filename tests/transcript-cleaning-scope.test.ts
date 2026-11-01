import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('transcript cleaning scope documentation', () => {
  const doc = readFileSync(new URL('../docs/transcript-cleaning-scope.md', import.meta.url), 'utf8');

  it.each([
    ['Square brackets', 5],
    ['Asterisks', 9],
    ['Other cleaning', 3],
  ])('matches the cleaner for the %s examples', (section, minimum) => {
    const content = doc.split(`## ${section}\n`)[1]?.split('\n## ')[0] ?? '';
    const examples = [...content.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gm)];
    expect(examples.length).toBeGreaterThanOrEqual(minimum);
    for (const [, input, output] of examples) {
      expect(cleanTranscript(input), input).toBe(output === '""' ? '' : output);
    }
  });
});
