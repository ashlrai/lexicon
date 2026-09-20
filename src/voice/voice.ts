/**
 * `lexicon voice`: local push-to-talk dictation. ffmpeg records the default
 * microphone to a 16 kHz mono WAV, whisper.cpp transcribes it with the
 * lexicon's canonicals as the initial prompt, normalize() fixes what Whisper
 * still got wrong, and the text goes to stdout, the clipboard (`--copy`) or
 * the frontmost app (`--paste`, macOS).
 *
 * Two shapes:
 * - `runVoice`: record in this process until Enter, Ctrl-C or `--seconds`.
 * - `runVoiceToggle`: the hotkey mode. First call starts a detached ffmpeg and
 *   writes `<dirname(globalPath)>/voice/recording.json`; second call stops it,
 *   transcribes and outputs. A stale state file (pid gone) counts as "start".
 *   The start is atomic: the state file is claimed with an exclusive create
 *   before ffmpeg spawns, so two presses that race start one recorder (the
 *   loser prints `recording` and exits 0).
 *
 * Every process interaction goes through `VoiceDeps` so tests never touch a
 * microphone. Exit codes: 0 ok, 1 error, 2 ffmpeg/whisper-cli missing,
 * 3 nothing heard.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffSummary, loadLexicon, recordHits, resolvePaths } from '../core/index.js';
import type { Lexicon } from '../core/index.js';
import { PASTE_APPLESCRIPT } from '../daemon/clipboard.js';
import { ExecError, detectClipboardBackend } from '../daemon/clipboard-backends.js';
import type { ClipboardExec } from '../daemon/clipboard-backends.js';
import { formatDeviceList, listAudioDevices } from './devices.js';
import { appendHistory } from './history.js';
import { DEFAULT_MODEL } from './models.js';
import type { Downloader } from './models.js';
import {
  defaultExec,
  defaultIsAlive,
  defaultKill,
  defaultSpawn,
  installHint,
  locateFfmpeg,
  locateWhisperCli,
} from './process.js';
import type { ChildHandle, VoiceExec, VoiceSpawn } from './process.js';
import {
  MAX_TOGGLE_SECONDS,
  claimState,
  clearState,
  ensureVoiceDir,
  isProvisional,
  isStaleProvisional,
  readState,
  recorderLogPath,
  resolveInput,
  startRecorder,
  stateFilePath,
  stopRecorder,
  touchPrivateFile,
  wavHasAudio,
  writeState,
} from './recorder.js';
import type { RecordingState } from './recorder.js';
import { MissingToolError, transcribeFile } from './transcribe.js';
import type { TranscribeResult } from './transcribe.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_MISSING_TOOL = 2;
export const EXIT_NOTHING_HEARD = 3;

export interface VoiceOptions {
  /** Directory for project-lexicon discovery. Default process.cwd(). */
  cwd?: string;
  /** Explicit global lexicon path (tests); default resolvePaths(). */
  globalPath?: string;
  /** Stop recording after this many seconds instead of waiting for Enter. */
  seconds?: number;
  /** Input device name or index (see --list-devices). */
  device?: string;
  /** whisper model name (`base.en`) or path to a ggml file. Default base.en. */
  model?: string;
  /** Spoken language. Default en. */
  lang?: string;
  /** Translate to English (whisper -tr). Default false. */
  translate?: boolean;
  /** Pass the lexicon canonicals as whisper's initial prompt. Default true. */
  prompt?: boolean;
  /** Append to voice/history.jsonl. Default true. */
  history?: boolean;
  /** Put the corrected text on the clipboard. */
  copy?: boolean;
  /** Copy and send Cmd+V to the frontmost app (macOS). */
  paste?: boolean;
  /** Print the JSON result instead of the text. */
  json?: boolean;
  /** Suppress status lines on stderr. */
  quiet?: boolean;
}

