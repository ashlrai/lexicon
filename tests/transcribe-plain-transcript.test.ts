import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Lexicon } from '../src/core/index.js';
import type { ExecResult, VoiceExec } from '../src/voice/process.js';
import { transcribeFile } from '../src/voice/transcribe.js';

// Contract: docs/CONTRACT.md, src/voice/transcribe.ts. transcribeFile feeds
// whisper's JSON (or its stdout) through cleanTranscript, which drops `[...]`
// tags, `*...*` of one to three plain words and noise `(...)`, then collapses
// whitespace and trims, and through normalize(). A transcript of ordinary
// speech carries nothing to drop, so `raw` must come back verbatim and
// normalize() must report changed: false with no replacements. The
// cleanTranscript half is covered next to the source and in
// tests/clean-transcript-ordinary-text.test.ts; this file exercises the whole
// stage, which the other transcribeFile tests reach only with a tag to remove
// or an empty result.
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

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');
const bullet = contract.split('\n').find((line) => line.includes('`transcribeFile(wav, opts: TranscribeOptions')) ?? '';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function transcribe(whisper: FakeWhisper) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-transcribe-plain-'));
  dirs.push(dir);
  // One second of 16 kHz mono s16; only the size is read (wavSeconds).
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
  return { result, execCalls, tmpDir, wav };
}

describe('transcribeFile plain transcript', () => {
  it('still documents cleaning then normalizing in docs/CONTRACT.md', () => {
    expect(bullet).toContain('`transcribeFile(wav, opts: TranscribeOptions');
    expect(bullet).toContain('cleans, normalizes');
  });

  it.each<[string, FakeWhisper, string]>([
    ['one JSON segment', { segments: ['Please send the report to the team.'] }, 'Please send the report to the team.'],
    ['several JSON segments', { segments: ['Please send the report', 'to the team,', 'then go home.'] }, 'Please send the report to the team, then go home.'],
    ['a question with non-ASCII names', { segments: ['Did Zoë already ship the café menu?'] }, 'Did Zoë already ship the café menu?'],
    ['contractions and a possessive', { segments: ["Let's ping Mason's team about Friday's deploy."] }, "Let's ping Mason's team about Friday's deploy."],
    ['numbers and punctuation', { segments: ['Version 2.5 shipped at 3:45 pm, up 3%, for $1,250.75.'] }, 'Version 2.5 shipped at 3:45 pm, up 3%, for $1,250.75.'],
    ['the stdout fallback', { stdout: 'Ship it tonight!' }, 'Ship it tonight!'],
    ['stdout with a trailing newline', { stdout: 'First we ship. Then we rest.\n' }, 'First we ship. Then we rest.'],
  ])('returns raw and output verbatim when ordinary speech comes from %s', async (_label, whisper, expected) => {
    const { result } = await transcribe(whisper);
    expect(result.raw).toBe(expected);
    expect(result.output).toBe(expected);
    expect(result.normalized).toMatchObject({ input: expected, output: expected, changed: false, replacements: [] });
  });

  it.each([
    ['a four-word starred span', 'Please keep *these four spoken words* intact.'],
    ['spaced math asterisks', 'The total is 2 * 3 * 4, not 24.'],
    ['starred words holding a digit', 'Please keep *room 2* ready.'],
    ['a spoken parenthetical', 'Please review (the new build) today.'],
    ['a parenthetical holding a digit', 'Call +1 (555) 010-2030, or meet at 5 (not 6) pm.'],
    ['an unmatched opening bracket', 'Please keep [unfinished speech.'],
    ['an unmatched closing bracket', 'Please keep unfinished] speech.'],
  ])('preserves %s, which is not an annotation, through the whole stage', async (_label, sentence) => {
    const { result } = await transcribe({ segments: [sentence] });
    expect(result.raw).toBe(sentence);
    expect(result.output).toBe(sentence);
    expect(result.normalized.changed).toBe(false);
  });

  it('changes only whitespace when whisper pads ordinary speech', async () => {
    const { result } = await transcribe({ segments: ['  Please   review\nthe \tcafé   menu.  '] });
    expect(result.raw).toBe('Please review the café menu.');
    expect(result.raw.replace(/\s/g, '')).toBe('Pleasereviewthecafémenu.');
  });

  it('still runs whisper-cli once on the WAV and resolves the model', async () => {
    const { result, execCalls, wav } = await transcribe({ segments: ['Ship it.'] });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe('/fake/whisper-cli');
    expect(execCalls[0].args).toEqual(expect.arrayContaining(['-f', wav]));
    expect(result.model.name).toBe('base.en');
  });

  it('removes the private scratch directory after a plain transcript too', async () => {
    const { tmpDir } = await transcribe({ segments: ['Ship it.'] });
    const left = (await fs.readdir(tmpDir)).filter((name) => name.startsWith('lexicon-whisper-'));
    expect(left).toEqual([]);
  });

  it('still applies the lexicon when a dictated word is an alias', async () => {
    const { result } = await transcribe({ segments: [' ping ashler '] });
    expect(result.raw).toBe('ping ashler');
    expect(result.output).toBe('ping Ashlr.AI');
    expect(result.normalized.changed).toBe(true);
  });
});
