import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lexicon } from '../src/core/index.js';
import type { ExecResult, VoiceExec } from '../src/voice/process.js';
import { transcribeFile, WhisperExitError } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. transcribeFile throws
// WhisperExitError on a non-zero exit only when whisper-cli wrote no JSON;
// whatever transcript it did recover - a JSON written before a crash, or the
// stdout parseWhisperOutput falls back to when the JSON is missing, malformed
// or the wrong shape - goes through cleanTranscript and normalize like a
// clean run. A bracketed tag leading that recovered transcript is removed and
// every following word survives, so the first spoken word still leads `raw`.
// The clean-run cases live in tests/transcribe-bracketed-tag-start.test.ts;
// this file covers the recovery paths, where the contract's throw is keyed to
// `json === undefined` alone.
const LEXICON: Lexicon = {
  version: 1,
  terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }],
};

interface FakeWhisper {
  /** Raw bytes whisper-cli leaves at `<outBase>.json`; undefined writes none. */
  json?: string;
  stdout?: string;
  stderr?: string;
  /** Exit code; null models a whisper-cli killed by a signal. */
  code?: number | null;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function transcribe(whisper: FakeWhisper) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-transcribe-start-fallback-'));
  dirs.push(dir);
  const wav = path.join(dir, 'capture.wav');
  await fs.writeFile(wav, Buffer.alloc(44 + 32_000));
  const exec: VoiceExec = async (_cmd, args): Promise<ExecResult> => {
    if (whisper.json !== undefined) {
      const of = args[args.indexOf('-of') + 1];
      await fs.writeFile(`${of}.json`, whisper.json);
    }
    return { code: whisper.code === undefined ? 0 : whisper.code, stdout: whisper.stdout ?? '', stderr: whisper.stderr ?? 'whisper: boom' };
  };
  return transcribeFile(wav, {
    lexicon: LEXICON,
    whisperCli: '/fake/whisper-cli',
    modelOptions: { globalPath: path.join(dir, 'lexicon.yaml'), exists: () => true, fallbackDirs: [] },
    exec,
    tmpDir: path.join(dir, 'tmp'),
  });
}

describe('transcribeFile bracketed tag at the start on recovered output', () => {
  it.each([
    ['a non-zero exit that still wrote JSON', {
      code: 1,
      json: JSON.stringify({ transcription: [{ text: ' [MUSIC] send the report ' }] }),
    }],
    ['a killed whisper-cli that still wrote JSON', {
      code: null,
      json: JSON.stringify({ transcription: [{ text: '[BLANK_AUDIO] send the report' }] }),
    }],
    ['malformed JSON falling back to stdout', {
      json: '{"transcription": [{"text": "send',
      stdout: '[MUSIC] send the report',
    }],
    ['JSON without a transcription field falling back to stdout', {
      json: '{}',
      stdout: '[MUSIC] send the report',
    }],
    ['a non-array transcription falling back to stdout', {
      json: JSON.stringify({ transcription: 'send the report' }),
      stdout: '[MUSIC] send the report',
    }],
    ['a null segment falling back to stdout', {
      json: '{"transcription": [null, {"text": "send the report"}]}',
      stdout: '[MUSIC] send the report',
    }],
  ])('removes the leading tag and keeps every following word when %s', async (_label, whisper) => {
    const result = await transcribe(whisper);
    expect(result.raw).toBe('send the report');
    expect(result.output).toBe('send the report');
    expect(result.raw.startsWith('send')).toBe(true);
    expect(result.raw).not.toContain('[');
    expect(result.raw).not.toContain(']');
    // normalize() received the cleaned transcript, not whisper's tagged text.
    expect(result.normalized.input).toBe('send the report');
  });

  it('still applies the lexicon to the first word after a recovered leading tag', async () => {
    const result = await transcribe({
      code: 1,
      json: JSON.stringify({ transcription: [{ text: ' [inaudible] ashler called ' }] }),
    });
    expect(result.raw).toBe('ashler called');
    expect(result.output).toBe('Ashlr.AI called');
    expect(result.normalized.changed).toBe(true);
  });

  it('lets a written but empty transcription stand over a tagged stdout', async () => {
    const result = await transcribe({ code: 1, json: '{"transcription": []}', stdout: '[MUSIC] send the report' });
    expect(result.raw).toBe('');
    expect(result.output).toBe('');
  });

  it('throws WhisperExitError and still removes the private scratch directory when no JSON was written', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-transcribe-start-fallback-'));
    dirs.push(dir);
    const wav = path.join(dir, 'capture.wav');
    await fs.writeFile(wav, Buffer.alloc(44 + 32_000));
    const tmpDir = path.join(dir, 'tmp');
    const exec: VoiceExec = async (): Promise<ExecResult> => ({ code: 1, stdout: '[MUSIC] send the report', stderr: 'whisper: segfault' });

    let err: unknown;
    try {
      await transcribeFile(wav, {
        lexicon: LEXICON,
        whisperCli: '/fake/whisper-cli',
        modelOptions: { globalPath: path.join(dir, 'lexicon.yaml'), exists: () => true, fallbackDirs: [] },
        exec,
        tmpDir,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WhisperExitError);
    expect((err as WhisperExitError).message).toBe('whisper-cli exited 1: whisper: segfault');
    expect((err as WhisperExitError).whisperCli).toBe('/fake/whisper-cli');
    // The tagged stdout is never returned as `raw`, and the 0700 scratch
    // directory went away on the throwing path too.
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });
});
