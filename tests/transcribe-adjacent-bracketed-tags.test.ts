import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lexicon } from '../src/core/index.js';
import type { ExecResult, VoiceExec } from '../src/voice/process.js';
import { transcribeFile } from '../src/voice/transcribe.js';

// Regression: bracketed tags with no whitespace between them
// (`send [MUSIC][inaudible] report`, `send[MUSIC][noise]report`) are each
// removed by transcribeFile and the spoken words around them survive, with
// the lexicon still applied. cleanTranscript alone is covered in
// tests/clean-transcript-consecutive-bracketed-tags.test.ts; this goes
// through the whole stage: whisper JSON or stdout -> cleanTranscript ->
// normalize. The no-whitespace adjacency must sit inside one JSON segment
// or in the stdout fallback: parseWhisperOutput joins segments with a
// space, so one tag per segment lands as the spaced case.
const LEXICON: Lexicon = {
  version: 1,
  terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }],
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function transcribe(whisper: { segments?: string[]; stdout?: string }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-transcribe-adjacent-'));
  dirs.push(dir);
  const wav = path.join(dir, 'capture.wav');
  await fs.writeFile(wav, Buffer.alloc(44 + 32_000));
  const exec: VoiceExec = async (_cmd, args): Promise<ExecResult> => {
    if (whisper.segments !== undefined) {
      const of = args[args.indexOf('-of') + 1];
      await fs.writeFile(`${of}.json`, JSON.stringify({ transcription: whisper.segments.map((text) => ({ text })) }));
    }
    return { code: 0, stdout: whisper.stdout ?? '', stderr: '' };
  };
  return transcribeFile(wav, {
    lexicon: LEXICON,
    whisperCli: '/fake/whisper-cli',
    modelOptions: { globalPath: path.join(dir, 'lexicon.yaml'), exists: () => true, fallbackDirs: [] },
    exec,
    tmpDir: path.join(dir, 'tmp'),
  });
}

describe('transcribeFile adjacent bracketed tags', () => {
  it.each([
    ['one JSON segment', { segments: [' send [MUSIC][noise] report '] }],
    ['tags touching both words', { segments: ['send[MUSIC][inaudible]report'] }],
    ['tags touching the first word', { segments: ['send[MUSIC][noise] report'] }],
    ['tags touching the second word', { segments: ['send [MUSIC][noise]report'] }],
    ['three tags in a row', { segments: ['send [MUSIC][inaudible][static] report'] }],
    ['an empty tag before a noise tag', { segments: ['send [][MUSIC] report'] }],
    ['adjacent tags at the start', { segments: ['[MUSIC][noise] send report'] }],
    ['adjacent tags at the end', { segments: ['send report [MUSIC][noise]'] }],
    ['one tag per JSON segment', { segments: ['send', '[MUSIC]', '[noise]', 'report'] }],
    ['the stdout fallback', { stdout: 'send [MUSIC][noise] report' }],
    ['stdout fallback, tags touching both words', { stdout: 'send[MUSIC][noise]report' }],
  ])('removes every tag and keeps both words from %s', async (_label, whisper) => {
    const result = await transcribe(whisper);
    expect(result.raw).toBe('send report');
    expect(result.output).toBe('send report');
    expect(result.raw).not.toContain('[');
    expect(result.raw).not.toContain(']');
  });

  it('asserts the exact cleaned transcript and never joins the surrounding words', async () => {
    const result = await transcribe({ segments: ['send[MUSIC][inaudible]report'] });
    expect(result.raw).toBe('send report');
    expect(result.raw).not.toContain('sendreport');
    for (const body of ['MUSIC', 'inaudible']) {
      expect(result.raw).not.toContain(body);
    }
  });

  it('keeps the spoken text around the tags in a noisier transcript', async () => {
    const result = await transcribe({ segments: [' send [MUSIC][noise] report (applause) *laughs* [static][beep] today '] });
    expect(result.raw).toBe('send report today');
    expect(result.output).toBe('send report today');
  });

  it('still applies the lexicon to the words around the adjacent tags', async () => {
    const result = await transcribe({ segments: [' ping [MUSIC][noise] ashler '] });
    expect(result.raw).toBe('ping ashler');
    expect(result.output).toBe('ping Ashlr.AI');
    expect(result.normalized.changed).toBe(true);
    expect(result.normalized.replacements).toHaveLength(1);
  });

  it('cleans a transcript of only adjacent tags to an empty string', async () => {
    const result = await transcribe({ segments: [' [MUSIC][noise][static] '] });
    expect(result.raw).toBe('');
    expect(result.output).toBe('');
  });
});
