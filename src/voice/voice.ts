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
 *   transcribes and outputs. A recorder that is gone by the second press (it
 *   hit the ten-minute cap, or crashed) is not a mess to sweep up: its capture
 *   is transcribed like any other, and a capture with no audio in it is
 *   reported rather than silently replaced.
 *   The start is atomic: the state file is claimed with an exclusive create
 *   before ffmpeg spawns, so two presses that race start one recorder (the
 *   loser prints `recording` and exits 0).
 *
 * Every process interaction goes through `VoiceDeps` so tests never touch a
 * microphone. Exit codes: 0 ok, 1 error, 2 ffmpeg/whisper-cli missing,
 * 3 nothing heard.
 *
 * Under `--json` stdout carries exactly one document on every path: the
 * result (`ok: true`), a toggle status line, or `VoiceJsonFailure` (`ok:
 * false, error, nextStep?, code`) for every non-zero exit. The stderr lines
 * and the exit codes are the same with or without `--json`.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffSummary, loadLexicon, recordHits, resolvePaths, sanitizeForDisplay } from '../core/index.js';
import type { Lexicon, LoadedLexicon } from '../core/index.js';
import { PASTE_APPLESCRIPT, emptyLexiconHint } from '../daemon/clipboard.js';
import { ExecError, detectClipboardBackend } from '../daemon/clipboard-backends.js';
import type { ClipboardExec } from '../daemon/clipboard-backends.js';
import { formatDeviceList, listAudioDevices } from './devices.js';
import { appendHistory } from './history.js';
import { DEFAULT_MODEL, isModelPath, resolveModel } from './models.js';
import type { Downloader } from './models.js';
import {
  defaultExec,
  defaultIsAlive,
  defaultKill,
  makeProcessDescribe,
  makeProcessList,
  defaultSpawn,
  installHint,
  locateFfmpeg,
  locateWhisperCli,
} from './process.js';
import type { ChildHandle, ProcessDescribe, ProcessList, VoiceExec, VoiceSpawn } from './process.js';
import {
  MAX_TOGGLE_SECONDS,
  captureSeconds,
  claimState,
  claimStop,
  clearState,
  ensureVoiceDir,
  inspectWav,
  isProvisional,
  isStaleProvisional,
  readState,
  recorderLogPath,
  resolveInput,
  startRecorder,
  stateFilePath,
  stopRecorder,
  sweepVoiceDir,
  touchPrivateFile,
  voiceDir,
  writeState,
  confirmRecorder,
  findOrphanRecorder,
} from './recorder.js';
import type { RecordingState, WavCheck } from './recorder.js';
import { MissingToolError, WhisperExitError, transcribeFile } from './transcribe.js';
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
  /** What a pid is running, for telling our recorder from a recycled number. */
  describeProcess?: ProcessDescribe;
  /** The process table, for finding a recorder whose pid was never recorded. */
  listProcesses?: ProcessList;
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
  /** True for a delivered transcription; a failed one carries the `VoiceJsonFailure` keys instead. */
  ok: boolean;
  raw: string;
  output: string;
  replacements: TranscribeResult['normalized']['replacements'];
  summary: string;
  model: string;
  seconds: number;
  ms: { record: number; transcribe: number; normalize: number };
}

/**
 * The `--json` stdout document of a voice run that exited non-zero. `code` is
 * the exit code (1 error, 2 ffmpeg/whisper-cli missing, 3 nothing heard).
 * A transcription that was made but not delivered (nothing heard, a clipboard
 * or paste failure) is the `VoiceJsonResult` with these keys over it, so the
 * text is not lost; every other failure is this object alone.
 */
export interface VoiceJsonFailure {
  ok: false;
  error: string;
  nextStep?: string;
  code: number;
}

interface Resolved {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exec: VoiceExec;
  spawn: VoiceSpawn;
  isAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  describeProcess: ProcessDescribe;
  listProcesses: ProcessList;
  cwd: string;
  globalPath: string;
  tmpDir: string;
  now: () => Date;
  clock: () => number;
  log: (s: string) => void;
  /** Carriage-return progress updates (model download). */
  progress: (s: string) => void;
  /** The failure a non-zero exit reports under --json (set by `failed`). */
  failure?: { error: string; nextStep?: string };
  /** Whether a document already went to stdout, so a failure does not add a second one. */
  printed: boolean;
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
    describeProcess: deps.describeProcess ?? makeProcessDescribe(deps.exec ?? defaultExec, deps.platform ?? process.platform),
    listProcesses: deps.listProcesses ?? makeProcessList(deps.exec ?? defaultExec, deps.platform ?? process.platform),
    cwd,
    globalPath,
    tmpDir: deps.tmpDir ?? os.tmpdir(),
    now: deps.now ?? (() => new Date()),
    clock: deps.clock ?? Date.now,
    log: opts.quiet ? () => undefined : (s: string) => io.stderr(`${s}\n`),
    progress: opts.quiet ? () => undefined : (s: string) => io.stderr(`\r${s}`),
    printed: false,
  };
}

