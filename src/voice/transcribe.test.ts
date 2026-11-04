import { describe, expect, it } from 'vitest';
import { cleanTranscript, parseWhisperOutput } from './transcribe.js';

describe('cleanTranscript', () => {
  it('returns an empty string for empty input after cleaning a transcript', () => {
    expect(cleanTranscript('Hello [noise] world')).toBe('Hello world');
    expect(cleanTranscript('')).toBe('');
  });

  it('removes a bracketed annotation containing spaces and keeps the surrounding words', () => {
    expect(cleanTranscript('Please [background music playing] send the report')).toBe('Please send the report');
    expect(cleanTranscript('[ Pause in speech ] Ship it today')).toBe('Ship it today');
    expect(cleanTranscript('Ship it today [door closes loudly]')).toBe('Ship it today');
  });

  it('removes a one-word asterisk tag and keeps the surrounding words', () => {
    expect(cleanTranscript('Ship *laughs* it today')).toBe('Ship it today');
    expect(cleanTranscript('Ship it *laughs*')).toBe('Ship it');
    expect(cleanTranscript('*laughs* Ship it')).toBe('Ship it');
    expect(cleanTranscript('Ship it, *laughs* then deploy.')).toBe('Ship it, then deploy.');
  });

  describe('a bracketed tag at the beginning of the text', () => {
    it.each([
      ['a whisper tag', '[BLANK_AUDIO] Please send the report', 'Please send the report'],
      ['a tag glued to the next word', '[MUSIC]Please send the report', 'Please send the report'],
      ['a tag with inner spaces', '[ Pause in speech ] Ship it today', 'Ship it today'],
      ['a tag followed by a line break', '[speaker 1]\nSend it to Ashlr.AI today', 'Send it to Ashlr.AI today'],
      ['a tag whose words repeat later', '[inaudible] inaudible words stay', 'inaudible words stay'],
      ['a following parenthetical', '[MUSIC] Send it (the draft) now', 'Send it (the draft) now'],
    ])('removes the tag and keeps every following word: %s', (_description, input, expected) => {
      expect(cleanTranscript(input)).toBe(expected);
    });

    it('removes consecutive leading tags', () => {
      expect(cleanTranscript('[MUSIC] [BLANK_AUDIO] Ship it')).toBe('Ship it');
    });

    it('returns an empty string when the tag is the whole text', () => {
      expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    });
  });

  it.each([
    ['empty input', ''],
    ['spaces', '   '],
    ['tabs and line breaks', '\t\r\n\n'],
    ['mixed Unicode whitespace', ' \u00a0\u2003\u2028\u2029\ufeff\t'],
    ['noise annotations and whitespace', ' \t[BLANK_AUDIO]\n(soft music) *laughs*  '],
  ])('returns an empty string for %s', (_description, input) => {
    expect(cleanTranscript(input)).toBe('');
  });

  it.each([
    ['empty stdout', undefined, ''],
    ['invalid JSON and empty stdout', '{', ''],
    ['an empty transcription', '{"transcription":[]}', 'ignored stdout'],
    ['an empty segment', '{"transcription":[{"text":""}]}', 'ignored stdout'],
    ['a segment without text', '{"transcription":[{}]}', 'ignored stdout'],
  ])('cleans empty Whisper output from %s', (_description, json, stdout) => {
    const transcript = parseWhisperOutput(json, stdout);
    expect(transcript).toBe('');
    expect(cleanTranscript(transcript)).toBe('');
  });

  it('preserves ordinary prose without annotations', () => {
    const prose = "Let's review the report, then send it to the team. Does that work?";
    expect(cleanTranscript(prose)).toBe(prose);
  });

  it('preserves an unmatched asterisk alongside ordinary text', () => {
    expect(cleanTranscript('Please review the *draft today')).toBe('Please review the *draft today');
    expect(cleanTranscript('Note * this stays')).toBe('Note * this stays');
  });

  it('preserves multiline prose and spoken parentheticals while normalizing whitespace', () => {
    const prose = '  Please review the café menu (including the specials),\n\tthen send it to Zoë.  ';
    expect(cleanTranscript(prose)).toBe('Please review the café menu (including the specials), then send it to Zoë.');
  });

  it.each([
    'Please send the report to the team.',
    'The rollout finished at 3 pm and nobody noticed.',
    'Did Zoë already ship the café menu?',
    "Let's ping Ashlr.AI about Friday's deploy, then go home.",
  ])('leaves the ordinary sentence without annotations unchanged: %s', (sentence) => {
    expect(cleanTranscript(sentence)).toBe(sentence);
  });

  it.each([
    ['a noise tag', '[BLANK_AUDIO] Please send the report.', 'Please send the report.'],
    ['a tag touching speech', '[MUSIC]Please send the report.', 'Please send the report.'],
    ['an arbitrary tag and leading whitespace', '  [speaker 1]\nPlease send the report.', 'Please send the report.'],
    ['adjacent tags', '[noise][inaudible] Please send the report.', 'Please send the report.'],
    ['a multiline tag', '[background\nnoise] Please send the report.', 'Please send the report.'],
  ])('removes %s at the start while preserving spoken text', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['a newline', 'Please [background\nnoise] continue.', 'Please continue.'],
    ['a CRLF', 'Please[background\r\nnoise]continue.', 'Please continue.'],
    ['several lines', 'Before[one\ntwo\nthree]after.', 'Before after.'],
    ['multiple tags', 'Keep[first\ntag]these[second\ntag]words.', 'Keep these words.'],
  ])('removes a bracketed tag spanning %s and preserves surrounding words', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['spaced speech', 'Please [MUSIC][APPLAUSE] continue.', 'Please continue.'],
    ['unspaced speech', 'Before[noise][inaudible]after.', 'Before after.'],
    ['multiline tags', 'Keep[first\ntag][second\r\ntag]speaking.', 'Keep speaking.'],
  ])('removes adjacent bracketed tags and retains %s', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['several words each side', 'Please review and send[noise][MUSIC]the report to the team.', 'Please review and send the report to the team.'],
    ['a space between the tags', 'Please review and send [noise] [inaudible] the report.', 'Please review and send the report.'],
    ['tags ending the transcript', 'Please send the report to the team.[noise][inaudible]', 'Please send the report to the team.'],
    ['two adjacent pairs', 'Draft[noise][MUSIC]the memo[static][beep]before noon.', 'Draft the memo before noon.'],
  ])('removes adjacent bracketed tags with %s while the spoken words stay in order', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['at the start and the end', '[MUSIC]Please send the report.[noise]', 'Please send the report.'],
    ['with speech between them', 'Please [MUSIC] send the report [inaudible] today.', 'Please send the report today.'],
    ['touching different spoken words', 'Please[MUSIC]send the report[inaudible]today.', 'Please send the report today.'],
    ['on separate lines like speaker labels', '[speaker 1]\nFirst part.\n[speaker 2]\nSecond part.', 'First part. Second part.'],
  ])('removes two separated bracketed tags %s while the surrounding spoken words remain', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['a spaced tag after a comma', 'First draft done, [speaker 2] then we ship.', 'First draft done, then we ship.'],
    ['a tag touching the comma', 'First draft done,[speaker 2] then we ship.', 'First draft done, then we ship.'],
    ['non-ASCII words around the tag', 'Zoë, please [phone rings] send the café menu.', 'Zoë, please send the café menu.'],
    ['a sentence boundary on each side', 'Send it. [door closes] Then leave.', 'Send it. Then leave.'],
  ])('removes a bracketed tag from mixed text with %s while preserving the surrounding words', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it.each([
    ['an unmatched opening bracket', 'Please keep [unfinished speech.', 'Please keep [unfinished speech.'],
    ['an unmatched closing bracket', 'Please keep unfinished] speech.', 'Please keep unfinished] speech.'],
    ['an opening bracket after a complete tag', '  Please [noise] continue [unfinished\nthought  ', 'Please continue [unfinished thought'],
    ['a closing bracket before a complete tag', '  Please unfinished] [noise] continue\nnow  ', 'Please unfinished] continue now'],
  ])('preserves %s', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('removes a one-word asterisk tag while preserving surrounding speech', () => {
    expect(cleanTranscript('Please continue *whispers* with the rollout.')).toBe('Please continue with the rollout.');
  });

  it.each([
    ['at the start', '*door slams loudly* Please send the report.', 'Please send the report.'],
    ['at the end', 'Please send the report. *door slams loudly*', 'Please send the report.'],
    ['touching speech', 'Please*door slams loudly*send the report.', 'Please send the report.'],
    ['across a line break', 'Please *door\nslams loudly* send the report.', 'Please send the report.'],
    ['with extra inner spaces', 'Please *door   slams  loudly* send it.', 'Please send it.'],
    ['uppercase', 'Please *DOOR SLAMS LOUDLY* send it.', 'Please send it.'],
    ['between punctuated prose', 'Zoë asked, *heavy rain falling* "Is the café open?"', 'Zoë asked, "Is the café open?"'],
    ['twice in a row', 'Ship *one two three* *four five six* today.', 'Ship today.'],
    ['between tags of other kinds', 'Ship [noise] *a b c* (soft music) today.', 'Ship today.'],
  ])('removes a three-word asterisk tag %s and keeps the spoken words', (_description, input, expected) => {
    expect(cleanTranscript(input)).toBe(expected);
  });

  it('removes up to three starred words but preserves a four-word span', () => {
    expect(cleanTranscript('Please continue *door slams loudly* with the rollout.')).toBe('Please continue with the rollout.');
    expect(cleanTranscript('Please keep *these four spoken words* intact.')).toBe('Please keep *these four spoken words* intact.');
  });
});
