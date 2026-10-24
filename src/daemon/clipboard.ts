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
import { statSync } from 'node:fs';
import { FIRST_TERM_STEP, TRUST_STEP, diffSummary, getTrustPath, loadLexicon, noTermsYet, normalize, recordHits, resolvePaths } from '../core/index.js';
import type { LoadedLexicon, NormalizeResult } from '../core/index.js';
import {
  checkClipboardBackend,
  createClipboardBackend,
  defaultClipboardExec,
  detectClipboardBackend,
  isClipboardBackendName,
  isClipboardTooLarge,
  powershellShell,
  CLIPBOARD_BACKEND_NAMES,
} from './clipboard-backends.js';
import type { ClipboardBackend, ClipboardBackendName, ClipboardExec } from './clipboard-backends.js';
import { findOnPath } from '../util/which.js';

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
/**
 * Re-read the lexicon files at least this often. A change to a lexicon file
 * or to trust.json is seen sooner, on the next clipboard change to correct
 * (lexiconFilesStamp); this is the backstop for a file system whose times did
 * not move.
 */
export const LEXICON_RELOAD_MS = 5_000;

/**
 * What the loop compares to see a lexicon edit: size, modification time and
 * inode of the global lexicon, the project lexicon for `cwd` (found again
 * each time, so a new `.lexicon.yaml` counts) and trust.json, `-` for a file
 * that is not there. A few `stat` calls, made only when a new clipboard text
 * is about to be corrected, never on an unchanged poll. An edit used to wait
 * for the 5 s reload, so a term just learned was not used on the next copy.
 */
export function lexiconFilesStamp(cwd: string): string {
  const paths = resolvePaths({ cwd });
  const files = [paths.global, paths.project ?? '', getTrustPath({ cwd })];
  // Synchronous: three stats of small local files cost microseconds, and the
  // poll then never waits on the I/O queue between reading and correcting.
  const stamps = files.map((file) => {
    if (file === '') return '-';
    try {
      const st = statSync(file, { throwIfNoEntry: false });
      return st ? `${st.size}:${st.mtimeMs}:${st.ino}` : '-';
    } catch {
      return '-';
    }
  });
  return `${paths.project ?? ''}|${stamps.join('|')}`;
}

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
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const onPath = async (bin: string): Promise<boolean> => (await findOnPath(bin, { env, platform })) !== undefined;
  let shell: 'powershell' | 'pwsh' = 'powershell';
  if (opts.backend && !opts.exec) {
    // Real processes only: an injected exec stands in for the tools.
    await checkClipboardBackend(opts.backend, onPath);
    if (opts.backend === 'powershell') shell = await powershellShell(onPath);
  }
  const backend: ClipboardBackend = opts.backend
    ? createClipboardBackend(opts.backend, exec, shell)
    : await detectClipboardBackend(platform, env, undefined, exec);
  return {
    name: backend.name,
    description: backend.description ?? backend.name,
    read: opts.read ?? (() => backend.read()),
    write: opts.write ?? ((text) => backend.write(text)),
  };
}

/**
 * True for clipboard contents that are not text: a NUL, or U+FFFD, which is
 * what UTF-8 decoding leaves for bytes that are not UTF-8. A tool that hands
 * over an image when no text type is offered (wl-paste without `--type`, or a
 * custom one) gives bytes such as a PNG header, and writing the "corrected"
 * decoding back replaced the user's copied image with mangled text.
 */
export function looksBinary(text: string): boolean {
  return /[\u0000\uFFFD]/.test(text);
}

function reportable(text: string): boolean {
  return text.length > 0 && text.length <= MAX_CLIPBOARD_CHARS && hasLetters(text) && !looksBinary(text);
}

/**
 * Why `loaded` corrects nothing at all, ending in the step that fixes it, or
 * undefined when it has terms. A first run with an empty lexicon answered
 * every clipboard with a bare "no changes", which reads as "nothing to fix".
 */
export function emptyLexiconHint(loaded: Pick<LoadedLexicon, 'merged' | 'skippedProject'>): string | undefined {
  if (loaded.merged.terms.length > 0) return undefined;
  return loaded.skippedProject
    ? `the project lexicon is not trusted, so its terms were not used; ${TRUST_STEP}`
    : `${noTermsYet({ lower: true })}; ${FIRST_TERM_STEP}`;
}

/**
 * The line above a correction summary. Under --dry-run it says the clipboard
 * was left as it was: `(dry-run) 2 corrections` alone did not say whether
 * they had been written.
 */
function correctionsHeader(count: number, dryRun: boolean): string {
  const n = `${count} correction${count === 1 ? '' : 's'}`;
  return dryRun ? `(dry-run) ${n}; the clipboard was left unchanged` : n;
}

