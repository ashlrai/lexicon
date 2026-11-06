import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lexicon } from '../src/core/index.js';
import type { ExecResult, VoiceExec } from '../src/voice/process.js';
import { transcribeFile } from '../src/voice/transcribe.js';

// A bracketed tag at the start of a transcript (`[MUSIC] send the report`) is
// removed by transcribeFile and every following word survives, with the lexicon
// still applied to them - including the first word, which normalize() must see
// at position 0 of the cleaned text. cleanTranscript alone is covered in
// tests/clean-transcript-bracketed-tag-start.test.ts and next to the source;
// this goes through the whole stage the way
// tests/transcribe-bracketed-tag-between-words.test.ts does for a mid-line tag:
// whisper JSON or stdout -> cleanTranscript -> normalize.
const LEXICON: Lexicon = {
  version: 1,
  terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }],
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function transcribe(whisper: { segments?: string[]; stdout?: string }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-transcribe-tag-start-'));
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

describe('transcribeFile bracketed tag at the start', () => {
  it.each([
    ['one JSON segment', { segments: [' [MUSIC] send the report '] }],
    ['the tag as its own first JSON segment', { segments: ['[MUSIC]', ' send', ' the report'] }],
    ['a tag touching the first word', { segments: ['[MUSIC]send the report'] }],
    ['consecutive leading tags', { segments: ['[noise][BLANK_AUDIO] send the report'] }],
    ['leading whitespace before the tag', { segments: ['  \n[inaudible]  send the report'] }],
    ['the stdout fallback', { stdout: '[MUSIC] send the report' }],
    ['stdout with the tag on its own line', { stdout: '[BLANK_AUDIO]\nsend the report\n' }],
  ])('removes the tag and keeps every following word from %s', async (_label, whisper) => {
    const result = await transcribe(whisper);
    expect(result.raw).toBe('send the report');
    expect(result.output).toBe('send the report');
    expect(result.raw.startsWith('send')).toBe(true);
    expect(result.raw).not.toContain('[');
    expect(result.raw).not.toContain(']');
    // normalize() received the cleaned transcript, not whisper's tagged text.
    expect(result.normalized.input).toBe('send the report');
  });

  it('leaves no bracket residue, so the first spoken word leads the transcript', async () => {
    const result = await transcribe({ segments: ['[MUSIC] send the report'] });
    expect(result.raw.startsWith('send')).toBe(true);
    expect(result.raw).toBe(result.raw.trim());
  });

  it('still applies the lexicon to the first word after the tag', async () => {
    const result = await transcribe({ segments: [' [inaudible] ashler called '] });
    expect(result.raw).toBe('ashler called');
    expect(result.output).toBe('Ashlr.AI called');
    expect(result.normalized.changed).toBe(true);
  });

  it('removes a leading tag split across JSON segments before normalizing the following words', async () => {
    const result = await transcribe({ segments: ['[BLANK_', 'AUDIO] ashler', ' sent the report.'] });
    expect(result.raw).toBe('ashler sent the report.');
    expect(result.normalized.input).toBe('ashler sent the report.');
    expect(result.output).toBe('Ashlr.AI sent the report.');
  });

  it('removes a leading tag alongside a trailing one in the same transcript', async () => {
    const result = await transcribe({ segments: ['[MUSIC] send the report [noise]'] });
    expect(result.raw).toBe('send the report');
  });
});