/** Record what a non-zero exit failed on, for the --json failure document, and return `code`. */
function failed(r: Resolved, code: number, error: string, nextStep?: string): number {
  r.failure = { error, ...(nextStep ? { nextStep } : {}) };
  return code;
}

/**
 * A failure with a next step: `lexicon voice: <error>` and the indented step
 * on stderr, and both in the --json document. The step went only to --json
 * before, so a terminal user saw the error alone. A step the error already
 * names (a dshow error that says `--list-devices`) is not repeated.
 */
function refuseWith(r: Resolved, io: VoiceIO, error: string, nextStep: string): number {
  const repeated = nextStep === DEVICE_HINT && error.includes('--list-devices');
  io.stderr(`lexicon voice: ${error}\n${repeated ? '' : `  ${nextStep}\n`}`);
  return failed(r, EXIT_ERROR, error, nextStep);
}

function jsonFailure(code: number, error: string, nextStep?: string): VoiceJsonFailure {
  return { ok: false, error, ...(nextStep ? { nextStep } : {}), code };
}

/**
 * Run one voice entry point so that under --json a non-zero exit always leaves
 * one document on stdout. The body's stdout is tracked; when it printed
 * nothing, the recorded failure (or an unexpected exception, reported on
 * stderr as well) becomes the `VoiceJsonFailure`.
 */
async function runReported(
  opts: VoiceOptions,
  io: VoiceIO,
  deps: VoiceDeps,
  body: (io: VoiceIO, r: Resolved) => Promise<number>,
): Promise<number> {
  const r = resolve(opts, io, deps);
  const tracked: VoiceIO = {
    stdout: (s) => {
      r.printed = true;
      io.stdout(s);
    },
    stderr: (s) => io.stderr(s),
  };
  let code: number;
  try {
    code = await body(tracked, r);
  } catch (e) {
    io.stderr(`lexicon voice: ${message(e)}\n`);
    code = failed(r, EXIT_ERROR, message(e));
  }
  if (opts.json && code !== EXIT_OK && !r.printed) {
    const f = r.failure ?? { error: `lexicon voice exited ${code}` };
    tracked.stdout(`${JSON.stringify(jsonFailure(code, f.error, f.nextStep))}\n`);
  }
  return code;
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
  if (ffmpeg && whisperCli) return { ffmpeg, whisperCli };
  // A set override that points nowhere is a typo to fix, not a missing
  // install: it is named on its own, and PATH (never searched for it) is not.
  const overrides = [
    ...(!whisperCli && r.env.LEXICON_WHISPER_BIN ? [{ tool: 'whisper-cli', name: 'LEXICON_WHISPER_BIN', value: r.env.LEXICON_WHISPER_BIN }] : []),
    ...(!ffmpeg && r.env.LEXICON_FFMPEG_BIN ? [{ tool: 'ffmpeg', name: 'LEXICON_FFMPEG_BIN', value: r.env.LEXICON_FFMPEG_BIN }] : []),
  ];
  const which = { ffmpeg: !ffmpeg && !r.env.LEXICON_FFMPEG_BIN, whisper: !whisperCli && !r.env.LEXICON_WHISPER_BIN };
  const onPath = [...(which.ffmpeg ? ['ffmpeg'] : []), ...(which.whisper ? ['whisper-cli'] : [])];
  const errors = [
    ...(onPath.length > 0 ? [`${onPath.join(' and ')} not found on PATH`] : []),
    ...overrides.map((o) => `${o.name}=${o.value} does not exist`),
  ];
  const install = onPath.length > 0 ? installSteps(r.platform, which) : [];
  // The install hint still follows: an override can point nowhere because the
  // tool was never installed there.
  const repoint = overrides.map(
    (o) =>
      `point ${o.name} at the ${o.tool} binary, or unset it to look on PATH (to install ${o.tool}: ${installHint(r.platform, { ffmpeg: o.tool === 'ffmpeg', whisper: o.tool === 'whisper-cli' })})`,
  );
  io.stderr(`lexicon voice: ${errors.join('; ')}.\n${[...install, ...repoint].map((step) => `  ${step}\n`).join('')}`);
  failed(r, EXIT_MISSING_TOOL, errors.join('; '), [...(install.length > 0 ? [install.join(' ')] : []), ...repoint].join('; '));
  return undefined;
}

/**
 * `install: <hint>` and, for each override the hint does not already name,
 * `(or set <VAR> to the binary)`: the Linux whisper hint already says to set
 * LEXICON_WHISPER_BIN, so it is not said twice.
 */