function formatSummary(result: NormalizeResult): string {
  const summary = diffSummary(result);
  return summary.endsWith('\n') || summary === '' ? summary : `${summary}\n`;
}

/**
 * Bump `hits` for the canonicals a clipboard correction used, without waiting
 * for the write (a slow disk must not stall the poll loop or the --once exit).
 * recordHits is best-effort by contract; the catch covers a rejecting mock.
 */
function recordHitsInBackground(result: NormalizeResult, cwd: string, loaded: LoadedLexicon, err: (s: string) => void): void {
  const canonicals = [...new Set(result.replacements.map((r) => r.canonical))];
  if (canonicals.length === 0) return;
  // `loaded` (the load the corrections came from) spares recordHits reading
  // both lexicon files again, and it holds a project file only when trusted.
  void recordHits(canonicals, { cwd, loaded }).catch((e: unknown) => {
    err(`[${timestamp()}] clipboard daemon: recordHits: ${message(e)}\n`);
  });
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
  let lexicon: LoadedLexicon | undefined;
  let lexiconLoadedAt = -Infinity;
  let lexiconStamp: string | undefined;

  async function currentLexicon(): Promise<LoadedLexicon> {
    const now = Date.now();
    // Taken before the load, so an edit that lands during it is seen next time.
    const stamp = lexiconFilesStamp(cwd);
    if (!lexicon || stamp !== lexiconStamp || now - lexiconLoadedAt >= LEXICON_RELOAD_MS) {
      try {
        // parseSkipped: false: only the merged terms are used, so an untrusted
        // or changed project file is never parsed, on this or any reload.
        lexicon = await loadLexicon({ cwd, parseSkipped: false });
        lexiconLoadedAt = now;
        lexiconStamp = stamp;
      } catch (e) {
        // Keep serving the previous lexicon (if any) while the file is broken.
        if (!lexicon) throw e;
        if (!quiet) err(`[${timestamp()}] lexicon reload failed, using previous: ${message(e)}\n`);
        lexiconLoadedAt = now;
        lexiconStamp = stamp;
      }
    }
    return lexicon;
  }

  async function poll(): Promise<void> {
    let text: string;
    try {
      text = await read();
    } catch (e) {
      if (!isClipboardTooLarge(e)) throw e;
      // Too large to correct, as an oversized string is below: skipped, not an
      // error. Something new was copied, so the guard is cleared as it would be.
      lastSeen = undefined;
      lastWritten = undefined;
      lastInput = undefined;
      return;
    }
    if (text === lastSeen || text === lastWritten || text === lastInput) {
      lastSeen = text;
      return;
    }
    lastSeen = text;
    // Something new was copied, so the guard has done its job: it only has to
    // stop us rewriting our own output, or fighting a clipboard tool that puts
    // the original straight back. Kept forever, it meant the same dictated
    // text copied again later (after anything else) was never corrected.
    lastWritten = undefined;
    lastInput = undefined;
    if (!reportable(text)) return;

    const loaded = await currentLexicon();
    const result = normalize(text, loaded.merged);
    if (!result.changed) return;

    if (!dryRun) {
      try {
        await write(result.output);
      } catch (e) {
        // lastSeen already holds this text, so the next poll would skip it
        // and a write that failed once was never retried. Forget it so the
        // next poll tries again; the error is reported once by the caller.
        lastSeen = undefined;
        throw e;
      }
      lastWritten = result.output;
      lastInput = text;
      lastSeen = result.output;
      recordHitsInBackground(result, cwd, loaded, err);
    }
    if (!quiet) {
      const header = `[${timestamp()}] ${correctionsHeader(result.replacements.length, dryRun)}`;
      out(`${header}\n${formatSummary(result)}`);
    }
  }

  await new Promise<void>((resolve) => {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let inFlight = false;
    // A broken clipboard (no display, tool removed) fails the same way on
    // every poll; report it once, then again only when it changes or clears.
    let lastError: string | undefined;

    // A second ctrl-C while a poll is still in flight (a clipboard tool that
    // hangs until its timeout) stops at once: the first one only waited, and
    // with its listener gone nothing answered the second.
    const forceInt = (): void => forceExit(130);
    const forceTerm = (): void => forceExit(143);
    const forceExit = (code: number): void => {
      err(`[${timestamp()}] clipboard daemon: stopped without waiting for the clipboard tool\n`);
      process.exit(code);
    };
    const dropForce = (): void => {
      process.removeListener('SIGINT', forceInt);
      process.removeListener('SIGTERM', forceTerm);
    };
    const finish = (): void => {
      dropForce();
      resolve();
    };

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', stop);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      if (!inFlight) {
        resolve();
        return;
      }
      process.once('SIGINT', forceInt);
      process.once('SIGTERM', forceTerm);
      if (!quiet) err(`[${timestamp()}] clipboard daemon: stopping once the clipboard tool answers; ctrl-C again to stop now\n`);
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      inFlight = true;
      try {
        await poll();
        if (lastError !== undefined) {
          lastError = undefined;
          err(`[${timestamp()}] clipboard daemon: working again\n`);
        }
      } catch (e) {
        const msg = message(e);
        if (msg !== lastError) {
          lastError = msg;
          err(`[${timestamp()}] clipboard daemon: ${msg} (retrying every ${intervalMs}ms; reported again only if it changes)\n`);
        }
      } finally {
        inFlight = false;
      }
      if (stopped) {
        finish();
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
    // Said once at start: with no terms the daemon would watch in silence and
    // never correct anything. A lexicon that fails to load is reported by
    // the first poll instead.
    const startTick = async (): Promise<void> => {
      if (!quiet) {
        try {
          const hint = emptyLexiconHint(await currentLexicon());
          if (hint) err(`[${timestamp()}] clipboard daemon: nothing will be corrected: ${hint}\n`);
        } catch {
          // the first poll reports it
        }
      }
      await tick();
    };
    void startTick();
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
  // A read past the backend's cap (MAX_CLIPBOARD_READ_BYTES) is the same
  // "too large" as a string over MAX_CLIPBOARD_CHARS, not an error and not empty.
  let tooLarge = false;
  let text = '';
  try {
    text = await read();
  } catch (e) {
    if (!isClipboardTooLarge(e)) throw e;
    tooLarge = true;
  }

  const result: ClipboardOnceResult = { changed: false, written: false, corrections: 0, pasted: false };

  if (tooLarge || !reportable(text)) {
    if (!quiet) {
      const why =
        text.length === 0 && !tooLarge
          ? 'clipboard is empty or not text'
          : tooLarge || text.length > MAX_CLIPBOARD_CHARS
            ? 'clipboard too large'
            : looksBinary(text)
              ? 'clipboard holds binary data, not text; left as it was'
              : 'no letters';
      out(`no changes (${why})\n`);
    }
  } else {
    // Only the merged terms are used: an untrusted project file is never parsed.
    const loaded = await loadLexicon({ cwd, parseSkipped: false });
    const normalized = normalize(text, loaded.merged);
    result.changed = normalized.changed;
    result.corrections = normalized.replacements.length;
    if (normalized.changed) {
      if (!dryRun) {
        await write(normalized.output);
        result.written = true;
        recordHitsInBackground(normalized, cwd, loaded, err);
      }
      if (!quiet) {
        const header = correctionsHeader(normalized.replacements.length, dryRun);
        out(`${header}\n${formatSummary(normalized)}`);
      }
    } else if (!quiet) {
      const hint = emptyLexiconHint(loaded);
      out(hint ? `no changes (${hint})\n` : 'no changes\n');
    }
  }

  if (opts.paste) {
    if (platform !== 'darwin') {
      err(`--paste is macOS-only (uses osascript); the text is on the clipboard, paste it with your usual shortcut (platform: ${platform})\n`);
    } else if (text.length === 0 && !tooLarge) {
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
      if (opts.paste === true || platform === 'darwin') {
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
    // It named no way on: the watcher cannot paste (it would paste on every
    // clipboard change), so say what --once does and the command to run.
    throw new Error('--paste works only with --once (correct the clipboard once, then paste); run: lexicon daemon --once --paste');
  }

  if (opts.once) {
    await runClipboardOnce(opts);
    return 0;
  }

  await runClipboardDaemon(opts);
  return 0;
}

const USAGE = 'usage: lexicon daemon [--once [--paste]] [--interval <ms>] [--dry-run] [--quiet] [--backend <name>] [--cwd <dir>] [--which]\n';

/** Minimal standalone entry: `node dist/daemon/clipboard.js [--once] [--paste] [--interval ms] [--dry-run] [--quiet] [--backend name] [--cwd dir] [--which]`. */
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
    } else if (arg === '--cwd' || arg.startsWith('--cwd=')) {
      // `--cwd` with nothing after it (or followed by the next flag) left cwd
      // undefined or set to "--once", so the watcher ran from the wrong place.
      const value = arg === '--cwd' ? argv[++i] : arg.slice('--cwd='.length);
      if (value === undefined || value.trim() === '' || (arg === '--cwd' && value.startsWith('-'))) {
        throw new Error(`--cwd expects a directory (got ${value === undefined ? 'nothing' : `"${value}"`}); run: lexicon daemon --cwd <dir>`);
      }
      opts.cwd = value;
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
