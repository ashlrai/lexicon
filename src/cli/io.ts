/**
 * How CLI commands talk to the terminal: the injectable output sink, colour,
 * the two sanitizing wrappers, table rendering and the handful of formatting
 * helpers every `cmd-*.ts` needs. Reading from the terminal lives next door in
 * prompt.ts.
 *
 * Kept free of imports from any `cmd-*.ts` module (and from commands.ts) so
 * every command can import it without a cycle -- which is why each command
 * used to carry its own copy of `line`, `safe` and `resolveCwd`.
 */
import path from 'node:path';
import { sanitizeForDisplay } from '../core/index.js';
import type { LoadedLexicon } from '../core/index.js';
import { errorMessage } from '../util/errors.js';

// ---------------------------------------------------------------------------
// The output sink
// ---------------------------------------------------------------------------

/**
 * Where a command writes. Handlers take one instead of touching `process`
 * directly, so a test can run a command and read back exactly what it printed.
 */
export interface IO {
  stdout(s: string): void;
  stderr(s: string): void;
}

export const processIO: IO = {
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
};

/** Options every command accepts. */
export interface CommonOptions {
  /** Directory used for project-lexicon discovery. Default process.cwd(). */
  cwd?: string;
}

/** Write one line to stdout. `line(io)` writes a blank one. */
export function line(io: IO, s = ''): void {
  io.stdout(`${s}\n`);
}

export function resolveCwd(opts: CommonOptions): string {
  return path.resolve(opts.cwd ?? process.cwd());
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** Text styling that only emits escape codes when the stream is a terminal. */
export interface Styler {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
}

/**
 * Colour for `output` (default stdout). The TTY and `NO_COLOR` checks happen
 * per call, not when the styler is built, so a command that swaps its streams
 * -- or a test that does -- gets the right answer either way.
 */
export function styler(output: NodeJS.WritableStream | undefined = process.stdout, env: NodeJS.ProcessEnv = process.env): Styler {
  const on = (): boolean => Boolean((output as { isTTY?: boolean } | undefined)?.isTTY) && !env.NO_COLOR;
  const paint =
    (code: string) =>
    (s: string): string =>
      on() ? `\x1b[${code}m${s}\x1b[0m` : s;
  return { bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33') };
}

/** The styler for stdout, which is what almost every command writes to. */
export const { bold, dim, red, green, yellow } = styler(process.stdout);

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

/**
 * Terminal-safe rendering of anything that did not come from this program's
 * own string literals: file paths (a repository can be cloned into a directory
 * named after an escape sequence), canonicals/aliases/notes (a project
 * `.lexicon.yaml` is untrusted input), harvest evidence, error messages that
 * quote any of those. `renderTable` applies it to every cell on its own.
 */
export const safe: (s: string) => string = sanitizeForDisplay;

/** `safe` per line, for text whose line breaks are the point (diff summaries, multi-line errors). */
export function safeLines(s: string): string {
  return s.split('\n').map(safe).join('\n');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `2 terms` / `1 term`. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

/** `~/.config/lexicon/serve.json` when the path sits under the home directory, else the path unchanged. */
export function tildify(p: string, home: string): string {
  const rel = path.relative(home, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : p;
}

export function ensureNewline(s: string): string {
  return s.endsWith('\n') || s === '' ? s : `${s}\n`;
}

/**
 * Render rows as a plain, left-aligned, two-space-separated table. When a
 * header is given it is followed by a dashed underline. Trailing whitespace is
 * trimmed so the output is diff-friendly. Ends with a newline. Every cell is
 * passed through `safe` (escape sequences, control and invisible characters
 * dropped, 200-char cap) before it is measured, so a hostile alias can neither
 * recolour the terminal nor misalign the column it sits in.
 */
export function renderTable(rows: readonly (readonly string[])[], header?: readonly string[]): string {
  const all: (readonly string[])[] = header
    ? [header.map(safe), ...rows.map((r) => r.map(safe))]
    : rows.map((r) => r.map(safe));
  if (all.length === 0) return '';
  const cols = Math.max(...all.map((r) => r.length));
  const widths: number[] = new Array<number>(cols).fill(0);
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i], cell.length);
    });
  }
  const fmt = (row: readonly string[]): string =>
    widths
      .map((w, i) => (row[i] ?? '').padEnd(w))
      .join('  ')
      .trimEnd();
  const out: string[] = [];
  if (header) {
    out.push(fmt(all[0]));
    out.push(fmt(widths.map((w) => '-'.repeat(w))));
  }
  for (const row of header ? all.slice(1) : all) out.push(fmt(row));
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * The house style for a failed command: one `lexicon: <message>` line on
 * stderr, exit code 1. Handlers `return fail(io, err)` rather than throwing, so
 * the commander wiring in index.ts stays a thin pass-through of exit codes.
 */
export function fail(io: IO, err: unknown): number {
  io.stderr(`lexicon: ${safeLines(errorMessage(err))}\n`);
  return 1;
}

/** One stderr line when a project lexicon exists but was not merged (untrusted or changed). */
export function warnSkippedProject(loaded: Pick<LoadedLexicon, 'projectTrust' | 'skippedProject'>, io: IO): void {
  if (!loaded.skippedProject) return;
  const why = loaded.projectTrust === 'changed' ? 'changed since trusted' : 'untrusted';
  io.stderr(`lexicon: ${why} project lexicon skipped: ${safe(loaded.skippedProject.path)} (run: lexicon trust)\n`);
}
