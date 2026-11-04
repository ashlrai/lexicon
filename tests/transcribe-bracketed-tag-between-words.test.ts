import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lexicon } from '../src/core/index.js';
import type { ExecResult, VoiceExec } from '../src/voice/process.js';
import { transcribeFile } from '../src/voice/transcribe.js';

// Regression: a bracketed tag between two words (`send [MUSIC] report`) is
// removed by transcribeFile and both words survive, with the lexicon still
// applied to them. cleanTranscript alone is covered in
// tests/clean-transcript-bracketed-tag.test.ts; this goes through the whole
// stage: whisper JSON or stdout -> cleanTranscript -> normalize.
const LEXICON: Lexicon = {
  version: 1,
  terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }],
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function transcribe(whisper: { segments?: string[]; stdout?: string }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-transcribe-tag-'));
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

describe('transcribeFile bracketed tag between words', () => {
  it.each([
    ['one JSON segment', { segments: [' send [MUSIC] report '] }],
    ['the tag as its own JSON segment', { segments: [' send', ' [MUSIC]', ' report'] }],
    ['a tag touching both words', { segments: ['send[MUSIC]report'] }],
    ['the stdout fallback', { stdout: 'send [MUSIC] report' }],
  ])('removes the tag and keeps both words from %s', async (_label, whisper) => {
    const result = await transcribe(whisper);
    expect(result.raw).toBe('send report');
    expect(result.output).toBe('send report');
    expect(result.raw).not.toContain('[');
  });

  it('still applies the lexicon to the words around the tag', async () => {
    const result = await transcribe({ segments: [' ping [inaudible] ashler '] });
    expect(result.raw).toBe('ping ashler');
    expect(result.output).toBe('ping Ashlr.AI');
  });
});

describe('transcribeFile empty bracketed tag', () => {
  // docs/CONTRACT.md: bracketed tags are always dropped, so `[]` goes too.
  it.each([
    ['one JSON segment', { segments: [' send [] report '] }],
    ['the tag as its own JSON segment', { segments: [' send', ' []', ' report'] }],
    ['a tag touching both words', { segments: ['send[]report'] }],
    ['the stdout fallback', { stdout: 'send [] report' }],
  ])('removes the empty tag and keeps both words from %s', async (_label, whisper) => {
    const result = await transcribe(whisper);
    expect(result.raw).toBe('send report');
    expect(result.output).toBe('send report');
    expect(result.raw).not.toContain('[');
  });

  it('still applies the lexicon to the words around an empty tag', async () => {
    const result = await transcribe({ segments: [' ping [] ashler '] });
    expect(result.raw).toBe('ping ashler');
    expect(result.output).toBe('ping Ashlr.AI');
  });
});