export interface VoiceDeps {
  exec?: VoiceExec;
  spawn?: VoiceSpawn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  download?: Downloader;
  /** Resolves when the foreground recording should stop; the value says why. */
  waitForStop?: () => Promise<'enter' | 'sigint'>;
  /** Clipboard writer; default: the detected platform backend. */
  clipboardWrite?: (text: string) => Promise<void>;
  /** Paste keystroke; default: osascript Cmd+V. */
  sendPaste?: () => Promise<void>;
  /** Existence probe for tool/model lookup. */
  exists?: (p: string) => Promise<boolean>;
  /** Extra directories searched for binaries after PATH (tests pass [] for determinism). */
  extraBinDirs?: readonly string[];
  /** Extra directories searched for an existing model. */
  modelFallbackDirs?: readonly string[];
  /** Scratch directory for WAVs and whisper output. Default os.tmpdir(). */
  tmpDir?: string;
  now?: () => Date;
  /** Wall clock for the `ms` timings. Default Date.now. */
  clock?: () => number;
}

export interface VoiceIO {
  stdout(s: string): void;
  stderr(s: string): void;
}

export interface VoiceJsonResult {
  raw: string;
  output: string;
  replacements: TranscribeResult['normalized']['replacements'];
  summary: string;
  model: string;
  seconds: number;
  ms: { record: number; transcribe: number; normalize: number };
}

interface Resolved {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exec: VoiceExec;
  spawn: VoiceSpawn;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  cwd: string;
  globalPath: string;
  tmpDir: string;
  now: () => Date;
  clock: () => number;
  log: (s: string) => void;
  /** Carriage-return progress updates (model download). */
  progress: (s: string) => void;
}

