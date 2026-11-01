import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cleanTranscript } from '../src/voice/transcribe.js';

describe('voice cleaning reference', () => {
  const reference = readFileSync(new URL('../docs/voice-cleaning-reference.md', import.meta.url), 'utf8');
  const examples = [...reference.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gm)];

  it('keeps every published example in sync with the cleaner', () => {
    expect(examples.length).toBeGreaterThanOrEqual(18);
    for (const [, input, output] of examples) {
      expect(cleanTranscript(input), input).toBe(output === '""' ? '' : output);
    }
  });

  it('collapses whitespace after cleaning and leaves unmatched delimiters', () => {
    expect(cleanTranscript(' \tHello\n[MUSIC]\tthere  *unfinished ')).toBe('Hello there *unfinished');
  });
});

describe('transcript cleaning examples', () => {
  const document = readFileSync(new URL('../docs/transcript-cleaning-examples.md', import.meta.url), 'utf8');

  it.each([
    ['Square brackets', 7],
    ['Asterisks', 9],
  ])('keeps the %s examples in sync with the cleaner', (section, minimum) => {
    const content = document.split(`## ${section}\n`)[1]?.split('\n## ')[0] ?? '';
    const examples = [...content.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gm)];
    expect(examples.length).toBeGreaterThanOrEqual(minimum);
    for (const [, input, output] of examples) {
      expect(cleanTranscript(input), input).toBe(output === '""' ? '' : output);
    }
  });

  it('documents interactions between sequential and adjacent matches', () => {
    for (const row of [
      '| `Keep *laughs**coughs* here.` | `Keep here.` |',
      '| `Keep *one*two* here.` | `Keep two* here.` |',
      '| `Before *hello [noise] world* after.` | `Before after.` |',
    ]) {
      expect(document).toContain(row);
    }
  });
});

describe('cleanTranscript bracketed tags', () => {
  it.each([
    ['beginning', '[MUSIC]Hello there.', 'Hello there.'],
    ['middle', 'Hello[background noise]there.', 'Hello there.'],
    ['end', 'Hello there.[inaudible]', 'Hello there.'],
    ['consecutive tags at the beginning', '[MUSIC][noise]Hello.', 'Hello.'],
    ['consecutive tags in the middle', 'Hello[MUSIC][noise]there.', 'Hello there.'],
    ['consecutive tags at the end', 'Hello.[MUSIC][noise]', 'Hello.'],
    ['an empty tag between words', 'Hello[]there.', 'Hello there.'],
  ])('removes tags adjacent to text at the %s', (_position, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('removes an arbitrary tag while preserving the spoken text around it', () => {
    expect(cleanTranscript('Please send [background noise] the report.')).toBe('Please send the report.');
  });

  it('separates spoken words when bracketed tags touch them', () => {
    expect(cleanTranscript('Please[door closes]send[unrecognized sound]the report.')).toBe('Please send the report.');
  });

  it('removes adjacent bracketed tags while preserving surrounding speech', () => {
    expect(cleanTranscript('Please [MUSIC][inaudible] continue speaking.')).toBe('Please continue speaking.');
  });

  it('removes several consecutive bracketed tags while preserving surrounding speech', () => {
    expect(cleanTranscript('Please [MUSIC][inaudible][static] continue speaking.')).toBe('Please continue speaking.');
    expect(cleanTranscript('Please [MUSIC] [inaudible] [laughter] continue speaking.')).toBe('Please continue speaking.');
    expect(cleanTranscript('Please[MUSIC][inaudible][static]send the report.')).toBe('Please send the report.');
    expect(cleanTranscript('[BLANK_AUDIO][MUSIC][inaudible]Only this remains. [NOISE][silence]')).toBe('Only this remains.');
    expect(cleanTranscript('[BLANK_AUDIO][MUSIC][inaudible]')).toBe('');
  });
});

describe('cleanTranscript asterisk tags', () => {
  it('removes a one-word annotation and preserves the surrounding speech', () => {
    expect(cleanTranscript('Please*whispers*send the report.')).toBe('Please send the report.');
  });

  it('removes a one-word sound tag without altering surrounding text', () => {
    expect(cleanTranscript('Ready, *cough* set, go!')).toBe('Ready, set, go!');
  });

  it('accepts whitespace between words but not digits or whitespace at the edges', () => {
    expect(cleanTranscript('Before *door\nslams* after')).toBe('Before after');
    expect(cleanTranscript('Before *room 2* and * cough * after')).toBe('Before *room 2* and * cough * after');
  });

  it('applies bracket cleaning before matching asterisks across newlines', () => {
    expect(cleanTranscript('Before *hello [noise]\nworld* after.')).toBe('Before after.');
    expect(cleanTranscript('Keep *laughs**coughs* and *one*two* here.')).toBe('Keep and two* here.');
  });
});
