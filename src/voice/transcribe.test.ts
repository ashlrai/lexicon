import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTranscript, parseWhisperOutput, transcribeFile } from './transcribe.js';

describe('cleanTranscript', () => {
  it.each(['[BLANK_AUDIO]', '[MUSIC]', '[speaker 2]', '[]', '[background\nnoise]'])
    ('returns no text for a transcript containing only %s', (tag) => {
      expect(cleanTranscript(tag)).toBe('');
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

  it('preserves multiline prose and spoken parentheticals while normalizing whitespace', () => {
    const prose = '  Please review the café menu (including the specials),\n\tthen send it to Zoë.  ';
    expect(cleanTranscript(prose)).toBe('Please review the café menu (including the specials), then send it to Zoë.');
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

  it('removes up to three starred words but preserves a four-word span', () => {
    expect(cleanTranscript('Please continue *door slams loudly* with the rollout.')).toBe('Please continue with the rollout.');
    expect(cleanTranscript('Please keep *these four spoken words* intact.')).toBe('Please keep *these four spoken words* intact.');
  });
});

describe('transcribeFile', () => {
  it.each(['json', 'stdout'] as const)('returns no text for a tag-only transcript from %s', async (source) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-transcribe-test-'));
    try {
      const result = await transcribeFile(path.join(dir, 'capture.wav'), {
        lexicon: { version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }] },
        whisperCli: 'whisper-cli',
        modelOptions: { globalPath: path.join(dir, 'lexicon.yaml'), env: {}, fallbackDirs: [], exists: () => true },
        tmpDir: dir,
        exec: async (_cmd, args) => {
          if (source === 'json') {
            const outBase = args[args.indexOf('-of') + 1];
            await fs.writeFile(`${outBase}.json`, JSON.stringify({ transcription: [{ text: '[Ashler]' }] }));
          }
          return { code: 0, stdout: source === 'stdout' ? '[Ashler]' : 'ignored speech', stderr: '' };
        },
      });
      expect(result.raw).toBe('');
      expect(result.output).toBe('');
      expect(result.normalized).toEqual({ input: '', output: '', replacements: [], changed: false });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
