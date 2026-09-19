/**
 * Clipboard daemon: polls the system clipboard, normalizes the text against
 * the lexicon and writes corrections back. Two modes:
 *
 * - loop (`lexicon daemon`): poll every 250ms until ctrl-C, with a loop guard
 *   so our own output is never rewritten;
 * - once (`lexicon daemon --once`): read, correct, write, print, exit. This is
 *   what a Raycast/Alfred/Karabiner/AutoHotkey shortcut calls right after
 *   dictating; `--paste` additionally sends Cmd+V (macOS only).
 *
 * The platform tools live in ./clipboard-backends.ts. Read/write stay
 * injectable so the loop can be tested without touching a real clipboard.
 */
import { diffSummary, loadLexicon, normalize } from '../core/index.js';
import type { Lexicon, NormalizeResult } from '../core/index.js';
import {
  createClipboardBackend,
  defaultClipboardExec,
  detectClipboardBackend,
  findOnPath,
  isClipboardBackendName,
  CLIPBOARD_BACKEND_NAMES,
} from './clipboard-backends.js';
import type { ClipboardBackend, ClipboardBackendName, ClipboardExec } from './clipboard-backends.js';

/** Options shared by the loop and once modes. */
export interface ClipboardCommonOptions {
  /** Report corrections but never write to the clipboard. */
  dryRun?: boolean;
  /** Suppress the per-correction diff output. */
  quiet?: boolean;
  /** Directory for project-lexicon discovery. Default process.cwd(). */
  cwd?: string;
  /** Clipboard reader. Default: the detected backend's. */
  read?: () => Promise<string>;
  /** Clipboard writer. Default: the detected backend's. */
  write?: (text: string) => Promise<void>;
  /** Force a backend instead of detecting one (`--backend`). */
  backend?: ClipboardBackendName;
  /** Platform used for detection and for the `--paste` gate. Default process.platform. */
  platform?: NodeJS.Platform;
  /** Environment used for detection (PATH, WAYLAND_DISPLAY, PATHEXT). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Process runner for the backends and osascript; injectable for tests. */
  exec?: ClipboardExec;
  /** Output sink for diff lines. Default process.stdout. */
  out?: (s: string) => void;
  /** Error sink. Default process.stderr. */
  err?: (s: string) => void;
}

export interface ClipboardDaemonOptions extends ClipboardCommonOptions {
  /** Poll interval in milliseconds. Default 250. */
  intervalMs?: number;
  /** Abort to stop the loop (in addition to SIGINT/SIGTERM). */
  signal?: AbortSignal;
}

export interface ClipboardOnceOptions extends ClipboardCommonOptions {
  /** After writing, send Cmd+V to the frontmost app (macOS only; needs Accessibility permission). */
  paste?: boolean;
  /** Keystroke sender used by `paste`. Default: osascript. Injectable for tests. */
  sendPaste?: () => Promise<void>;
}

/** Skip clipboard payloads larger than this (bytes of UTF-16 units, i.e. string length). */
export const MAX_CLIPBOARD_CHARS = 20_000;
/** Re-read the lexicon files at most this often. */
export const LEXICON_RELOAD_MS = 5_000;

/** macOS `pbpaste` (kept for callers of the old API; prefers the backend module). */
export function pbpaste(): Promise<string> {
  return createClipboardBackend('pbcopy').read();
}

