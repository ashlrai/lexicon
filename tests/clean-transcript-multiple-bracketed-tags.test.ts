import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. cleanTranscript drops
// every complete `[...]` span always; docs/transcript-cleaning-scope.md adds
// that spans are removed independently and a tag touching words does not join
// those words. A real whisper line can carry several tags at once, spread
// across the whole utterance: each one is dropped on its own and the spoken
// words before, between and after them all remain.
const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`cleanTranscript(text)`')) ?? '';

describe('cleanTranscript multiple bracketed tags', () => {
  it('is named by docs/CONTRACT.md as an always-dropped tag', () => {
    expect(bullet).toContain('`[...]` tags always');
  });

  it.each([
    ['a tag between every word', 'One [MUSIC] two [noise] three [static] four', 'One two three four'],
    ['tags at the start, middle and end', '[BLANK_AUDIO] send [MUSIC] the report [noise]', 'send the report'],
    ['the same tag repeated', '[noise] please [noise] send [noise] it', 'please send it'],
    ['tag bodies matching spoken words', '[open] open the [close] door [shut] now', 'open the door now'],
    ['tags touching the words around them', 'Please[MUSIC]send[noise]the[static]report', 'Please send the report'],
    ['empty tags among sound tags', 'Keep [] these [MUSIC] words [] here [noise]', 'Keep these words here'],
    ['a tag per sentence', 'First draft done. [speaker 2] Second draft sent. [applause] Third draft shipped.', 'First draft done. Second draft sent. Third draft shipped.'],
    ['speaker-label tags on separate lines', '[speaker 1]\nFirst part.\n[speaker 2]\nSecond part.\n[speaker 1]\nThird part.', 'First part. Second part. Third part.'],
    ['adjacent and separated tags together', '[MUSIC][noise] send [static] the report[inaudible][beep]', 'send the report'],
    ['non-ASCII tags and speech', 'Zoë [música] sends [ruido] the café menu [teléfono] now', 'Zoë sends the café menu now'],
    ['a tag body holding punctuation', 'send [beep!] the [noise: 50%] report', 'send the report'],
    ['an unmatched bracket surviving among the tags', 'One [noise] two [music] three [unfinished', 'One two three [unfinished'],
    ['a nested-looking span among the tags', 'A [outer [inner] B [tail] C', 'A B C'],
    ['punctuation on the spoken words', 'Send it, [door closes] then leave. [phone rings] Really.', 'Send it, then leave. Really.'],
  ])('removes every tag with %s while the spoken words remain', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['a sound tag', 'MUSIC'],
    ['a blank-audio tag', 'BLANK_AUDIO'],
    ['a lowercase tag', 'inaudible'],
    ['a multi-word tag', 'door closes loudly'],
    ['a speaker label', 'speaker 2'],
    ['punctuation and digits', 'noise: 50%'],
    ['an empty tag', ''],
  ])('removes %s between two other tags while the spoken words remain', (_label, body) => {
    expect(cleanTranscript(`send [static] the [${body}] report [beep] today`)).toBe('send the report today');
  });

  it('removes each of the tag bodies and leaves no brackets behind', () => {
    const cleaned = cleanTranscript('[MUSIC] alpha [door closes] beta [speaker 2] gamma [inaudible] delta');
    expect(cleaned).toBe('alpha beta gamma delta');
    for (const body of ['MUSIC', 'door closes', 'speaker 2', 'inaudible']) {
      expect(cleaned).not.toContain(body);
    }
    expect(cleaned).not.toMatch(/[[\]]/);
  });

  it('keeps the spoken words between the tags in their original order', () => {
    const cleaned = cleanTranscript('first [a] second [b] third [c] fourth [d] fifth');
    expect(cleaned).toBe('first second third fourth fifth');
    const positions = ['first', 'second', 'third', 'fourth', 'fifth'].map((word) => cleaned.indexOf(word));
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
  });

  it('returns an empty string when several tags are the whole transcript', () => {
    expect(cleanTranscript('[MUSIC] [noise] [static]')).toBe('');
    expect(cleanTranscript(' [one]\n[two] \t [three] ')).toBe('');
  });

  it('keeps a spoken parenthetical and a four-word starred span among the tags', () => {
    expect(cleanTranscript('[MUSIC] Keep *these four spoken words* and (the new build) [noise] safe. [static]'))
      .toBe('Keep *these four spoken words* and (the new build) safe.');
  });

  it.each([
    ['a tag in every other JSON segment', JSON.stringify({ transcription: [
      { text: '[MUSIC]' },
      { text: 'send' },
      { text: '[noise]' },
      { text: 'the report' },
      { text: '[static]' },
    ] }), 'ignored stdout'],
    ['several tags inside one JSON segment', JSON.stringify({ transcription: [
      { text: 'send [MUSIC] the [noise] report [static]' },
    ] }), 'ignored stdout'],
    ['stdout fallback', undefined, '[MUSIC] send [noise] the report [static]'],
    ['stdout fallback with spaced tags', undefined, '  send  [MUSIC]  the  [noise]  report  '],
  ])('removes every tag from %s while the spoken words remain', (_source, json, stdout) => {
    expect(cleanTranscript(parseWhisperOutput(json, stdout))).toBe('send the report');
  });
});