function resolve(opts: VoiceOptions, io: VoiceIO, deps: VoiceDeps): Resolved {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const globalPath = opts.globalPath ?? resolvePaths({ cwd }).global;
  return {
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    exec: deps.exec ?? defaultExec,
    spawn: deps.spawn ?? defaultSpawn,
    isAlive: deps.isAlive ?? defaultIsAlive,
    kill: deps.kill ?? defaultKill,
    cwd,
    globalPath,
    tmpDir: deps.tmpDir ?? os.tmpdir(),
    now: deps.now ?? (() => new Date()),
    clock: deps.clock ?? Date.now,
    log: opts.quiet ? () => undefined : (s: string) => io.stderr(`${s}\n`),
    progress: opts.quiet ? () => undefined : (s: string) => io.stderr(`\r${s}`),
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface Tools {
  ffmpeg: string;
  whisperCli: string;
}

/** Locate ffmpeg and whisper-cli, or print install hints and return undefined. */
async function requireTools(r: Resolved, io: VoiceIO, deps: VoiceDeps, need: { ffmpeg: boolean; whisper: boolean }): Promise<Tools | undefined> {
  const locate = { env: r.env, platform: r.platform, ...(deps.exists ? { exists: deps.exists } : {}), ...(deps.extraBinDirs ? { extraDirs: deps.extraBinDirs } : {}) };
  const ffmpeg = need.ffmpeg ? await locateFfmpeg(locate) : 'ffmpeg';
  const whisperCli = need.whisper ? await locateWhisperCli(locate) : 'whisper-cli';
  const missing: string[] = [];
  if (!ffmpeg) missing.push('ffmpeg');
  if (!whisperCli) missing.push(r.env.LEXICON_WHISPER_BIN ? `whisper-cli (LEXICON_WHISPER_BIN=${r.env.LEXICON_WHISPER_BIN} does not exist)` : 'whisper-cli');
  if (missing.length > 0 || !ffmpeg || !whisperCli) {
    io.stderr(`lexicon voice: ${missing.join(' and ')} not found on PATH.\n  install: ${installHint(r.platform)}\n  (or set LEXICON_WHISPER_BIN / LEXICON_FFMPEG_BIN to the binary)\n`);
    return undefined;
  }
  return { ffmpeg, whisperCli };
}

async function loadMerged(r: Resolved, opts: VoiceOptions): Promise<Lexicon> {
  return (await loadLexicon({ cwd: r.cwd, ...(opts.globalPath ? { globalPath: opts.globalPath } : {}) })).merged;
}

/** Wrap the voice exec as the daemon's ClipboardExec (non-zero exit rejects). */
function asClipboardExec(exec: VoiceExec): ClipboardExec {
  return async (cmd, args, stdin) => {
    const res = await exec(cmd, args, stdin !== undefined ? { stdin } : {});
    if (res.code !== 0) throw new ExecError(cmd, res.code, res.stderr);
    return res.stdout;
  };
}

/**
 * Deliver a finished transcription: history, hits, stdout/JSON, clipboard,
 * paste. Shared by both modes. Returns the exit code.
 */
export async function deliver(
  result: TranscribeResult,
  recordMs: number,
  seconds: number,
  opts: VoiceOptions,
  io: VoiceIO,
  deps: VoiceDeps,
  r: Resolved,
): Promise<number> {
  if (result.raw.length === 0) {
    if (opts.json) {
      io.stdout(`${JSON.stringify(jsonResult(result, recordMs, seconds))}\n`);
    } else {
      io.stdout('(nothing heard)\n');
    }
    return EXIT_NOTHING_HEARD;
  }

  if (opts.history !== false) {
    await appendHistory(r.globalPath, {
      at: r.now().toISOString(),
      raw: result.raw,
      output: result.output,
      model: result.model.name,
      ms: { record: recordMs, transcribe: result.ms.transcribe, normalize: result.ms.normalize },
    });
  }
  if (result.normalized.changed) {
    const canonicals = [...new Set(result.normalized.replacements.map((x) => x.canonical))];
    await recordHits(canonicals, { cwd: r.cwd, ...(opts.globalPath ? { globalPath: opts.globalPath } : {}) }).catch((e: unknown) => {
      r.log(`lexicon voice: recordHits: ${message(e)}`);
    });
    r.log(`${result.normalized.replacements.length} correction${result.normalized.replacements.length === 1 ? '' : 's'}: ${diffSummary(result.normalized).replace(/\n/g, '; ')}`);
  }

  if (opts.json) io.stdout(`${JSON.stringify(jsonResult(result, recordMs, seconds))}\n`);
  else io.stdout(`${result.output}\n`);

  let wantCopy = opts.copy === true || opts.paste === true;
  let wantPaste = opts.paste === true;
  if (wantPaste && r.platform !== 'darwin') {
    io.stderr(`lexicon voice: --paste is not supported yet on ${r.platform}; the text is on the clipboard, paste it with your usual shortcut\n`);
    wantPaste = false;
    wantCopy = true;
  }
  if (wantCopy) {
    try {
      const write =
        deps.clipboardWrite ??
        (async (text: string): Promise<void> => {
          const backend = await detectClipboardBackend(r.platform, r.env, undefined, asClipboardExec(r.exec));
          await backend.write(text);
        });
      await write(result.output);
    } catch (e) {
      io.stderr(`lexicon voice: could not copy to the clipboard: ${message(e)}\n`);
      return EXIT_ERROR;
    }
  }
  if (wantPaste) {
    try {
      const sendPaste =
        deps.sendPaste ??
        (async (): Promise<void> => {
          const res = await r.exec('osascript', ['-e', PASTE_APPLESCRIPT]);
          if (res.code !== 0) throw new ExecError('osascript', res.code, res.stderr);
        });
      await sendPaste();
    } catch (e) {
      io.stderr(
        `lexicon voice: --paste failed: ${message(e)}\n` +
          '  The app that runs this command (Terminal, Raycast, Hammerspoon, ...) needs Accessibility permission: System Settings > Privacy & Security > Accessibility. The text is on the clipboard.\n',
      );
      return EXIT_ERROR;
    }
  }
  return EXIT_OK;
}

export function jsonResult(result: TranscribeResult, recordMs: number, seconds: number): VoiceJsonResult {
  return {
    raw: result.raw,
    output: result.output,
    replacements: result.normalized.replacements,
    summary: result.normalized.replacements.length === 0 ? '' : diffSummary(result.normalized),
    model: result.model.name,
    seconds,
    ms: { record: recordMs, transcribe: result.ms.transcribe, normalize: result.ms.normalize },
  };
}

function transcribeOptions(r: Resolved, opts: VoiceOptions, deps: VoiceDeps, lexicon: Lexicon, whisperCli: string) {
  return {
    lexicon,
    whisperCli,
    model: opts.model ?? DEFAULT_MODEL,
    modelOptions: {
      globalPath: r.globalPath,
      env: r.env,
      ...(deps.modelFallbackDirs ? { fallbackDirs: deps.modelFallbackDirs } : {}),
      ...(deps.download ? { download: deps.download } : {}),
      log: r.log,
      progress: r.progress,
    },
    lang: opts.lang ?? 'en',
    translate: opts.translate ?? false,
    prompt: opts.prompt !== false,
    exec: r.exec,
    tmpDir: r.tmpDir,
    log: r.log,
  };
}

/** Wait for Enter on stdin (when it is a TTY or a pipe) or SIGINT. */
function defaultWaitForStop(): Promise<'enter' | 'sigint'> {
  return new Promise((resolveStop) => {
    let done = false;
    const finish = (why: 'enter' | 'sigint'): void => {
      if (done) return;
      done = true;
      process.removeListener('SIGINT', onSigint);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      try {
        process.stdin.pause();
      } catch {
        // stdin may be closed
      }
      resolveStop(why);
    };
    const onSigint = (): void => finish('sigint');
    const onData = (chunk: Buffer | string): void => {
      if (String(chunk).includes('\n') || String(chunk).includes('\r')) finish('enter');
    };
    const onEnd = (): void => finish('enter');
    process.on('SIGINT', onSigint);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
      process.stdin.resume();
    } catch {
      // no stdin (launcher); only SIGINT or --seconds can stop us
    }
  });
}

// ---------------------------------------------------------------------------
// Foreground mode

/** Record until Enter, Ctrl-C or `--seconds`, then transcribe, normalize and output. Returns the exit code. */
export async function runVoice(opts: VoiceOptions, io: VoiceIO, deps: VoiceDeps = {}): Promise<number> {
  const r = resolve(opts, io, deps);
  const tools = await requireTools(r, io, deps, { ffmpeg: true, whisper: true });
  if (!tools) return EXIT_MISSING_TOOL;

  let lexicon: Lexicon;
  try {
    lexicon = await loadMerged(r, opts);
  } catch (e) {
    io.stderr(`lexicon voice: ${message(e)}\n`);
    return EXIT_ERROR;
  }

  let input;
  try {
    input = await resolveInput({ platform: r.platform, ffmpeg: tools.ffmpeg, exec: r.exec, ...(opts.device ? { device: opts.device } : {}) });
  } catch (e) {
    io.stderr(`lexicon voice: ${message(e)}\n`);
    return EXIT_ERROR;
  }

  await fs.mkdir(r.tmpDir, { recursive: true });
  const wav = path.join(r.tmpDir, `lexicon-voice-${process.pid}-${r.clock().toString(36)}.wav`);
  // Created 0600 before ffmpeg opens it (O_TRUNC keeps the mode): the audio is the user's.
  await touchPrivateFile(wav);
  const seconds = opts.seconds !== undefined && opts.seconds > 0 ? opts.seconds : undefined;
  const t0 = r.clock();
  const child = startRecorder({ ffmpeg: tools.ffmpeg, spawn: r.spawn, input, wav, detached: false, ...(seconds !== undefined ? { seconds } : {}) });

  if (seconds !== undefined) {
    r.log(`recording for ${seconds}s ...`);
    await child.exited;
  } else {
    r.log('recording ... press Enter (or Ctrl-C) to stop');
    const waitForStop = deps.waitForStop ?? defaultWaitForStop;
    const why = await Promise.race([waitForStop(), child.exited.then(() => 'exited' as const)]);
    if (why !== 'exited' && child.pid !== undefined) {
      await stopRecorder({
        pid: child.pid,
        isAlive: r.isAlive,
        kill: r.kill,
        alreadySignalled: why === 'sigint',
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
    }
    await child.exited;
  }
  const recordMs = r.clock() - t0;

  if (!(await wavHasAudio(wav))) {
    const err = child.stderr().trim().split('\n').slice(-3).join('\n');
    io.stderr(
      `lexicon voice: recording failed (no audio written)${err ? `: ${err}` : ''}\n` +
        (r.platform === 'darwin' ? '  Check that this terminal has Microphone permission: System Settings > Privacy & Security > Microphone.\n' : ''),
    );
    await fs.rm(wav, { force: true }).catch(() => undefined);
    return EXIT_ERROR;
  }

  try {
    r.log('transcribing ...');
    const result = await transcribeFile(wav, transcribeOptions(r, opts, deps, lexicon, tools.whisperCli));
    await fs.rm(wav, { force: true }).catch(() => undefined);
    return await deliver(result, recordMs, recordMs / 1000, opts, io, deps, r);
  } catch (e) {
    io.stderr(`lexicon voice: ${message(e)} (audio kept at ${wav})\n`);
    return e instanceof MissingToolError ? EXIT_MISSING_TOOL : EXIT_ERROR;
  }
}

// ---------------------------------------------------------------------------
// Toggle mode (hotkey)

/** How many times a start re-reads the state file after losing the claim before giving up. */
const CLAIM_ATTEMPTS = 3;

/** Start a detached recording, or stop the running one and transcribe it. Returns the exit code. */
export async function runVoiceToggle(opts: VoiceOptions, io: VoiceIO, deps: VoiceDeps = {}): Promise<number> {
  const r = resolve(opts, io, deps);
  // Read, decide, claim. Losing the claim means another toggle wrote the file
  // between our read and our create, so read again and decide again.
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const state = await readState(r.globalPath);
    if (state && state.pid !== undefined && r.isAlive(state.pid)) {
      return stopAndTranscribe(state as RecordingState & { pid: number }, opts, io, deps, r);
    }
    if (state && isProvisional(state) && !isStaleProvisional(state, r.now().getTime())) {
      // A start is in flight (double-tap): idempotent, let it finish.
      io.stdout('recording\n');
      return EXIT_OK;
    }
    if (state) {
      r.log(
        isProvisional(state)
          ? `stale recording state (a start that never spawned); starting a new recording`
          : `stale recording state (pid ${state.pid} is gone); starting a new recording`,
      );
      await clearState(r.globalPath);
      await fs.rm(state.wav, { force: true }).catch(() => undefined);
    }
    const outcome = await startDetached(opts, io, deps, r);
    if (outcome !== 'lost') return outcome;
  }
  io.stderr(`lexicon voice: could not claim ${stateFilePath(r.globalPath)} after ${CLAIM_ATTEMPTS} attempts; try again\n`);
  return EXIT_ERROR;
}

/** The second press: stop ffmpeg, transcribe the WAV, deliver. */
async function stopAndTranscribe(
  state: RecordingState & { pid: number },
  opts: VoiceOptions,
  io: VoiceIO,
  deps: VoiceDeps,
  r: Resolved,
): Promise<number> {
  const startedAt = Date.parse(state.startedAt);
  const stop = await stopRecorder({ pid: state.pid, isAlive: r.isAlive, kill: r.kill, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  const recordMs = Math.max(0, r.clock() - (Number.isFinite(startedAt) ? startedAt : r.clock()));
  await clearState(r.globalPath);
  if (stop.killed) r.log('recorder did not stop within 3s; killed (the WAV may be truncated)');

  const tools = await requireTools(r, io, deps, { ffmpeg: false, whisper: true });
  if (!tools) return EXIT_MISSING_TOOL;

  if (!(await wavHasAudio(state.wav))) {
    io.stderr(
      `lexicon voice: recording failed (no audio written to ${state.wav})\n` +
        (r.platform === 'darwin' ? '  Check that the app running this command has Microphone permission: System Settings > Privacy & Security > Microphone.\n' : '') +
        `  ffmpeg log: ${recorderLogPath(r.globalPath)}\n`,
    );
    await fs.rm(state.wav, { force: true }).catch(() => undefined);
    return EXIT_ERROR;
  }

  let lexicon: Lexicon;
  try {
    lexicon = await loadMerged(r, opts);
  } catch (e) {
    io.stderr(`lexicon voice: ${message(e)} (audio kept at ${state.wav})\n`);
    return EXIT_ERROR;
  }
  try {
    r.log('transcribing ...');
    const result = await transcribeFile(state.wav, transcribeOptions(r, opts, deps, lexicon, tools.whisperCli));
    await fs.rm(state.wav, { force: true }).catch(() => undefined);
    return await deliver(result, recordMs, recordMs / 1000, opts, io, deps, r);
  } catch (e) {
    io.stderr(`lexicon voice: ${message(e)} (audio kept at ${state.wav})\n`);
    return e instanceof MissingToolError ? EXIT_MISSING_TOOL : EXIT_ERROR;
  }
}

/**
 * The first press: claim the state file, spawn the detached recorder, record
 * its pid. Returns 'lost' when another toggle claimed the file first; the
 * caller re-reads. A spawn that fails removes the provisional record so the
 * next press starts cleanly.
 */
async function startDetached(opts: VoiceOptions, io: VoiceIO, deps: VoiceDeps, r: Resolved): Promise<number | 'lost'> {
  const tools = await requireTools(r, io, deps, { ffmpeg: true, whisper: true });
  if (!tools) return EXIT_MISSING_TOOL;

  let input;
  try {
    input = await resolveInput({ platform: r.platform, ffmpeg: tools.ffmpeg, exec: r.exec, ...(opts.device ? { device: opts.device } : {}) });
  } catch (e) {
    io.stderr(`lexicon voice: ${message(e)}\n`);
    return EXIT_ERROR;
  }

  const dir = await ensureVoiceDir(r.globalPath);
  const startedAt = r.now();
  const wav = path.join(dir, `recording-${startedAt.toISOString().replace(/[:.]/g, '-')}.wav`);
  const provisional: RecordingState = { wav, startedAt: startedAt.toISOString() };
  if (!(await claimState(r.globalPath, provisional))) return 'lost';

  const seconds = opts.seconds !== undefined && opts.seconds > 0 ? Math.min(opts.seconds, MAX_TOGGLE_SECONDS) : MAX_TOGGLE_SECONDS;
  const logFile = recorderLogPath(r.globalPath);
  let child: ChildHandle;
  try {
    // Both files exist 0600 before ffmpeg touches them; ffmpeg keeps the mode.
    await touchPrivateFile(wav);
    await touchPrivateFile(logFile);
    child = startRecorder({ ffmpeg: tools.ffmpeg, spawn: r.spawn, input, wav, seconds, detached: true, logFile });
    if (child.pid === undefined) throw new Error('could not start ffmpeg');
  } catch (e) {
    await clearState(r.globalPath);
    await fs.rm(wav, { force: true }).catch(() => undefined);
    io.stderr(`lexicon voice: ${message(e)}\n`);
    return EXIT_ERROR;
  }
  await writeState(r.globalPath, { pid: child.pid, wav, startedAt: startedAt.toISOString() });
  io.stdout('recording\n');
  return EXIT_OK;
}

// ---------------------------------------------------------------------------
// Status and devices

/** Print `recording since <time>` (exit 0) or `idle` (exit 1). */
export async function runVoiceStatus(opts: VoiceOptions, io: VoiceIO, deps: VoiceDeps = {}): Promise<number> {
  const r = resolve(opts, io, deps);
  const state = await readState(r.globalPath);
  const recording = state !== undefined && state.pid !== undefined && r.isAlive(state.pid);
  if (opts.json) {
    io.stdout(`${JSON.stringify(recording && state ? { recording: true, since: state.startedAt, pid: state.pid } : { recording: false })}\n`);
  } else {
    io.stdout(recording && state ? `recording since ${state.startedAt}\n` : 'idle\n');
  }
  return recording ? EXIT_OK : EXIT_ERROR;
}

/** Print the audio input devices ffmpeg can see. */
export async function runVoiceListDevices(opts: VoiceOptions, io: VoiceIO, deps: VoiceDeps = {}): Promise<number> {
  const r = resolve(opts, io, deps);
  const tools = await requireTools(r, io, deps, { ffmpeg: true, whisper: false });
  if (!tools) return EXIT_MISSING_TOOL;
  try {
    const devices = await listAudioDevices({ platform: r.platform, ffmpeg: tools.ffmpeg, exec: r.exec });
    if (opts.json) io.stdout(`${JSON.stringify(devices)}\n`);
    else io.stdout(formatDeviceList(devices));
    return EXIT_OK;
  } catch (e) {
    io.stderr(`lexicon voice: could not list devices: ${message(e)}\n`);
    return EXIT_ERROR;
  }
}