function installSteps(platform: NodeJS.Platform, which: { ffmpeg: boolean; whisper: boolean }): string[] {
  const hint = installHint(platform, which);
  const vars = [...(which.whisper ? ['LEXICON_WHISPER_BIN'] : []), ...(which.ffmpeg ? ['LEXICON_FFMPEG_BIN'] : [])].filter((v) => !hint.includes(`${v}=`));
  return [`install: ${hint}`, ...(vars.length > 0 ? [`(or set ${vars.join(' / ')} to the binary)`] : [])];
}

/**
 * The load the corrections come from. Only its merged terms (the whisper
 * prompt and the normalize) and its global and trusted project files (handed
 * to `recordHits`) are used, so an untrusted or changed project file is never
 * parsed (`parseSkipped: false`).
 */
async function loadForVoice(r: Resolved, opts: VoiceOptions): Promise<LoadedLexicon> {
  return loadLexicon({ cwd: r.cwd, ...(opts.globalPath ? { globalPath: opts.globalPath } : {}), parseSkipped: false });
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
  loaded?: LoadedLexicon,
): Promise<number> {
  if (result.raw.length === 0) {
    if (opts.json) {
      const failure = jsonFailure(
        EXIT_NOTHING_HEARD,
        'nothing heard',
        'whisper read nothing out of the recording; a wrong --lang or a model too small for the speaker look the same as silence, so check those and speak closer to the microphone',
      );
      io.stdout(`${JSON.stringify({ ...jsonResult(result, recordMs, seconds), ...failure })}\n`);
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
    // `loaded` (the load the corrections came from) spares recordHits reading
    // both lexicon files again, and it holds a project file only when trusted.
    await recordHits(canonicals, { cwd: r.cwd, ...(opts.globalPath ? { globalPath: opts.globalPath } : {}), ...(loaded ? { loaded } : {}) }).catch((e: unknown) => {
      r.log(`lexicon voice: recordHits: ${message(e)}`);
    });
    r.log(`${result.normalized.replacements.length} correction${result.normalized.replacements.length === 1 ? '' : 's'}: ${diffSummary(result.normalized).replace(/\n/g, '; ')}`);
  } else {
    // A first run with no terms printed the raw transcript as if the lexicon
    // had looked at it and found nothing, naming no way to add a term.
    const hint = loaded ? emptyLexiconHint(loaded) : undefined;
    if (hint) r.log(`lexicon voice: nothing was corrected: ${hint}`);
  }

  // Under --json the one document waits for the clipboard and paste steps, so
  // a failure there is reported in it (with the text) rather than after it.
  const printJson = (failure?: VoiceJsonFailure): void => {
    if (opts.json) io.stdout(`${JSON.stringify({ ...jsonResult(result, recordMs, seconds), ...failure })}\n`);
  };
  if (!opts.json) io.stdout(`${result.output}\n`);

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
      printJson(jsonFailure(EXIT_ERROR, `could not copy to the clipboard: ${message(e)}`, 'the corrected text is in output; run `lexicon doctor` to check the clipboard backend'));
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
      printJson(
        jsonFailure(
          EXIT_ERROR,
          `--paste failed: ${message(e)}`,
          'give the app that runs this command Accessibility permission: System Settings > Privacy & Security > Accessibility. The text is on the clipboard.',
        ),
      );
      return EXIT_ERROR;
    }
  }
  printJson();
  return EXIT_OK;
}

