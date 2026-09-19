/**
 * whisper.cpp transcription of a 16 kHz mono WAV, followed by the lexicon.
 * `transcribeFile` is the stage `lexicon voice` runs after the recorder and
 * the one the tests and the real-audio check exercise directly.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportLexicon, normalize } from '../core/index.js';
import type { Lexicon, NormalizeResult } from '../core/index.js';
import { ensureModel } from './models.js';
import type { EnsureModelOptions, ResolvedModel } from './models.js';
import { defaultExec } from './process.js';
import type { VoiceExec } from './process.js';

/**
 * Whisper output -> one line. Bracketed tags (`[BLANK_AUDIO]`, `[MUSIC]`,
 * `[inaudible]`) are always dropped. Parenthesised or starred tags are dropped
 * only when they look like a noise annotation (one to three plain words, e.g.
 * `(applause)`, `(soft music)`, `*laughs*`), so a dictated parenthetical
 * survives. Whitespace is collapsed and trimmed.
 */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\)/g, (m, inner: string) => (isNoiseTag(inner) ? ' ' : m))
    .replace(/\*([A-Za-z]+(?:\s+[A-Za-z]+){0,2})\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NOISE_WORDS = /^(applause|laugh(s|ter|ing)?|music|silence|noise|inaudible|unintelligible|cough(s|ing)?|sigh(s)?|clapping|static|breathing|beep(s|ing)?|clears? throat|crosstalk|speaking in .*|foreign language|typing|chuckles?|pause)$/i;

function isNoiseTag(inner: string): boolean {
  const words = inner.trim().toLowerCase();
  if (NOISE_WORDS.test(words)) return true;
  // "(upbeat music)", "(soft laughter)", "(loud applause)"
  const last = words.split(/\s+/).pop() ?? '';
  return NOISE_WORDS.test(last) && words.split(/\s+/).length <= 3;
}

export interface WhisperArgsOptions {
  modelPath: string;
  wav: string;
  /** Output base path (whisper writes `<outBase>.json`). */
  outBase: string;
  lang: string;
  translate: boolean;
  prompt?: string;
}

/** The whisper-cli argv; exported so tests can assert on `--prompt`. */
export function whisperArgs(opts: WhisperArgsOptions): string[] {
  const args = ['-m', opts.modelPath, '-f', opts.wav, '-l', opts.lang, '-nt', '-np', '-oj', '-of', opts.outBase];
  if (opts.translate) args.push('-tr');
  if (opts.prompt) args.push('--prompt', opts.prompt);
  return args;
}

interface WhisperJson {
  transcription?: Array<{ text?: string }>;
}

/** Turn whisper's JSON (or, failing that, its stdout) into the raw transcript. */
export function parseWhisperOutput(json: string | undefined, stdout: string): string {
  if (json) {
    try {
      const parsed = JSON.parse(json) as WhisperJson;
      if (Array.isArray(parsed.transcription)) {
        return parsed.transcription.map((s) => s.text ?? '').join(' ');
      }
    } catch {
      // fall through to stdout
    }
  }
  return stdout;
}

/** Build whisper's initial prompt from the merged lexicon (canonicals only). */
export function buildWhisperPrompt(lexicon: Lexicon): string {
  return exportLexicon(lexicon, 'whisper-prompt');
}

export interface TranscribeOptions {
  /** The merged lexicon used for the prompt and for normalize(). */
  lexicon: Lexicon;
  /** Absolute path to whisper-cli. */
  whisperCli: string;
  /** Model name or path. Default `base.en`. */
  model?: string;
  /** Options for locating/downloading the model. */
  modelOptions: EnsureModelOptions;
  lang?: string;
  translate?: boolean;
  /** Pass the lexicon as whisper's initial prompt. Default true. */
  prompt?: boolean;
  exec?: VoiceExec;
  /** Scratch directory for whisper's JSON. Default os.tmpdir(). */
  tmpDir?: string;
  /** Status sink (stderr). */
  log?: (line: string) => void;
}

export interface TranscribeResult {
  /** Cleaned whisper transcript, before the lexicon. */
  raw: string;
  /** After normalize(). */
  output: string;
  normalized: NormalizeResult;
  model: ResolvedModel;
  /** The prompt whisper was given, if any. */
  prompt?: string;
  ms: { transcribe: number; normalize: number };
}

export class MissingToolError extends Error {
  constructor(
    public readonly tool: string,
    hint: string,
  ) {
    super(`${tool} not found. Install it: ${hint}`);
    this.name = 'MissingToolError';
  }
}

/** Run whisper-cli on `wav` and normalize the transcript with the lexicon. */
export async function transcribeFile(wav: string, opts: TranscribeOptions): Promise<TranscribeResult> {
  const exec = opts.exec ?? defaultExec;
  const model = await ensureModel(opts.model ?? 'base.en', opts.modelOptions);
  const prompt = opts.prompt === false ? undefined : buildWhisperPrompt(opts.lexicon) || undefined;
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  await fs.mkdir(tmpDir, { recursive: true });
  const outBase = path.join(tmpDir, `lexicon-voice-${process.pid}-${Date.now().toString(36)}`);
  const args = whisperArgs({ modelPath: model.path, wav, outBase, lang: opts.lang ?? 'en', translate: opts.translate ?? false, prompt });

  const t0 = Date.now();
  let r;
  try {
    r = await exec(opts.whisperCli, args);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new MissingToolError('whisper-cli', 'brew install whisper-cpp');
    throw e;
  }
  const transcribeMs = Date.now() - t0;
  const jsonPath = `${outBase}.json`;
  let json: string | undefined;
  try {
    json = await fs.readFile(jsonPath, 'utf8');
  } catch {
    json = undefined;
  }
  await fs.rm(jsonPath, { force: true }).catch(() => undefined);
  if (r.code !== 0 && json === undefined) {
    const tail = r.stderr.trim().split('\n').slice(-5).join('\n');
    throw new Error(`whisper-cli exited ${r.code ?? 'null'}${tail ? `: ${tail}` : ''}`);
  }
  const raw = cleanTranscript(parseWhisperOutput(json, r.stdout));

  const n0 = Date.now();
  const normalized = normalize(raw, opts.lexicon);
  const normalizeMs = Date.now() - n0;

  return {
    raw,
    output: normalized.output,
    normalized,
    model,
    ...(prompt !== undefined ? { prompt } : {}),
    ms: { transcribe: transcribeMs, normalize: normalizeMs },
  };
}
