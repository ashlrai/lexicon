/**
 * macOS clipboard daemon: polls `pbpaste`, normalizes the text against the
 * lexicon and writes corrections back with `pbcopy`.
 *
 * Read/write are injectable so the loop can be tested (and, later, ported to
 * other platforms) without touching the real clipboard.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { diffSummary, loadLexicon, normalize } from '../core/index.js';
import type { Lexicon } from '../core/index.js';

const execFileAsync = promisify(execFile);

export interface ClipboardDaemonOptions {
  /** Poll interval in milliseconds. Default 250. */
  intervalMs?: number;
  /** Report corrections but never write to the clipboard. */
  dryRun?: boolean;
  /** Suppress the per-correction diff output. */
  quiet?: boolean;
  /** Directory for project-lexicon discovery. Default process.cwd(). */
  cwd?: string;
  /** Clipboard reader. Default: `pbpaste`. */
  read?: () => Promise<string>;
  /** Clipboard writer. Default: `pbcopy`. */
  write?: (text: string) => Promise<void>;
  /** Abort to stop the loop (in addition to SIGINT/SIGTERM). */
  signal?: AbortSignal;
  /** Output sink for diff lines. Default process.stdout. */
  out?: (s: string) => void;
  /** Error sink. Default process.stderr. */
  err?: (s: string) => void;
}

/** Skip clipboard payloads larger than this (bytes of UTF-16 units, i.e. string length). */
export const MAX_CLIPBOARD_CHARS = 20_000;
/** Re-read the lexicon files at most this often. */
export const LEXICON_RELOAD_MS = 5_000;

export async function pbpaste(): Promise<string> {
  const { stdout } = await execFileAsync('pbpaste', [], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export function pbcopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy exited with code ${code}`));
    });
    child.stdin.once('error', reject);
    child.stdin.end(text, 'utf8');
  });
}

function timestamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function hasLetters(s: string): boolean {
  return /\p{L}/u.test(s);
}

export async function runClipboardDaemon(opts: ClipboardDaemonOptions = {}): Promise<void> {
  const intervalMs = Math.max(20, opts.intervalMs ?? 250);
  const dryRun = opts.dryRun ?? false;
  const quiet = opts.quiet ?? false;
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));

  if ((!opts.read || !opts.write) && process.platform !== 'darwin') {
    throw new Error('clipboard daemon currently supports macOS (pbpaste/pbcopy); pass --help');
  }
  const read = opts.read ?? pbpaste;
  const write = opts.write ?? pbcopy;

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
    if (text.length === 0 || text.length > MAX_CLIPBOARD_CHARS || !hasLetters(text)) return;

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
      const summary = diffSummary(result);
      out(`${header}\n${summary.endsWith('\n') || summary === '' ? summary : `${summary}\n`}`);
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
      out(`lexicon daemon watching clipboard every ${intervalMs}ms${dryRun ? ' (dry-run)' : ''}; ctrl-C to stop\n`);
    }
    void tick();
  });
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Minimal standalone entry: `node dist/daemon/clipboard.js [--interval ms] [--dry-run] [--quiet]`. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const opts: ClipboardDaemonOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--quiet' || arg === '-q') opts.quiet = true;
    else if (arg === '--interval' || arg === '-i') {
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
      process.stdout.write('usage: lexicon daemon [--interval <ms>] [--dry-run] [--quiet]\n');
      return;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  await runClipboardDaemon(opts);
}