export function jsonResult(result: TranscribeResult, recordMs: number, seconds: number): VoiceJsonResult {
  return {
    ok: true,
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
// What happens to a capture we will not transcribe

/**
 * Decide what to do with a capture `inspectWav` refused, and say it.
 *
 * The file is removed only when there is nothing in it to lose: no file at all,
 * or zero bytes (the placeholder `touchPrivateFile` creates before ffmpeg is
 * spawned, which is exactly what a recorder that never started leaves behind).
 * Anything else is kept and named. A refusal is this process's reading of a
 * container, and a reading is not a reason to destroy someone's audio: the
 * parser has been wrong before (a `data` header past the first 4 KB, a chunk
 * whose writer skipped the RIFF pad byte), and when it is wrong again the
 * recording should still be sitting on disk.
 */
async function discardOrKeep(capture: WavCheck, wav: string): Promise<string> {
  if (capture.bytes === 0) {
    await fs.rm(wav, { force: true }).catch(() => undefined);
    return '';
  }
  return `  the ${capture.bytes} bytes that were written are kept at ${wav}\n`;
}

/** Microphone-permission hint, which on macOS is the usual reason nothing was recorded. */
function micPermissionHint(r: Resolved, launcher: string): string {
  return r.platform === 'darwin'
    ? `  Check that ${launcher} has Microphone permission: System Settings > Privacy & Security > Microphone.\n`
    : '';
}

/** The --json `nextStep` for an input device ffmpeg could not resolve. */
const DEVICE_HINT = 'run `lexicon voice --list-devices` and pass one of them with --device <name|index>';

/**
 * An explicit `--model <path>` that is not there, checked before anything is
 * recorded. It was found only once whisper was about to run, so the user spoke
 * into a recording that could not be transcribed. A model name is not checked
 * here: a missing one is downloaded at transcription time.
 */
function refuseMissingModelPath(opts: VoiceOptions, io: VoiceIO, r: Resolved): number | undefined {
  const spec = opts.model ?? DEFAULT_MODEL;
  if (!isModelPath(spec)) return undefined;
  const model = resolveModel(spec, { globalPath: r.globalPath, env: r.env });
  if (model.present) return undefined;
  const error = `whisper model not found: ${model.path}`;
  const nextStep = 'pass an existing ggml model file, or a model name like base.en to download it, with --model';
  io.stderr(`lexicon voice: ${error}\n  ${nextStep}\n`);
  return failed(r, EXIT_ERROR, error, nextStep);
}

/** The --json `error` of a capture with no usable audio: the parser's reason and ffmpeg's last line. */
function recordingFailedError(reason: string | undefined, tail: string): string {
  const last = tail.split('\n').pop()?.trim();
  return `recording failed (${reason ?? 'no audio'})${last ? `; ffmpeg said: ${last}` : ''}`;
}

/** The --json `nextStep` of a capture with no usable audio. */
function recordingFailedNextStep(r: Resolved, launcher: string): string {
  return r.platform === 'darwin'
    ? `check that ${launcher} has Microphone permission (System Settings > Privacy & Security > Microphone), then try again`
    : 'check the input device (`lexicon voice --list-devices`, then --device <name|index>) and try again';
}

/**
 * The last few lines of ffmpeg's stderr, each sanitized for a terminal and
 * indented under `ffmpeg said:`. Sanitizing line by line keeps the line
 * breaks, which sanitizing the joined text would strip.
 */
function stderrTail(text: string, lines = 3): string {
  return text
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .map((line) => sanitizeForDisplay(line).trim())
    .filter((line) => line.length > 0)
    .join('\n  ');
}

/** The last few lines of a detached recorder's stderr log, sanitized for a terminal. */
async function recorderLogTail(r: Resolved, lines = 3): Promise<string> {
  try {
    return stderrTail(await fs.readFile(recorderLogPath(r.globalPath), 'utf8'), lines);
  } catch {
    return '';
  }
}

/**
 * Remove a capture whisper has finished with, unless it found nothing in it.
 *
 * An empty transcript is not a statement that the microphone heard nothing. It
 * is what arrives here when `--lang` names the wrong language, when the model
 * is too small for the speaker or the room, and whenever whisper tags the whole
 * capture `[BLANK_AUDIO]`, which `cleanTranscript` then strips to the empty
 * string. All of those are recoverable by running the audio through whisper
 * again with different settings, and none of them are recoverable once the file
 * is gone. Ten minutes of speech, 19 MB of it, went this way: exit 3,
 * `(nothing heard)`, nothing on disk.
 *
 * So the capture is removed only when it was replaced by something. A
 * transcript of nothing keeps it, and says where it is.
 */
async function keepOrRemoveTranscribed(result: TranscribeResult, wav: string, io: VoiceIO, keepBecause?: string): Promise<void> {
  if (result.raw.length === 0) {
    io.stderr(
      `lexicon voice: whisper read nothing out of this capture, so the recording is kept at ${wav}\n` +
        '  A wrong --lang, or a model too small for the speaker, both look exactly like silence. The audio is still there to try again with.\n',
    );
    return;
  }
  if (keepBecause !== undefined) {
    io.stderr(`lexicon voice: ${keepBecause}; the recording is kept at ${wav}\n`);
    return;
  }
  await fs.rm(wav, { force: true }).catch(() => undefined);
}

/**
 * Transcribe a capture that is already on disk and deliver it. Shared by the
 * stop half of `--toggle` and by the recovery of a recorder that is no longer
 * running. The WAV is removed only once whisper has read something out of it;
 * every failure, and every empty transcript, keeps it and names it.
 *
 * `keepBecause` is set by a caller that cannot rule out a recorder still
 * writing this capture; it keeps the file whatever whisper made of it.
 */
async function transcribeCapture(
  wav: string,
  timing: { recordMs: number; seconds: number; keepBecause?: string },
  opts: VoiceOptions,
  io: VoiceIO,
  deps: VoiceDeps,
  r: Resolved,
): Promise<number> {
  const { recordMs, seconds } = timing;
  // ffmpeg is not needed here: the recording exists.
  const tools = await requireTools(r, io, deps, { ffmpeg: false, whisper: true });
  if (!tools) {
    // The audio outlives the missing transcriber; say where it is.
    io.stderr(`lexicon voice: the recording is kept at ${wav}\n`);
    return failed(r, EXIT_MISSING_TOOL, `${r.failure?.error ?? 'whisper-cli not found'} (audio kept at ${wav})`, r.failure?.nextStep);
  }
  let loaded: LoadedLexicon;
  try {
    loaded = await loadForVoice(r, opts);
  } catch (e) {
    return refuseWith(r, io, `${message(e)} (audio kept at ${wav})`, 'fix the lexicon file (`lexicon doctor` names the problem), then transcribe the kept audio');
  }
  try {
    r.log('transcribing ...');
    const result = await transcribeFile(wav, transcribeOptions(r, opts, deps, loaded.merged, tools.whisperCli));
    await keepOrRemoveTranscribed(result, wav, io, timing.keepBecause);
    return await deliver(result, recordMs, seconds, opts, io, deps, r, loaded);
  } catch (e) {
    return transcribeFailed(r, io, e, wav, opts);
  }
}

/** `arg` as one shell word: bare when it is plainly safe, else single-quoted. */
function shellWord(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The next step for a whisper-cli that ran and exited non-zero: the command
 * that reproduces it with whisper's whole output, and what to do about the
 * model, the usual cause (a truncated or wrong file). A downloaded model
 * (a name like base.en) comes back when its file is removed; a --model path
 * is the user's own, so the step offers another one instead.
 */
function whisperExitStep(e: WhisperExitError, wav: string, spec: string): string {
  const rerun = `run \`${shellWord(e.whisperCli)} -m ${shellWord(e.modelPath)} -f ${shellWord(wav)}\` to see whisper's full output`;
  const model = isModelPath(spec)
    ? 'check that the model file is a whole ggml model, or pass another with --model <name|path>'
    : `if the model file is damaged, delete ${e.modelPath} so the next \`lexicon voice\` downloads it again, or pass another with --model <name|path>`;
  return `${rerun}; ${model}`;
}

/**
 * A whisper (or model) failure: the stderr line, the kept audio, exit 2 for a
 * missing binary else 1. A whisper-cli that exited non-zero also gets a next
 * step, on stderr and in --json (a download failure already names its own).
 */
function transcribeFailed(r: Resolved, io: VoiceIO, e: unknown, wav: string, opts: Pick<VoiceOptions, 'model'>): number {
  const missing = e instanceof MissingToolError;
  const step = missing
    ? installSteps(r.platform, { ffmpeg: false, whisper: true }).join(' ')
    : e instanceof WhisperExitError
      ? whisperExitStep(e, wav, opts.model ?? DEFAULT_MODEL)
      : undefined;
  io.stderr(`lexicon voice: ${message(e)} (audio kept at ${wav})\n${step && !missing ? `  ${step}\n` : ''}`);
  return failed(r, missing ? EXIT_MISSING_TOOL : EXIT_ERROR, `${message(e)} (audio kept at ${wav})`, step);
}

// ---------------------------------------------------------------------------
// Foreground mode

/** Record until Enter, Ctrl-C or `--seconds`, then transcribe, normalize and output. Returns the exit code. */
export async function runVoice(opts: VoiceOptions, io: VoiceIO, deps: VoiceDeps = {}): Promise<number> {
  return runReported(opts, io, deps, (tracked, r) => recordForeground(opts, tracked, deps, r));
}

async function recordForeground(opts: VoiceOptions, io: VoiceIO, deps: VoiceDeps, r: Resolved): Promise<number> {
  const tools = await requireTools(r, io, deps, { ffmpeg: true, whisper: true });
  if (!tools) return EXIT_MISSING_TOOL;
  const noModel = refuseMissingModelPath(opts, io, r);
  if (noModel !== undefined) return noModel;

  let loaded: LoadedLexicon;
  try {
    loaded = await loadForVoice(r, opts);
  } catch (e) {
    return refuseWith(r, io, message(e), 'fix the lexicon file (`lexicon doctor` names the problem), then run `lexicon voice` again');
  }

  let input;
  try {
    input = await resolveInput({ platform: r.platform, ffmpeg: tools.ffmpeg, exec: r.exec, ...(opts.device ? { device: opts.device } : {}) });
  } catch (e) {
    return refuseWith(r, io, message(e), DEVICE_HINT);
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
        platform: r.platform,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
    }
    await child.exited;
  }
  const recordMs = r.clock() - t0;

  const capture = await inspectWav(wav);
  if (!capture.ok) {
    const tail = stderrTail(child.stderr());
    io.stderr(
      `lexicon voice: recording failed (${capture.reason})\n` +
        micPermissionHint(r, 'this terminal') +
        (tail ? `  ffmpeg said: ${tail}\n` : '') +
        (await discardOrKeep(capture, wav)),
    );
    return failed(r, EXIT_ERROR, recordingFailedError(capture.reason, tail), recordingFailedNextStep(r, 'this terminal'));
  }

  try {
    r.log('transcribing ...');
    const result = await transcribeFile(wav, transcribeOptions(r, opts, deps, loaded.merged, tools.whisperCli));
    await keepOrRemoveTranscribed(result, wav, io);
    return await deliver(result, recordMs, recordMs / 1000, opts, io, deps, r, loaded);
  } catch (e) {
    return transcribeFailed(r, io, e, wav, opts);
  }
}

// ---------------------------------------------------------------------------
// Toggle mode (hotkey)

/** How many times a start re-reads the state file after losing the claim before giving up. */
const CLAIM_ATTEMPTS = 3;

/** Start a detached recording, or stop the running one and transcribe it. Returns the exit code. */
/**
 * What a toggle press that did not finish a transcription prints: the bare
 * word, or under --json `{"status":"recording"}` / `{"status":"stopping"}` so
 * stdout is JSON on every path (the finished press prints the result object).
 * The menu bar app reads either form.
 */
function toggleLine(status: 'recording' | 'stopping', opts: Pick<VoiceOptions, 'json'>): string {
  return opts.json ? `${JSON.stringify({ status })}\n` : `${status}\n`;
}

export async function runVoiceToggle(opts: VoiceOptions, io: VoiceIO, deps: VoiceDeps = {}): Promise<number> {
  return runReported(opts, io, deps, (tracked, r) => toggle(opts, tracked, deps, r));
}

async function toggle(opts: VoiceOptions, io: VoiceIO, deps: VoiceDeps, r: Resolved): Promise<number> {
  // Read, decide, claim. Losing the claim means another toggle wrote the file
  // between our read and our create, so read again and decide again.
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const state = await readState(r.globalPath);
    if (state && isProvisional(state) && !isStaleProvisional(state, r.now().getTime())) {
      // A start is in flight (double-tap): idempotent, let it finish.
      io.stdout(toggleLine('recording', opts));
      return EXIT_OK;
    }
    if (state) {
      // Whatever this press turns out to be, it takes over a recording that
      // already exists, so it claims the state file before touching it. Two
      // presses that arrive together would otherwise both stop the same
      // recorder and both deliver the same capture: two paste keystrokes into
      // whatever the user was typing in, for one thing said. Rename is atomic,
      // so exactly one of them gets past here.
      const claimed = await claimStop(r.globalPath);
      if (!claimed) {
        io.stdout(toggleLine('stopping', opts));
        return EXIT_OK;
      }
      if (isProvisional(claimed) && !isStaleProvisional(claimed, r.now().getTime())) {
        // A start claimed the file between our read and our rename. Put it
        // back, exclusively so a third press cannot be clobbered, and treat
        // this press as the double-tap it turned out to be.
        await claimState(r.globalPath, claimed).catch(() => false);
        io.stdout(toggleLine('recording', opts));
        return EXIT_OK;
      }
      const taken = await handleClaimedState(claimed, opts, io, deps, r);
      if (taken !== 'start') return taken;
    }
    const outcome = await startDetached(opts, io, deps, r);
    if (outcome !== 'lost') return outcome;
  }
  io.stderr(`lexicon voice: could not claim ${stateFilePath(r.globalPath)} after ${CLAIM_ATTEMPTS} attempts; try again\n`);
  return failed(r, EXIT_ERROR, `could not claim ${stateFilePath(r.globalPath)} after ${CLAIM_ATTEMPTS} attempts`, 'press the hotkey (or run `lexicon voice --toggle`) again');
}

/**
 * Act on a state file this press has claimed. Returns `'start'` when there is
 * nothing left to take over and the press should begin a new recording.
 *
 * The state file is already gone by the time this runs: `claimStop` took it,
 * which is both the exclusion and the clearing, so nothing below clears it
 * again. That matters, because a stop that cleared the state after stopping
 * could delete the record of a recording a *later* press had already started.
 */
async function handleClaimedState(
  state: RecordingState,
  opts: VoiceOptions,
  io: VoiceIO,
  deps: VoiceDeps,
  r: Resolved,
): Promise<number | 'start'> {
  if (state.pid === undefined) return recoverStaleStart(state, opts, io, deps, r);
  if (!r.isAlive(state.pid)) return recoverDeadRecorder(state as RecordingState & { pid: number }, opts, io, deps, r);

  // A pid is only unique while its process lives. Once the recorder exits, the
  // system is free to hand that number to anything, and a stale state file
  // would then send our stop signal to a stranger's process. Ask what the pid
  // is actually running. Undefined means the question could not be answered,
  // in which case assume it is ours, as this always used to.
  const mine = await confirmRecorder(state.pid, state.wav, r.describeProcess);
  if (mine !== false) return stopAndTranscribe(state as RecordingState & { pid: number }, opts, io, deps, r);

  // `describeProcess` says this pid is running something else. Usually it is:
  // the recorder exited and the number was recycled. But a command line that
  // was read back wrong says exactly the same thing, and then the recorder is
  // alive and still filling this capture. Ask the process table who is writing
  // it before believing the recording is over.
  const writer = await findOrphanRecorder(state.wav, r.listProcesses);
  if (typeof writer === 'number') {
    r.log(`pid ${state.pid} is not our recorder, but pid ${writer} is writing this capture; stopping that one`);
    return stopAndTranscribe({ ...state, pid: writer }, opts, io, deps, r);
  }
  r.log(`pid ${state.pid} belongs to something else now; the recorder is gone`);
  // The pid is still alive, and the only thing saying it is not the recorder is
  // the reading that sent us here. That is not enough to delete audio on: the
  // capture is transcribed and kept, so a recorder we failed to recognise is
  // not writing into a file we have already removed.
  return recoverDeadRecorder(
    state as RecordingState & { pid: number },
    opts,
    io,
    deps,
    r,
    `pid ${state.pid} is still running, so something may still be writing this capture`,
  );
}

/**
 * A start that claimed the state file and died before recording a pid.
 *
 * It may have spawned ffmpeg first, leaving a recorder that keeps writing and
 * that nothing can stop, because the number needed to signal it was never
 * written down. The process table still knows, and the capture's own filename
 * is in the command line that opened it.
 */
async function recoverStaleStart(
  state: RecordingState,
  opts: VoiceOptions,
  io: VoiceIO,
  deps: VoiceDeps,
  r: Resolved,
): Promise<number | 'start'> {
  const orphanPid = await findOrphanRecorder(state.wav, r.listProcesses);
  if (typeof orphanPid === 'number') {
    r.log(`a previous start left a recorder running (pid ${orphanPid}); stopping it and using its audio`);
    return stopAndTranscribe({ ...state, pid: orphanPid }, opts, io, deps, r);
  }

  const orphan = await inspectWav(state.wav);
  if (orphanPid === 'unknown' && orphan.ok) {
    // `undefined` from the process table is "I could not look", which is the
    // ordinary state of a host with no `ps` rather than an edge case. Reading
    // it as "nothing is writing this" is how minutes of recorded speech got
    // walked away from while a second recorder started on top of it. There is
    // audio in the file; transcribe it, and keep it, because the recorder that
    // wrote it may still be there.
    const seconds = captureSeconds(orphan.audioBytes);
    r.log(`a previous start left ${seconds}s of audio and no pid, and the process table cannot be read here; transcribing it`);
    return transcribeCapture(
      state.wav,
      { recordMs: Math.round(seconds * 1000), seconds, keepBecause: 'the process table cannot be read here, so a recorder may still be writing this capture' },
      opts,
      io,
      deps,
      r,
    );
  }

  // Nothing is writing it. Usually the WAV is the empty file the claim
  // created. Either way the audio is not ours to delete: keep what is
  // there and say so.
  r.log(`stale recording state (a start that never recorded its pid); starting a new recording`);
  if (orphan.bytes > 0) r.log(`the previous start left ${orphan.bytes} bytes at ${state.wav}; it is kept`);
  if (orphan.bytes === 0) await fs.rm(state.wav, { force: true }).catch(() => undefined);
  return 'start';
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
  const stop = await stopRecorder({ pid: state.pid, isAlive: r.isAlive, kill: r.kill, platform: r.platform, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
  const recordMs = Math.max(0, r.clock() - (Number.isFinite(startedAt) ? startedAt : r.clock()));
  if (stop.killed) r.log('recorder did not stop within 3s; killed (the WAV may be truncated)');

  const capture = await inspectWav(state.wav);
  if (!capture.ok) {
    const tail = await recorderLogTail(r);
    io.stderr(
      `lexicon voice: recording failed (${capture.reason})\n` +
        // Windows cannot interrupt ffmpeg, only terminate it, so say so here
        // rather than let the user hunt for a flush that was never possible.
        // How much that costs is the input buffer, not a fraction of a second:
        // dshow uses the device's default, typically a multiple of 500 ms.
        (stop.abrupt
          ? '  On Windows the recorder is terminated rather than asked to stop, so whatever DirectShow still held is lost: the device default is commonly half a second or more.\n'
          : '') +
        micPermissionHint(r, 'the app running this command') +
        (tail ? `  ffmpeg said: ${tail}\n` : '') +
        (await discardOrKeep(capture, state.wav)) +
        `  ffmpeg log: ${recorderLogPath(r.globalPath)}\n`,
    );
    return failed(r, EXIT_ERROR, recordingFailedError(capture.reason, tail), `${recordingFailedNextStep(r, 'the app running this command')}; ffmpeg log: ${recorderLogPath(r.globalPath)}`);
  }

  return transcribeCapture(state.wav, { recordMs, seconds: recordMs / 1000 }, opts, io, deps, r);
}

/**
 * The press that finds a recorder that is no longer running.
 *
 * This is not an empty state file to sweep up, and the old code treating it as
 * one silently deleted finished recordings. Every `--toggle` capture is spawned
 * with `-t MAX_TOGGLE_SECONDS`, so a recording nobody stopped **ends itself at
 * ten minutes** and leaves a complete, finalized WAV, ten minutes of the user's
 * speech, which the next press then removed without ever opening it. The same
 * branch catches a recorder that crashed partway (the device was unplugged) and
 * one that never started at all (no microphone permission), and for those it
 * used to print `recording` again and never say why nothing was happening.
 *
 * So: look at the capture. Audio is transcribed, whatever killed the recorder.
 * Nothing usable is reported, with ffmpeg's own last words, and only a file
 * with no bytes in it is deleted.
 *
 * `keepBecause` is how a caller that is not certain the recorder is dead says
 * so. This function's whole premise is that nothing is writing the capture any
 * more, and when the caller cannot vouch for that, the capture survives being
 * read.
 */
async function recoverDeadRecorder(
  state: RecordingState & { pid: number },
  opts: VoiceOptions,
  io: VoiceIO,
  deps: VoiceDeps,
  r: Resolved,
  keepBecause?: string,
): Promise<number> {
  const capture = await inspectWav(state.wav);
  if (capture.ok) {
    // Wall clock since `startedAt` would count the time the recorder was dead
    // as recording. The bytes cannot: 16 kHz mono s16 is 32000 bytes a second.
    const seconds = captureSeconds(capture.audioBytes);
    r.log(`the recorder (pid ${state.pid}) is no longer running; transcribing the ${seconds}s it recorded`);
    return transcribeCapture(
      state.wav,
      { recordMs: Math.round(seconds * 1000), seconds, ...(keepBecause !== undefined ? { keepBecause } : {}) },
      opts,
      io,
      deps,
      r,
    );
  }
  const tail = await recorderLogTail(r);
  io.stderr(
    `lexicon voice: the recorder (pid ${state.pid}) stopped on its own and left no audio (${capture.reason})\n` +
      (tail ? `  ffmpeg said: ${tail}\n` : '') +
      micPermissionHint(r, 'the app running this command') +
      (await discardOrKeep(capture, state.wav)) +
      `  ffmpeg log: ${recorderLogPath(r.globalPath)}\n` +
      '  Press the hotkey again to start a new recording.\n',
  );
  return failed(
    r,
    EXIT_ERROR,
    `the recorder (pid ${state.pid}) stopped on its own and left no audio (${capture.reason ?? 'no audio'})`,
    `press the hotkey (or run \`lexicon voice --toggle\`) again to start a new recording; ffmpeg log: ${recorderLogPath(r.globalPath)}`,
  );
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
  const noModel = refuseMissingModelPath(opts, io, r);
  if (noModel !== undefined) return noModel;

  let input;
  try {
    input = await resolveInput({ platform: r.platform, ffmpeg: tools.ffmpeg, exec: r.exec, ...(opts.device ? { device: opts.device } : {}) });
  } catch (e) {
    return refuseWith(r, io, message(e), DEVICE_HINT);
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
    return refuseWith(r, io, message(e), `check ffmpeg (\`${tools.ffmpeg} -version\`) and the input device (\`lexicon voice --list-devices\`), then try again`);
  }
  await writeState(r.globalPath, { pid: child.pid, wav, startedAt: startedAt.toISOString() });
  // Sweep what is provably worthless (zero-byte captures, a claim breadcrumb a
  // press that died mid-stop left behind) and count what is not. Captures with
  // audio in them are kept by every path that refuses one, so they accumulate;
  // saying how many there are is the honest half of that, and deleting them
  // would be one more way to lose a recording.
  const leftovers = await sweepVoiceDir(r.globalPath, wav, r.now().getTime()).catch(() => ({ kept: 0, bytes: 0 }));
  if (leftovers.kept > 0) {
    r.log(
      `${leftovers.kept} earlier recording${leftovers.kept === 1 ? '' : 's'} (${(leftovers.bytes / 1_000_000).toFixed(1)} MB) ${leftovers.kept === 1 ? 'is' : 'are'} still in ${voiceDir(r.globalPath)}; nothing here deletes them for you`,
    );
  }
  io.stdout(toggleLine('recording', opts));
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
  return runReported(opts, io, deps, (tracked, r) => listDevices(opts, tracked, r, deps));
}

async function listDevices(opts: VoiceOptions, io: VoiceIO, r: Resolved, deps: VoiceDeps): Promise<number> {
  const tools = await requireTools(r, io, deps, { ffmpeg: true, whisper: false });
  if (!tools) return EXIT_MISSING_TOOL;
  try {
    const devices = await listAudioDevices({ platform: r.platform, ffmpeg: tools.ffmpeg, exec: r.exec });
    if (opts.json) io.stdout(`${JSON.stringify(devices)}\n`);
    else io.stdout(formatDeviceList(devices));
    return EXIT_OK;
  } catch (e) {
    return refuseWith(r, io, `could not list devices: ${message(e)}`, `check ffmpeg with \`${tools.ffmpeg} -version\`, or skip the list and pass the device by name: lexicon voice --device <name>`);
  }
}
