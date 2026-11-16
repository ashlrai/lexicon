import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lexicon } from '../src/core/index.js';
import type { ExecResult, VoiceExec } from '../src/voice/process.js';
import { transcribeFile } from '../src/voice/transcribe.js';

// A real whisper transcript can carry several bracketed tags spread across
// the utterance, not only next to each other (see
// tests/transcribe-adjacent-bracketed-tags.test.ts). Through the whole stage
// (whisper JSON or stdout -> cleanTranscript -> normalize) each tag is removed
// and the spoken words stay in order.
const LEXICON: Lexicon = {
  version: 1,
  terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }],
};

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function transcribe(whisper: { segments?: string[]; stdout?: string }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-transcribe-tags-'));
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

describe('transcribeFile multiple bracketed tags', () => {
  it.each([
    ['one JSON segment', { segments: ['[MUSIC] send [noise] the report [static]'] }],
    ['a tag between every word', { segments: [' send [MUSIC] the [noise] report [static] '] }],
    ['tags touching the words', { segments: ['send[MUSIC]the[noise]report[static]'] }],
    ['one JSON segment per word and tag', { segments: ['[MUSIC]', ' send', ' [noise]', ' the', ' report', ' [static]'] }],
    ['the stdout fallback', { stdout: '[MUSIC] send [noise] the report [static]' }],
  ])('removes every tag and keeps the words in order from %s', async (_label, whisper) => {
    const result = await transcribe(whisper);
    expect(result.raw).toBe('send the report');
    expect(result.output).toBe('send the report');
    expect(result.raw).not.toMatch(/[[\]]/);
  });

  it('keeps five spoken words in order across four tags', async () => {
    const result = await transcribe({ segments: ['one [a] two [b] three [c] four [d] five'] });
    expect(result.raw).toBe('one two three four five');
  });

  it('still applies the lexicon to words between the tags', async () => {
    const result = await transcribe({ segments: ['[MUSIC] ping [inaudible] ashler [noise] now [static]'] });
    expect(result.raw).toBe('ping ashler now');
    expect(result.output).toBe('ping Ashlr.AI now');
  });
});