/** macOS `pbcopy` (kept for callers of the old API; prefers the backend module). */
export function pbcopy(text: string): Promise<void> {
  return createClipboardBackend('pbcopy').write(text);
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function hasLetters(s: string): boolean {
  return /\p{L}/u.test(s);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ResolvedClipboard {
  name: string;
  description: string;
  read: () => Promise<string>;
  write: (text: string) => Promise<void>;
}

/**
 * Turn the options into concrete read/write functions: injected functions
 * win, then `--backend`, then platform detection. A single injected function
 * is completed from the detected backend.
 */
export async function resolveClipboard(opts: ClipboardCommonOptions): Promise<ResolvedClipboard> {
  if (opts.read && opts.write) {
    return { name: 'injected', description: 'injected read/write', read: opts.read, write: opts.write };
  }
  const exec = opts.exec ?? defaultClipboardExec;
  const backend: ClipboardBackend = opts.backend
    ? createClipboardBackend(opts.backend, exec)
    : await detectClipboardBackend(opts.platform ?? process.platform, opts.env ?? process.env, undefined, exec);
  return {
    name: backend.name,
    description: backend.description ?? backend.name,
    read: opts.read ?? (() => backend.read()),
    write: opts.write ?? ((text) => backend.write(text)),
  };
}

function reportable(text: string): boolean {
  return text.length > 0 && text.length <= MAX_CLIPBOARD_CHARS && hasLetters(text);
}

function formatSummary(result: NormalizeResult): string {
  const summary = diffSummary(result);
  return summary.endsWith('\n') || summary === '' ? summary : `${summary}\n`;
}

// ---------------------------------------------------------------------------
// Loop mode

export async function runClipboardDaemon(opts: ClipboardDaemonOptions = {}): Promise<void> {
  const intervalMs = Math.max(20, opts.intervalMs ?? 250);
  const dryRun = opts.dryRun ?? false;
  const quiet = opts.quiet ?? false;
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));

  const clipboard = await resolveClipboard(opts);
  const { read, write } = clipboard;

  if (opts.signal?.aborted) return;

  let lastSeen: string | undefined; // last raw clipboard value we looked at
  let lastInput: string | undefined; // the input that produced lastWritten
  let lastWritten: string | undefined; // what we last wrote (loop guard)
  let lexicon: Lexicon | undefined;
  let lexiconLoadedAt = -Infinity;

  async function currentLexicon(): Promise<Lexicon> {
    const now = Date.now();
    if (!lexicon || now - lexiconLoadedAt >= LEXICON_RELOAD_MS) {
      try {
        lexicon = (await loadLexicon({ cwd })).merged;
        lexiconLoadedAt = now;
      } catch (e) {
        // Keep serving the previous lexicon (if any) while the file is broken.
        if (!lexicon) throw e;
        if (!quiet) err(`[${timestamp()}] lexicon reload failed, using previous: ${message(e)}\n`);
        lexiconLoadedAt = now;
      }
    }
    return lexicon;
  }

  async function poll(): Promise<void> {
    const text = await read();
    if (text === lastSeen || text === lastWritten || text === lastInput) {
      lastSeen = text;
      return;
    }
    lastSeen = text;
    if (!reportable(text)) return;

    const result = normalize(text, await currentLexicon());
    if (!result.changed) return;

    if (!dryRun) {
      await write(result.output);
      lastWritten = result.output;
      lastInput = text;
      lastSeen = result.output;
    }
    if (!quiet) {
      const header = `[${timestamp()}]${dryRun ? ' (dry-run)' : ''} ${result.replacements.length} correction${result.replacements.length === 1 ? '' : 's'}`;
      out(`${header}\n${formatSummary(result)}`);
    }
  }

  await new Promise<void>((resolve) => {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let inFlight = false;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      if (!inFlight) resolve();
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      inFlight = true;
      try {
        await poll();
      } catch (e) {
        err(`[${timestamp()}] clipboard daemon: ${message(e)}\n`);
      } finally {
        inFlight = false;
      }
      if (stopped) {
        resolve();
        return;
      }
      timer = setTimeout(() => void tick(), intervalMs);
    };

    opts.signal?.addEventListener('abort', stop, { once: true });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);

    if (!quiet) {
      out(
        `lexicon daemon watching clipboard (${clipboard.name}) every ${intervalMs}ms${dryRun ? ' (dry-run)' : ''}; ctrl-C to stop\n`,
      );
    }
    void tick();
  });
}

// ---------------------------------------------------------------------------
// Once mode

/** The AppleScript that pastes into the frontmost app. Needs Accessibility permission for the caller. */
export const PASTE_APPLESCRIPT = 'tell application "System Events" to keystroke "v" using command down';

export interface ClipboardOnceResult {
  /** Whether the clipboard text was changed by the lexicon. */
  changed: boolean;
  /** Whether the corrected text was written back (false for dry-run or unchanged). */
  written: boolean;
  /** Number of replacements. */
  corrections: number;
  /** Whether a paste keystroke was sent. */
  pasted: boolean;
}

/**
 * Read the clipboard once, correct it, write it back if anything changed,
 * print the diff (or "no changes") and return. Exit code semantics for the
 * CLI: 0 unless `--paste` was requested and the keystroke failed.
 */
