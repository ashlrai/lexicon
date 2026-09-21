/**
 * Process seam for the voice pipeline. Everything that touches a microphone,
 * a binary or a pid goes through these injectable functions so tests never
 * spawn ffmpeg or whisper-cli.
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { locateTool } from '../util/which.js';
import type { LocateOptions } from '../util/which.js';

export interface ExecResult {
  /** Exit code, or null when the process was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Payload written to stdin (then closed). */
  stdin?: string;
  /** Kill the child after this many milliseconds (resolves with code null). */
  timeoutMs?: number;
}

/**
 * Run `cmd` to completion and resolve with its exit code and output. Rejects
 * only when the process cannot be started (a missing binary surfaces as an
 * Error with `code: 'ENOENT'`); a non-zero exit is a resolved result.
 */
export type VoiceExec = (cmd: string, args: readonly string[], opts?: ExecOptions) => Promise<ExecResult>;

/** A long-running child (the recorder). */
export interface ChildHandle {
  pid: number | undefined;
  /** Resolves with the exit code when the child exits (never rejects). */
  exited: Promise<number | null>;
  /** Stderr collected while attached (empty for detached children). */
  stderr: () => string;
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnOptions {
  /**
   * Detach the child from this process (own process group, stdio not
   * inherited, unref'd) so it survives our exit. Used by `--toggle`.
   */
  detached: boolean;
  /** Where a detached child's stderr goes (appended). Ignored when attached. */
  logFile?: string;
}

/** Start a long-running child. Must throw synchronously or reject via `exited` when the binary is missing. */
export type VoiceSpawn = (cmd: string, args: readonly string[], opts: SpawnOptions) => ChildHandle;

const MAX_OUTPUT = 16 * 1024 * 1024;

export function defaultExec(cmd: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    };
    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        child.kill();
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (size + chunk.length <= MAX_OUTPUT) err.push(chunk);
    });
    child.once('close', (code) => finish(code));
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    }
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.once('error', () => undefined);
      child.stdin.end(opts.stdin, 'utf8');
    }
  });
}

export function defaultSpawn(cmd: string, args: readonly string[], opts: SpawnOptions): ChildHandle {
  const errChunks: Buffer[] = [];
  let stderrFd: number | 'ignore' = 'ignore';
  if (opts.detached && opts.logFile) {
    try {
      // 0600: the log can echo device names and paths; voice.ts pre-creates it with the same mode.
      stderrFd = openSync(opts.logFile, 'a', 0o600);
    } catch {
      stderrFd = 'ignore';
    }
  }
  const child = spawn(cmd, [...args], {
    detached: opts.detached,
    stdio: ['ignore', 'ignore', opts.detached ? stderrFd : 'pipe'],
    windowsHide: true,
  });
  const exited = new Promise<number | null>((resolve) => {
    let done = false;
    const settle = (code: number | null): void => {
      if (done) return;
      done = true;
      resolve(code);
    };
    child.once('error', () => settle(null));
    child.once('exit', (code) => settle(code));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (errChunks.length < 256) errChunks.push(chunk);
  });
  if (opts.detached) child.unref();
  return {
    pid: child.pid,
    exited,
    stderr: () => Buffer.concat(errChunks).toString('utf8'),
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    },
  };
}

/** True when a process with this pid exists (EPERM counts as alive). */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function defaultKill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

/**
 * Directories searched after PATH. Hotkey launchers (Raycast, Hammerspoon,
 * Karabiner, launchd) often run with a minimal PATH that lacks Homebrew.
 */
/**
 * PATH lookup lives in src/util/which.ts; re-exported here because this is
 * where the voice pipeline's callers (and `lexicon doctor`) look for it.
 */
export { WELL_KNOWN_BIN_DIRS, locateTool, locateToolSync } from '../util/which.js';
export type { LocateOptions } from '../util/which.js';

/** Names tried for whisper.cpp's CLI, in order; `LEXICON_WHISPER_BIN` wins over all of them. */
export const WHISPER_BIN_NAMES: readonly string[] = ['whisper-cli', 'whisper-cpp'];

export const INSTALL_HINTS: Readonly<Record<'darwin' | 'linux' | 'win32' | 'other', string>> = {
  darwin: 'brew install ffmpeg whisper-cpp',
  linux: 'sudo apt install ffmpeg, then build whisper.cpp (https://github.com/ggml-org/whisper.cpp) and set LEXICON_WHISPER_BIN=/path/to/whisper-cli',
  win32: 'winget install Gyan.FFmpeg, then download whisper.cpp binaries and set LEXICON_WHISPER_BIN=C:\\path\\to\\whisper-cli.exe',
  other: 'install ffmpeg and whisper.cpp, then set LEXICON_WHISPER_BIN=/path/to/whisper-cli',
};

