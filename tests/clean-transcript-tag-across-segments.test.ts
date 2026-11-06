import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Regression: whisper can split one bracketed tag across two JSON segments.
// parseWhisperOutput joins segments with a space, so the tag arrives as
// `[BLANK_ AUDIO]` and cleanTranscript must still drop it whole while the
// spoken words on both sides stay in order.
const json = (...segments: string[]) => JSON.stringify({ transcription: segments.map((text) => ({ text })) });

describe('cleanTranscript bracketed tag split across segments', () => {
  it.each([
    ['a tag split mid-word', json(' send [BLANK_', 'AUDIO] report'), 'send report'],
    ['a tag split between words', json(' one two [background', 'music] three four'), 'one two three four'],
    ['a tag at the start', json('[MUS', 'IC] send the report'), 'send the report'],
    ['a tag at the end before punctuation', json('send the report [MUS', 'IC].'), 'send the report.'],
  ])('removes %s and keeps the spoken words in order', (_label, input, expected) => {
    expect(cleanTranscript(parseWhisperOutput(input, 'ignored stdout'))).toBe(expected);
  });
});
