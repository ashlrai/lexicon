import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('documented transcript tag examples', () => {
  const doc = readFileSync(new URL('../docs/transcript-tag-examples.md', import.meta.url), 'utf8');
  const block = /```json\n([\s\S]*?)\n```/.exec(doc);
  const examples = JSON.parse(block?.[1] ?? 'null') as Array<{ input: string; cleaned: string }> | null;

  it('includes examples of removed and preserved bracketed and starred text', () => {
    expect(examples).toEqual(expect.arrayContaining([
      { input: '[BLANK_AUDIO]', cleaned: '' },
      { input: 'Hello [unfinished thought', cleaned: 'Hello [unfinished thought' },
      { input: 'This is *important* today', cleaned: 'This is today' },
      { input: 'Keep *the door slams loudly* here', cleaned: 'Keep *the door slams loudly* here' },
    ]));
  });

  it('matches cleanTranscript for every published example', () => {
    expect(examples).not.toBeNull();
    for (const { input, cleaned } of examples ?? []) {
      expect(cleanTranscript(input), input).toBe(cleaned);
    }
  });
});
