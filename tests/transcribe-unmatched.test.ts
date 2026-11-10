import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('cleanTranscript with unmatched delimiters', () => {
  it.each([
    ['opening bracket', '[unfinished send the report', '[unfinished send the report'],
    ['closing bracket', 'send the report unfinished]', 'send the report unfinished]'],
    ['asterisk before speech', '*unfinished send the report', '*unfinished send the report'],
    ['asterisk after speech', 'send the report unfinished*', 'send the report unfinished*'],
    ['opening bracket after a tag', 'Please [noise] send [unfinished report today.', 'Please send [unfinished report today.'],
    ['closing bracket after a tag', 'Please [noise] send the report] today.', 'Please send the report] today.'],
    ['asterisk after a tag', 'Please *laughs* send the *unfinished report today.', 'Please send the *unfinished report today.'],
  ])('preserves speech around an unmatched %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });
});