export async function runClipboardOnce(opts: ClipboardOnceOptions = {}): Promise<ClipboardOnceResult> {
  const dryRun = opts.dryRun ?? false;
  const quiet = opts.quiet ?? false;
  const cwd = opts.cwd ?? process.cwd();
  const platform = opts.platform ?? process.platform;
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));

  const { read, write } = await resolveClipboard(opts);
  const text = await read();

  const result: ClipboardOnceResult = { changed: false, written: false, corrections: 0, pasted: false };

  if (!reportable(text)) {
    if (!quiet) {
      const why = text.length === 0 ? 'clipboard is empty or not text' : text.length > MAX_CLIPBOARD_CHARS ? 'clipboard too large' : 'no letters';
      out(`no changes (${why})\n`);
    }
  } else {
    const lexicon = (await loadLexicon({ cwd })).merged;
    const normalized = normalize(text, lexicon);
    result.changed = normalized.changed;
    result.corrections = normalized.replacements.length;
    if (normalized.changed) {
      if (!dryRun) {
        await write(normalized.output);
        result.written = true;
      }
      if (!quiet) {
        const header = `${dryRun ? '(dry-run) ' : ''}${normalized.replacements.length} correction${normalized.replacements.length === 1 ? '' : 's'}`;
        out(`${header}\n${formatSummary(normalized)}`);
      }
    } else if (!quiet) {
      out('no changes\n');
    }
  }

  if (opts.paste) {
    if (platform !== 'darwin') {
      err(`--paste is macOS-only (uses osascript); the text is on the clipboard, paste it with your usual shortcut (platform: ${platform})\n`);
    } else if (text.length === 0) {
      err('--paste skipped: clipboard is empty\n');
    } else {
      const sendPaste =
        opts.sendPaste ??
        (async (): Promise<void> => {
          await (opts.exec ?? defaultClipboardExec)('osascript', ['-e', PASTE_APPLESCRIPT]);
        });
      try {
        await sendPaste();
        result.pasted = true;
      } catch (e) {
        throw new Error(
          `--paste failed: ${message(e)}\n` +
            'The app that runs this shortcut (Terminal, Raycast, Alfred, Keyboard Maestro, ...) needs Accessibility permission: ' +
            'System Settings > Privacy & Security > Accessibility.',
        );
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry (shared by `lexicon daemon` and the standalone script)

export interface DaemonCommandOptions extends ClipboardDaemonOptions, ClipboardOnceOptions {
  /** Run once and exit instead of polling. */
  once?: boolean;
  /** Print the detected backend and exit. */
  which?: boolean;
}

/** Parse and validate a `--backend` value. */
export function parseBackendName(value: string): ClipboardBackendName {
  if (isClipboardBackendName(value)) return value;
  throw new Error(`unknown clipboard backend "${value}"; expected one of: ${CLIPBOARD_BACKEND_NAMES.join(', ')}`);
}

/** Dispatch for the `daemon` command. Returns the process exit code. */
export async function runDaemonCommand(opts: DaemonCommandOptions = {}): Promise<number> {
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;

  if (opts.which) {
    try {
      const clipboard = await resolveClipboard(opts);
      out(`clipboard backend: ${clipboard.name} (${clipboard.description})\n`);
      if (opts.paste !== undefined || platform === 'darwin') {
        const osascript = await findOnPath('osascript', { env, platform });
        out(`--paste: ${platform === 'darwin' ? (osascript ? `available (${osascript})` : 'osascript not found on PATH') : 'macOS only'}\n`);
      }
      return 0;
    } catch (e) {
      err(`no clipboard backend: ${message(e)}\n`);
      return 1;
    }
  }

  if (opts.paste && !opts.once) {
    throw new Error('--paste only makes sense with --once');
  }

  if (opts.once) {
    await runClipboardOnce(opts);
    return 0;
  }

  await runClipboardDaemon(opts);
  return 0;
}

const USAGE = 'usage: lexicon daemon [--once [--paste]] [--interval <ms>] [--dry-run] [--quiet] [--backend <name>] [--which]\n';

/** Minimal standalone entry: `node dist/daemon/clipboard.js [--once] [--paste] [--interval ms] [--dry-run] [--quiet] [--backend name] [--which]`. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const opts: DaemonCommandOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--quiet' || arg === '-q') opts.quiet = true;
    else if (arg === '--once') opts.once = true;
    else if (arg === '--paste') opts.paste = true;
    else if (arg === '--which') opts.which = true;
    else if (arg === '--backend') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--backend expects a name');
      opts.backend = parseBackendName(value);
    } else if (arg.startsWith('--backend=')) {
      opts.backend = parseBackendName(arg.slice('--backend='.length));
    } else if (arg === '--interval' || arg === '-i') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--interval expects a positive number of milliseconds');
      opts.intervalMs = n;
    } else if (arg.startsWith('--interval=')) {
      const n = Number(arg.slice('--interval='.length));
      if (!Number.isFinite(n) || n <= 0) throw new Error('--interval expects a positive number of milliseconds');
      opts.intervalMs = n;
    } else if (arg === '--cwd') {
      opts.cwd = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  const code = await runDaemonCommand(opts);
  if (code !== 0) process.exitCode = code;
}