export function installHint(platform: NodeJS.Platform): string {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return INSTALL_HINTS[platform];
  return INSTALL_HINTS.other;
}

/** Resolve whisper-cli: `LEXICON_WHISPER_BIN` (any name, e.g. `main` from a checkout), else PATH lookup. */
export async function locateWhisperCli(opts: LocateOptions = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const override = env.LEXICON_WHISPER_BIN;
  if (override) {
    const exists = opts.exists ?? (async (p: string) => existsSync(p));
    return (await exists(override)) ? override : undefined;
  }
  return locateTool(WHISPER_BIN_NAMES, opts);
}

export async function locateFfmpeg(opts: LocateOptions = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const override = env.LEXICON_FFMPEG_BIN;
  if (override) {
    const exists = opts.exists ?? (async (p: string) => existsSync(p));
    return (await exists(override)) ? override : undefined;
  }
  return locateTool(['ffmpeg'], opts);
}

/**
 * Is a live pid really the recorder we spawned, and can an orphan be found?
 *
 * Two problems need the same answer. A pid is only unique while its process
 * lives: once the recorder exits, the operating system is free to hand that
 * number to anything, and `defaultIsAlive` then reports our recorder is running
 * when it is really someone else's process about to receive our stop signal.
 * And a start that dies between spawning ffmpeg and recording its pid leaves a
 * recorder nothing can stop, because the number was never written down.
 *
 * Asking what a pid is actually running settles both. The check is one process
 * listing on the stop path, which is nothing beside the transcription that
 * follows it, and the recorder's own WAV filename carries a timestamp, so it
 * identifies our capture without having to match a whole path across platforms.
 */
export type ProcessDescribe = (pid: number) => Promise<string | undefined>;
/**
 * The process table, or `undefined` when it could not be read.
 *
 * The distinction is the whole point of the type. A host with no `ps` (a
 * stripped container, a sandbox that refuses the exec) cannot answer the
 * question at all, and answering it with an empty array turns "I cannot tell"
 * into "nothing is running", which is how a caller ends up abandoning a live
 * recording. An empty array means the table was read and holds nothing.
 */
export type ProcessList = () => Promise<ReadonlyArray<{ pid: number; command: string }> | undefined>;

/**
 * How wide a PowerShell line may be before it is folded.
 *
 * PowerShell formats its output for a console, which means wrapping a long
 * line at the window width rather than letting it run. A recorder's command
 * line is long and ends in the capture's path, so the fold lands in the middle
 * of the one thing worth matching on, and `parseProcessLines` then drops the
 * continuation (no pid at the front of it). Asking for a width nothing reaches
 * is what keeps the line whole.
 */
const PS_WIDTH = 32_767;

/** `ps`/`Get-CimInstance` invocations, kept here so both helpers agree. */
function listCommand(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    return {
      cmd: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // The filter is a literal, so no caller-supplied path is ever
        // interpolated into a shell; the matching happens in JavaScript.
        `Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" } | Out-String -Width ${PS_WIDTH}`,
      ],
    };
  }
  return { cmd: 'ps', args: ['-A', '-o', 'pid=,command='] };
}

function parseProcessLines(stdout: string): Array<{ pid: number; command: string }> {
  const out: Array<{ pid: number; command: string }> = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (Number.isFinite(pid)) out.push({ pid, command: match[2].trim() });
  }
  return out;
}

/**
 * Every running process. `undefined` when the listing could not be run or
 * failed, which is a different answer from an empty table: see `ProcessList`.
 */
export function makeProcessList(exec: VoiceExec, platform: NodeJS.Platform): ProcessList {
  return async () => {
    const { cmd, args } = listCommand(platform);
    try {
      const res = await exec(cmd, args, { timeoutMs: 5000 });
      if (res.code !== 0) return undefined;
      return parseProcessLines(res.stdout);
    } catch {
      return undefined;
    }
  };
}

/** The command line behind one pid, or undefined when it cannot be read. */
export function makeProcessDescribe(exec: VoiceExec, platform: NodeJS.Platform): ProcessDescribe {
  return async (pid: number) => {
    const win = platform === 'win32';
    const cmd = win ? 'powershell' : 'ps';
    // `pid` is a number we validated on the way in, so interpolating it is safe.
    const args = win
      ? [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine | Out-String -Width ${PS_WIDTH}`,
        ]
      : ['-p', String(pid), '-o', 'command='];
    try {
      const res = await exec(cmd, args, { timeoutMs: 5000 });
      if (res.code !== 0) return undefined;
      const text = res.stdout.trim();
      return text.length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  };
}
