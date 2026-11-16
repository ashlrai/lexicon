import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('cleanTranscript adjacent bracketed tags', () => {
  it.each([
    ['touching both words', 'send[MUSIC]report', 'send report'],
    ['touching the preceding word', 'send[inaudible] report', 'send report'],
    ['touching the following word', 'send [BLANK_AUDIO]report', 'send report'],
    ['at the start', '[MUSIC]send the report', 'send the report'],
    ['at the end', 'send the report[MUSIC]', 'send the report'],
    ['consecutive tags', 'send[MUSIC][noise]report', 'send report'],
    ['arbitrary tag contents', 'send[speaker 2]report', 'send report'],
    ['before closing punctuation', 'send[MUSIC]. Next', 'send. Next'],
    ['with surrounding punctuation', 'send,[MUSIC]report!', 'send, report!'],
    ['with unicode words', 'café[noise]déjà vu', 'café déjà vu'],
  ])('removes a tag %s and preserves the words', (_case, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });
});
