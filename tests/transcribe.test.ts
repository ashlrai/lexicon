import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

// The documented cleaning examples are checked against cleanTranscript in
// tests/transcript-cleaning-scope.test.ts (docs/transcript-cleaning-scope.md).

describe('cleanTranscript whitespace', () => {
  it('collapses whitespace after cleaning and leaves unmatched delimiters', () => {
    expect(cleanTranscript(' \tHello\n[MUSIC]\tthere  *unfinished ')).toBe('Hello there *unfinished');
  });
});

describe('cleanTranscript bracketed tags', () => {
  // docs/CONTRACT.md: bracketed tags are always dropped, and whitespace is trimmed.
  it.each([
    ['separated by whitespace', 'Please send the report. [MUSIC]', 'Please send the report.'],
    ['adjacent to speech', 'Keep the café open![speaker 2]', 'Keep the café open!'],
    ['followed by whitespace', 'Call Zoë, please.\n[inaudible] \t', 'Call Zoë, please.'],
  ])('removes a trailing bracketed tag %s and preserves the spoken text', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

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

  it('removes a single tag between two words and keeps both words', () => {
    expect(cleanTranscript('hello [MUSIC] world')).toBe('hello world');
    expect(cleanTranscript('hello [MUSIC]\nworld')).toBe('hello world');
    expect(cleanTranscript('hello[MUSIC]world')).toBe('hello world');
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

  it.each([
    ['speech between tags', 'Before [MUSIC] keep these words [noise] after.', 'Before keep these words after.'],
    ['tags throughout a transcript', '[MUSIC]First [noise] second [inaudible] third[static]', 'First second third'],
    ['punctuation and non-ASCII speech', 'Zoë says, [door closes] "Café is open!" [noise] Go.', 'Zoë says, "Café is open!" Go.'],
    ['mixed whitespace and arbitrary tag contents', 'One\n[speaker 2]\ttwo [noise: 50%]\nthree', 'One two three'],
    ['an unmatched opening bracket after tags', 'One [noise] two [music] three [unfinished', 'One two three [unfinished'],
  ])('removes multiple bracketed tags with %s', (_label, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });
});

describe('cleanTranscript asterisk tags', () => {
  it.each(['laughs', 'door slams', 'door slams shut'])('removes *%s* at each position without losing speech', (direction) => {
    expect(cleanTranscript(`*${direction}* Please send the report.`)).toBe('Please send the report.');
    expect(cleanTranscript(`Please send *${direction}* the report.`)).toBe('Please send the report.');
    expect(cleanTranscript(`Please send the report. *${direction}*`)).toBe('Please send the report.');
    expect(cleanTranscript(`Please*${direction}*send the report.`)).toBe('Please send the report.');
    expect(cleanTranscript(`*${direction}*`)).toBe('');
  });

  it.each([
    ['one', 'Zoë said, *laughs* "send it!"', 'Zoë said, "send it!"'],
    ['two', 'Keep the café open; *door slams* notify the team.', 'Keep the café open; notify the team.'],
    ['three', 'Version 2 is ready: *door slams loudly* ship it, please.', 'Version 2 is ready: ship it, please.'],
  ])('removes a %s-word annotation and preserves the surrounding text', (_length, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['between speech', 'Zoë said, *the door closes softly* "send it!"', 'Zoë said, *the door closes softly* "send it!"'],
    ['at the beginning', '*the door closes softly* Please continue.', '*the door closes softly* Please continue.'],
    ['at the end', 'Please continue. *the door closes softly*', 'Please continue. *the door closes softly*'],
    ['as the entire transcript', '*the door closes softly*', '*the door closes softly*'],
    ['with mixed whitespace', '  Before\n*the\tdoor  closes\nsoftly*\tafter.  ', 'Before *the door closes softly* after.'],
  ])('retains a four-word annotation %s', (_position, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('removes one-, two-, and three-word annotations in the same transcript', () => {
    expect(cleanTranscript('First *laughs* then *door slams* and *door slams loudly* finally done.'))
      .toBe('First then and finally done.');
  });

  it('retains a four-word annotation next to removed one- and three-word ones', () => {
    expect(cleanTranscript('A *laughs* B *the door closes softly* C *door slams loudly* D.'))
      .toBe('A B *the door closes softly* C D.');
  });

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

  it.each([
    ['leading quote', 'laughs', '"laughs'],
    ['trailing period', 'laughs', 'laughs.'],
    ['embedded apostrophe', 'laughs', "laugh's"],
    ['comma between two words', 'door slams', 'door, slams'],
    ['hyphen between two words', 'door slams', 'door-slams'],
    ['punctuation after two words', 'door slams', 'door slams!'],
    ['colon between three words', 'door slams loudly', 'door: slams loudly'],
    ['Unicode apostrophe in three words', 'door slams loudly', 'door’s slams loudly'],
    ['punctuation after three words', 'door slams loudly', 'door slams loudly?'],
  ])('preserves %s inside asterisks while removing its plain-word counterpart', (_label, plain, punctuated) => {
    const input = `Before *${plain}* between *${punctuated}* after.`;
    expect(cleanTranscript(input)).toBe(`Before between *${punctuated}* after.`);
  });

  it.each([
    ['digits alone', '*123*'],
    ['leading digit', '*2beeps*'],
    ['embedded digit', '*be2eps*'],
    ['trailing digit', '*beeps2*'],
    ['first of two words', '*2 beeps*'],
    ['second of two words', '*room 2*'],
    ['middle of three words', '*door 2 slams*'],
    ['digit attached in three words', '*door slams2 loudly*'],
  ])('retains an annotation with %s because it is not all plain words', (_label, annotation) => {
    expect(cleanTranscript(`Before ${annotation} after.`)).toBe(`Before ${annotation} after.`);
  });

  it('removes letter-only annotations while retaining a digit-bearing annotation', () => {
    expect(cleanTranscript('Before *laughs* then *room 2* and *door slams* after.'))
      .toBe('Before then *room 2* and after.');
  });

  it('applies bracket cleaning before matching asterisks across newlines', () => {
    expect(cleanTranscript('Before *hello [noise]\nworld* after.')).toBe('Before after.');
    expect(cleanTranscript('Keep *laughs**coughs* and *one*two* here.')).toBe('Keep and two* here.');
  });
});

describe('cleanTranscript asterisk-only transcripts', () => {
  it('returns an empty string when the transcript is only a three-word asterisk tag', () => {
    expect(cleanTranscript('*door slams shut*')).toBe('');
    expect(cleanTranscript('  *door slams shut*\n')).toBe('');
  });
});
