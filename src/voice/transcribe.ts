/**
 * whisper.cpp transcription of a 16 kHz mono WAV, followed by the lexicon.
 * `transcribeFile` is the stage `lexicon voice` runs after the recorder and
 * the one the tests and the TTS-audio check exercise directly.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportLexicon, normalize } from '../core/index.js';
import type { Lexicon, NormalizeResult } from '../core/index.js';
import { ensureModel } from './models.js';
import type { EnsureModelOptions, ResolvedModel } from './models.js';
import { defaultExec, installHint } from './process.js';
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
  /** Picks the install hint of a whisper-cli that cannot be started. Default process.platform. */
  platform?: NodeJS.Platform;
  /** How long whisper-cli may run before it is stopped; default whisperTimeoutMs of the WAV's length. */
  timeoutMs?: number;
  /**
   * Aborts the transcription (Ctrl-C): a model download or whisper-cli in
   * progress is stopped and TranscribeInterruptedError is thrown. The WAV is
   * left as it is; the caller says where it is.
   */
  signal?: AbortSignal;
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

/**
 * whisper-cli ran but exited non-zero without writing its JSON. Carries the
 * binary and model it ran with, so the caller can name a command to rerun.
 */
export class WhisperExitError extends Error {
  constructor(
    message: string,
    readonly whisperCli: string,
    readonly modelPath: string,
  ) {
    super(message);
    this.name = 'WhisperExitError';
  }
}

/**
 * How long whisper-cli may run on a capture: WHISPER_TIMEOUT_BASE_MS plus
 * WHISPER_TIMEOUT_PER_AUDIO_SECOND_MS for every second of audio. whisper-cli
 * had no timeout, so a run that hung (a GPU driver stuck, a model that
 * loads forever) held `lexicon voice`, and the hotkey's stop press, with no
 * end and no message. Ten times the audio's length is far past the larger
 * models on a CPU; the base covers loading the model.
 */
export const WHISPER_TIMEOUT_BASE_MS = 120_000;
export const WHISPER_TIMEOUT_PER_AUDIO_SECOND_MS = 10_000;

/** The whisper-cli timeout for `audioSeconds` of audio (see WHISPER_TIMEOUT_BASE_MS). */
export function whisperTimeoutMs(audioSeconds: number): number {
  const seconds = Number.isFinite(audioSeconds) && audioSeconds > 0 ? audioSeconds : 0;
  return WHISPER_TIMEOUT_BASE_MS + Math.ceil(seconds * WHISPER_TIMEOUT_PER_AUDIO_SECOND_MS);
}

/** Seconds of 16 kHz mono 16-bit audio in the WAV at `wav`, from its size (0 when it cannot be read). */
async function wavSeconds(wav: string): Promise<number> {
  try {
    const { size } = await fs.stat(wav);
    return Math.max(0, size - 44) / 32_000;
  } catch {
    return 0;
  }
}

/** whisper-cli ran past its timeout (whisperTimeoutMs) and was stopped. */
export class WhisperTimeoutError extends WhisperExitError {
  constructor(
    readonly timeoutMs: number,
    readonly audioSeconds: number,
    whisperCli: string,
    modelPath: string,
  ) {
    super(
      `whisper-cli did not finish within ${Math.round(timeoutMs / 1000)} s on ${Math.round(audioSeconds)} s of audio, so it was stopped`,
      whisperCli,
      modelPath,
    );
    this.name = 'WhisperTimeoutError';
  }
}

/** The transcription was interrupted (TranscribeOptions.signal aborted) before whisper finished. */
export class TranscribeInterruptedError extends Error {
  constructor() {
    super('interrupted while transcribing');
    this.name = 'TranscribeInterruptedError';
  }
}

/**
 * Wait up to `ms` for `signal` to abort. A whisper-cli killed by a signal is
 * most often the user's Ctrl-C, which the terminal sends to whisper and to
 * this process at once; the child's exit can be seen before our own handler
 * runs, and would then read as whisper failing.
 */
async function settleAbort(signal: AbortSignal | undefined, ms: number): Promise<void> {
  if (!signal || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Run whisper-cli on `wav` and normalize the transcript with the lexicon. */
export async function transcribeFile(wav: string, opts: TranscribeOptions): Promise<TranscribeResult> {
  const exec = opts.exec ?? defaultExec;
  const signal = opts.signal;
  let model: ResolvedModel;
  try {
    model = await ensureModel(opts.model ?? 'base.en', { ...opts.modelOptions, ...(signal ? { signal } : {}) });
  } catch (e) {
    if (signal?.aborted) throw new TranscribeInterruptedError();
    throw e;
  }
  if (signal?.aborted) throw new TranscribeInterruptedError();
  const prompt = opts.prompt === false ? undefined : buildWhisperPrompt(opts.lexicon) || undefined;
  const tmpDir = opts.tmpDir ?? os.tmpdir();
  await fs.mkdir(tmpDir, { recursive: true });
  // whisper-cli writes the transcript to `<outBase>.json`. That was a
  // predictable name directly in the temp directory (/tmp, shared by every
  // account on Linux), written under the umask: another user could read what
  // was dictated, or plant the file (or a symlink) first, and a planted file
  // was read back as the transcript. A fresh 0700 directory of our own holds
  // it now, removed with what is in it once the transcript is read.
  const outDir = await fs.mkdtemp(path.join(tmpDir, 'lexicon-whisper-'));
  let r;
  let json: string | undefined;
  let transcribeMs: number;
  let audioSeconds: number;
  let timeoutMs: number;
  try {
    const outBase = path.join(outDir, 'transcript');
    const args = whisperArgs({ modelPath: model.path, wav, outBase, lang: opts.lang ?? 'en', translate: opts.translate ?? false, prompt });

    audioSeconds = await wavSeconds(wav);
    timeoutMs = opts.timeoutMs ?? whisperTimeoutMs(audioSeconds);
    const t0 = Date.now();
    try {
      r = await exec(opts.whisperCli, args, { timeoutMs, ...(signal ? { signal } : {}) });
    } catch (e) {
      // The hint was `brew install whisper-cpp` on every platform.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new MissingToolError('whisper-cli', installHint(opts.platform ?? process.platform, { ffmpeg: false, whisper: true }));
      throw e;
    }
    transcribeMs = Date.now() - t0;
    try {
      json = await fs.readFile(`${outBase}.json`, 'utf8');
    } catch {
      json = undefined;
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  }
  if (r.code === null) await settleAbort(signal, 200);
  if (signal?.aborted) throw new TranscribeInterruptedError();
  if (r.timedOut) throw new WhisperTimeoutError(timeoutMs, audioSeconds, opts.whisperCli, model.path);
  if (r.code !== 0 && json === undefined) {
    const tail = r.stderr.trim().split('\n').slice(-5).join('\n');
    throw new WhisperExitError(`whisper-cli exited ${r.code ?? 'null'}${tail ? `: ${tail}` : ''}`, opts.whisperCli, model.path);
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
