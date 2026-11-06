import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lexicon } from '../src/core/index.js';
import type { ExecResult, VoiceExec } from '../src/voice/process.js';
import { cleanTranscript, transcribeFile } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. An empty transcript is
// what whisper produces for silence, a wrong --lang, or a model too small for
// the room: cleanTranscript strips `[BLANK_AUDIO]` and every other annotation
// to '', and transcribeFile hands that '' on as `raw`. `lexicon voice` keys
// its "(nothing heard)" exit (3, the capture kept) off `result.raw.length ===
// 0`, so `raw` must be the empty string itself - not whitespace, not the tags
// whisper emitted, and not an exception. The cleanTranscript half of this is
// covered next to the source and in tests/clean-transcript-empty-input.test.ts;
// this file exercises the transcribeFile half, which nothing else calls
// directly (tests/voice.test.ts reaches it through runVoice).
const LEXICON: Lexicon = {
  version: 1,
  terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }],
};

interface FakeWhisper {
  /**
   * transcription[].text values whisper writes to `<outBase>.json`. undefined
   * writes no JSON at all, the way a whisper-cli that printed to stdout does.
   */
  segments?: string[];
  stdout?: string;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function transcribe(whisper: FakeWhisper) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-transcribe-empty-'));
  dirs.push(dir);
  // One second of 16 kHz mono s16 silence; only the size is read (wavSeconds).
  const wav = path.join(dir, 'capture.wav');
  await fs.writeFile(wav, Buffer.alloc(44 + 32_000));
  const tmpDir = path.join(dir, 'tmp');

  const execCalls: Array<{ cmd: string; args: string[] }> = [];
  const exec: VoiceExec = async (cmd, args): Promise<ExecResult> => {
    execCalls.push({ cmd, args: [...args] });
    const of = args[args.indexOf('-of') + 1];
    if (whisper.segments !== undefined) {
      await fs.writeFile(`${of}.json`, JSON.stringify({ transcription: whisper.segments.map((text) => ({ text })) }));
    }
    return { code: 0, stdout: whisper.stdout ?? '', stderr: '' };
  };

  const result = await transcribeFile(wav, {
    lexicon: LEXICON,
    whisperCli: '/fake/whisper-cli',
    modelOptions: { globalPath: path.join(dir, 'lexicon.yaml'), exists: () => true, fallbackDirs: [] },
    exec,
    tmpDir,
  });
  return { result, execCalls, tmpDir };
}

describe('cleanTranscript empty input', () => {
  it('returns an empty string', () => {
    expect(cleanTranscript('')).toBe('');
  });
});

describe('transcribeFile empty transcript', () => {
  it.each([
    ['whisper tags the whole capture [BLANK_AUDIO]', { segments: [' [BLANK_AUDIO] '] }],
    ['every segment is an annotation', { segments: ['[MUSIC]', '*laughs*', '(applause)'] }],
    ['the transcription array is empty', { segments: [], stdout: 'ignored stdout' }],
    ['a segment carries only whitespace', { segments: ['  \n\t '], stdout: 'ignored stdout' }],
    ['no JSON is written and stdout is empty', { stdout: '' }],
    ['no JSON is written and stdout is whitespace', { stdout: '  \n ' }],
    ['no JSON is written and stdout is only annotations', { stdout: '[BLANK_AUDIO] *laughs* (soft music)' }],
  ])('returns raw and output as the empty string when %s', async (_label, whisper) => {
    const { result } = await transcribe(whisper);
    // voice.ts: result.raw.length === 0 is the "(nothing heard)" exit that
    // keeps the WAV, so this must be '' exactly, and nothing may throw above.
    expect(result.raw).toBe('');
    expect(result.output).toBe('');
    expect(result.normalized).toMatchObject({ input: '', output: '', changed: false, replacements: [] });
  });

  it('removes the private scratch directory after an empty transcript too', async () => {
    const { tmpDir } = await transcribe({ segments: [' [BLANK_AUDIO] '] });
    const left = (await fs.readdir(tmpDir)).filter((name) => name.startsWith('lexicon-whisper-'));
    expect(left).toEqual([]);
  });

  it('still resolves the model and runs whisper-cli once', async () => {
    const { result, execCalls } = await transcribe({ segments: ['[BLANK_AUDIO]'] });
    expect(result.model.name).toBe('base.en');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args).toEqual(expect.arrayContaining(['-l', 'en', '-nt', '-np', '-oj']));
  });

  it('does not turn a real transcript into the empty string', async () => {
    const { result } = await transcribe({ segments: [' ping ashler '] });
    expect(result.raw).toBe('ping ashler');
    expect(result.output).toBe('ping Ashlr.AI');
    expect(result.normalized.changed).toBe(true);
  });
});
