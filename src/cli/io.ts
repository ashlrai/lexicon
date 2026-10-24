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
import { statSync } from 'node:fs';
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';
import path from 'node:path';
import { TERM_CATEGORIES, commandLine, isProjectTrustError, sanitizeForDisplay, sanitizeForDisplayMax, shellWord, skippedProjectNote } from '../core/index.js';
import type { LearnConflict, LoadedLexicon, TermCategory, TermHolder } from '../core/index.js';
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

/**
 * A command this program composed for the user to copy and run: `words`
 * quoted for the shell on `platform` by `commandLine` (POSIX, or PowerShell on
 * win32), then sanitized like `safe` but never cut. A command shortened with
 * an ellipsis cannot be run, and a deep temp or home directory pushed a
 * printed `--home <dir> --apply` past `safe`'s 200 characters.
 */
export function shownCommand(words: readonly string[], platform: NodeJS.Platform = process.platform): string {
  return sanitizeForDisplayMax(commandLine(words, platform), Number.POSITIVE_INFINITY);
}

/**
 * One word quoted for this platform's shell, for a command line written
 * around a placeholder. shownCommand([word]) is a whole command: on Windows
 * a quoted first word gets PowerShell's call operator, which put
 * `lexicon learn <heard> & 'Zoë'` on screen.
 */
export function shownWord(word: string, platform: NodeJS.Platform = process.platform): string {
  return sanitizeForDisplayMax(shellWord(word, platform), Number.POSITIVE_INFINITY);
}

/** `safe` per line, for text whose line breaks are the point (diff summaries, multi-line errors). */
export function safeLines(s: string): string {
  return s.split('\n').map(safe).join('\n');
}

/** Longest line `safeError` prints: PATH_MAX, so a file path in an error is never cut. */
export const ERROR_LINE_MAX_CHARS = 4096;

/**
 * `safeLines` for a message this program composed around a path: an error
 * from `fail`, a `lexicon doctor` check, its summary and next step. Each line
 * is sanitized like `safe` but capped at ERROR_LINE_MAX_CHARS rather than 200,
 * because these messages name the command to run after the path, and a deep
 * repo or home directory pushed the 200th character into that command
 * (`... or write to the global le…`, `otherwise run: lexicon install c…`).
 */
export function safeMessage(s: string): string {
  return s
    .split('\n')
    .map((l) => sanitizeForDisplayMax(l, ERROR_LINE_MAX_CHARS))
    .join('\n');
}
/** Lines of an error `safeError` prints before "... and N more lines". */
export const ERROR_MAX_LINES = 12;

/**
 * An error message from another process (a server's response) made safe to
 * print: each line sanitized like `safe` but capped at ERROR_LINE_MAX_CHARS
 * rather than 200, since the path a parse error names is the part to keep,
 * and at most ERROR_MAX_LINES lines. Blank lines are dropped.
 */
export function safeError(s: string): string {
  const lines = s.split(/\r?\n/).filter((l) => l.trim() !== '');
  const shown = lines.slice(0, ERROR_MAX_LINES).map((l) => sanitizeForDisplayMax(l, ERROR_LINE_MAX_CHARS));
  if (lines.length > ERROR_MAX_LINES) shown.push(`  ... and ${plural(lines.length - ERROR_MAX_LINES, 'more line')}`);
  return shown.join('\n');
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
 * stderr, exit code 1. With `json` true (the command's `--json`) the
 * `{ ok: false, error, nextStep }` document goes to stdout as well, `nextStep`
 * being the unreadable-lexicon hint when there is one, PROJECT_TRUST_NEXT_STEP
 * for a refused project write, else DEFAULT_NEXT_STEP. Handlers `return fail(io, err)` rather than throwing, so
 * the commander wiring in index.ts stays a thin pass-through of exit codes.
 */
export function fail(io: IO, err: unknown, json?: boolean): number {
  const message = errorMessage(err);
  const hint = unreadableLexiconHint(message) ?? ownNextStep(err);
  if (json) printJsonError(io, message, hint ?? (isProjectTrustError(err) ? PROJECT_TRUST_NEXT_STEP : undefined));
  io.stderr(`lexicon: ${safeMessage(message)}\n`);
  if (hint) io.stderr(`lexicon: ${safeMessage(hint)}\n`);
  return 1;
}

/** The `nextStep` of a pack name that is neither a starter pack nor a community ref. */
export const PACK_NOT_FOUND_NEXT_STEP =
  'run lexicon pack list to see the starter packs; a community pack is <author>/<name> with --registry <index> (lexicon pack search finds one)';

/**
 * The next step an error carries itself: a `CliRefusal`'s (an unknown
 * `--category` names the categories), or the pack list for an unknown pack.
 */
function ownNextStep(err: unknown): string | undefined {
  if (err instanceof CliRefusal) return err.nextStep;
  // By name, like isProjectTrustError, so it holds across a mocked core.
  if (err instanceof Error && err.name === 'PackNotFoundError') return PACK_NOT_FOUND_NEXT_STEP;
  return undefined;
}

/**
 * The stdout document of a `--json` command that failed: `{ ok: false, error,
 * nextStep }`, as `setup --json` prints it. Under --json stdout is the one
 * thing a script reads, so a refusal that only went to stderr left it with an
 * empty document to parse. The text is unsanitized (it is JSON, not a
 * terminal line), like every other `--json` field. `nextStep` is always
 * there: the caller's, else DEFAULT_NEXT_STEP, so a script reads the same
 * three keys from every failure (a store error, an unknown flag, a refusal).
 */
export interface JsonError {
  ok: false;
  error: string;
  nextStep: string;
}

/** The `nextStep` of a failure that has no more specific one. */
export const DEFAULT_NEXT_STEP = 'fix what error names, then run the command again (its --help lists the flags)';

/** The `nextStep` of a write the store refused because the project lexicon is not trusted. */
export const PROJECT_TRUST_NEXT_STEP =
  'review the project lexicon and run lexicon trust, then run the command again; or write to the global lexicon instead';

export function jsonError(error: string, nextStep?: string): JsonError {
  return { ok: false, error, nextStep: nextStep || DEFAULT_NEXT_STEP };
}

/**
 * The stdout document of a `--json` command that succeeded with an object:
 * `{ ok: true, ...doc }`, `ok` first, so a script tells success from a
 * `JsonError` by the same key. Array-shaped successes stay bare arrays.
 */
export function jsonOk<T extends object>(doc: T): { ok: true } & T {
  return { ok: true, ...doc };
}

/** Print `jsonError(error, nextStep)` on stdout. */
export function printJsonError(io: IO, error: string, nextStep?: string): void {
  io.stdout(`${JSON.stringify(jsonError(error, nextStep), null, 2)}\n`);
}

/**
 * Whether a command line asked for `--json`: the flag appears before any `--`
 * (after it, `--json` is text for `normalize`, not a flag). index.ts uses it
 * for the errors commander raises before any handler runs, when no command's
 * parsed options exist to read it from. `flags` are the spellings that ask
 * for JSON on that command: `--json`, plus `--full` where it implies --json
 * (`list`, `harvest`).
 */
export function argvRequestsJson(args: readonly string[], flags: readonly string[] = ['--json']): boolean {
  const end = args.indexOf('--');
  const before = end === -1 ? args : args.slice(0, end);
  return flags.some((flag) => before.includes(flag));
}

/**
 * A refusal raised before a command runs (see `cwdOptionProblem`): `index.ts`
 * reports it through `refuse`, so it gets the `lexicon:` lines and, under
 * --json, `{ ok: false, error, nextStep }`.
 */
export class CliRefusal extends Error {
  constructor(message: string, readonly nextStep?: string) {
    super(message);
    this.name = 'CliRefusal';
  }
}

/**
 * A `--category` value, lowercased; undefined when the flag is absent. An
 * unknown one is a CliRefusal naming the categories, so every command that
 * takes `--category` (list, add, export, review) gives the same next step.
 */
export function parseCategory(value: string | undefined): TermCategory | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (!(TERM_CATEGORIES as readonly string[]).includes(lower)) {
    throw new CliRefusal(
      `unknown category "${value}" (expected one of: ${TERM_CATEGORIES.join(', ')})`,
      `pass one of ${TERM_CATEGORIES.join(', ')} to --category, or leave --category out`,
    );
  }
  return lower as TermCategory;
}

/**
 * Why the global `--cwd` cannot be used, or undefined when it is absent or
 * names an existing directory. A directory that does not exist (a typo) was
 * taken as is: `lexicon stats --cwd /nope --json` answered `ok: true` for the
 * global lexicon alone and `doctor` reported no project lexicon "found from
 * /nope", as if the repository had none. serve refuses the same `cwd` with a
 * 400 and MCP tools refuse a path outside their roots.
 */
export function cwdOptionProblem(cwd: string | undefined): CliRefusal | undefined {
  if (cwd === undefined) return undefined;
  try {
    if (statSync(cwd).isDirectory()) return undefined;
  } catch {
    // missing or unreadable: refused below
  }
  return new CliRefusal(
    `--cwd "${sanitizeForDisplay(cwd)}" is not an existing directory`,
    'pass a directory that exists, or leave --cwd out to use the current directory',
  );
}

/**
 * The flags that ask `cmd` for a JSON document: `--json`, and `--full` on a
 * command that defines it (`list --full` and `harvest --full` imply --json).
 */
export function jsonFlagsOf(cmd: { options: readonly { long?: string }[] } | undefined): string[] {
  return cmd?.options.some((o) => o.long === '--full') ? ['--json', '--full'] : ['--json'];
}

/** Whether a command's parsed options ask for JSON: `--json`, or `--full`, which implies it. */
export function optsRequestJson(opts: { json?: unknown; full?: unknown } | undefined): boolean {
  return opts?.json === true || opts?.full === true;
}

/**
 * The `--json` document for a commander usage error (an unknown option or
 * command, a missing argument, an invalid option value): commander's message
 * without its `error: ` prefix, and the `--help` command of the command that
 * rejected the line (`lexicon pack add`, or just `lexicon`) as `nextStep`.
 */
export function usageErrorJson(message: string, commandPath: string): JsonError {
  const error = message.replace(/^error:\s*/, '').trim() || 'invalid command line';
  return jsonError(error, `see the usage: ${commandPath} --help`);
}

/**
 * Names a first-time user tries that are not lexicon commands, mapped to the
 * command that does that job. commander's own suggestion goes by spelling
 * alone, so `status` got `stats` (term counts) instead of `doctor`.
 */
const OTHER_COMMAND_NAMES: Readonly<Record<string, string>> = {
  status: 'Did you mean doctor? It checks the setup; stats counts terms and hits',
  check: 'Did you mean doctor? It checks the lexicon files and the agent integration',
  version: 'the version is: lexicon --version',
  config: 'lexicon path prints where the lexicon files are; lexicon edit opens the global one',
  show: 'Did you mean list? It prints the terms',
  delete: 'Did you mean remove? e.g. lexicon remove "Ashlr.AI"',
};

/**
 * The hint for an unknown command `name` that is another tool's name for a
 * lexicon command (`status`, `version`, `config`), or undefined to keep
 * commander's spelling suggestion.
 */
export function unknownCommandHint(name: string): string | undefined {
  return Object.hasOwn(OTHER_COMMAND_NAMES, name) ? OTHER_COMMAND_NAMES[name] : undefined;
}

/**
 * A refusal that is not an exception: the `lexicon: <error>` line (and a
 * `lexicon: <nextStep>` line) on stderr and, under --json, the `JsonError`
 * document on stdout. Exit code 1.
 */
export function refuse(io: IO, json: boolean | undefined, error: string, nextStep?: string): number {
  if (json) printJsonError(io, error, nextStep);
  io.stderr(`lexicon: ${safeMessage(error)}\n`);
  if (nextStep) io.stderr(`lexicon: ${safeMessage(nextStep)}\n`);
  return 1;
}

/**
 * The next step after a lexicon file that does not parse or validate. Every
 * command that loads the lexicon (list, add, stats, export, learn, ...) used
 * to stop at the parser's reason, which names the file but not what to run;
 * only `lexicon doctor` said `lexicon edit`. A project file is always named
 * `.lexicon.yaml`, so the basename picks the `edit` flag that opens it.
 */
export function unreadableLexiconHint(message: string): string | undefined {
  if (/^Cannot read lexicon at /.test(message)) {
    return 'the command stopped and nothing was changed; make that path readable or point LEXICON_PATH at a file in an existing directory (or unset it), then check it with: lexicon doctor';
  }
  const edit = unreadableLexiconEdit(message);
  return edit ? `the command stopped and nothing was changed; fix that file first (run: ${edit}), then check it with: lexicon doctor` : undefined;
}

/**
 * The `lexicon edit` command that opens the file a store parse/validation
 * error names (`--project` for a `.lexicon.yaml`), or undefined when the
 * message is not one. The MCP server words its own next step around it.
 */
export function unreadableLexiconEdit(message: string): string | undefined {
  const m = /^(?:Failed to parse lexicon YAML|Invalid lexicon) at (.+?): /.exec(message);
  if (!m) return undefined;
  return path.basename(m[1] ?? '') === '.lexicon.yaml' ? 'lexicon edit --project' : 'lexicon edit';
}

/** One stderr line when a project lexicon exists but was not merged (untrusted or changed). */
export function warnSkippedProject(loaded: Pick<LoadedLexicon, 'projectTrust' | 'skippedProject'>, io: IO): void {
  if (!loaded.skippedProject) return;
  // "changed since trusted project lexicon skipped" did not parse as a
  // sentence, and did not say the trust had been lost or that trusting again
  // is the way back.
  const where = safe(loaded.skippedProject.path);
  io.stderr(
    loaded.projectTrust === 'changed'
      ? `lexicon: project lexicon changed since you trusted it, so it was skipped: ${where} (review it, then run: lexicon trust)\n`
      : `lexicon: untrusted project lexicon skipped: ${where} (run: lexicon trust)\n`,
  );
}

/**
 * The additive `--json` keys for a skipped project lexicon, the same three
 * the MCP tools return: `projectTrust`, `skippedProject` (path only, never its
 * contents) and `note`. Empty when nothing was skipped, so the shape is
 * unchanged then. `consequence` adds what the skip means for this output.
 */
export function skippedProjectJson(
  loaded: Pick<LoadedLexicon, 'projectTrust' | 'skippedProject'>,
  consequence?: string,
): { projectTrust?: LoadedLexicon['projectTrust']; skippedProject?: string; note?: string } {
  const note = skippedProjectNote(loaded, consequence);
  if (!loaded.skippedProject || note === undefined) return {};
  return { projectTrust: loaded.projectTrust, skippedProject: loaded.skippedProject.path, note };
}

/**
 * The line naming a copy of a removed term that is still in another lexicon
 * file (removeTerm edits one file), with the command that removes only that
 * copy: `--project` or `--global`.
 */
export function stillInLine(canonical: string, holder: TermHolder): string {
  const command = shownCommand(['lexicon', 'remove', canonical, `--${holder.scope}`]);
  return `warn: ${safe(canonical)} is still in the ${holder.scope} lexicon (${safeMessage(holder.path)}) and keeps correcting from there; to remove that copy too: ${command}`;
}

/**
 * The line naming a copy of a term in the skipped (untrusted or changed)
 * project lexicon. That file is not loaded and is never edited, but its copy
 * wins the merge once the user trusts it. Path only, never its contents.
 */
export function untrustedLine(canonical: string, holder: { path: string; trust: 'untrusted' | 'changed' }): string {
  const why = holder.trust === 'changed' ? 'changed since trusted' : 'untrusted';
  return (
    `warn: ${safe(canonical)} is also in the ${why} project lexicon (${safeMessage(holder.path)}), which is not loaded or edited; ` +
    'it corrects from there once that file is trusted, so review it before running lexicon trust'
  );
}

/** The alias counterpart of `untrustedLine`: the skipped project file's copy of the term still holds the alias. Path only. */
export function untrustedAliasLine(canonical: string, alias: string, holder: { path: string; trust: 'untrusted' | 'changed' }): string {
  const why = holder.trust === 'changed' ? 'changed since trusted' : 'untrusted';
  return (
    `warn: ${safe(alias)} is also an alias of ${safe(canonical)} in the ${why} project lexicon (${safeMessage(holder.path)}), which is not loaded or edited; ` +
    'it corrects from there once that file is trusted, so review it before running lexicon trust'
  );
}

/**
 * The `warn:` line for a spelling another term also holds (`learn`, `add`):
 * the next transcript may still be corrected to that term. For an alias it
 * names the `lexicon remove --alias` command that lets the new one win, for
 * another term's canonical the `lexicon remove` that drops that term.
 */
export function conflictLine(c: LearnConflict): string {
  return c.as === 'alias'
    ? `warn: ${safe(c.spelling)} is also an alias of ${safe(c.canonical)} (${c.scope}), so it may still be corrected to that; to drop it: ${shownCommand(['lexicon', 'remove', c.canonical, '--alias', c.spelling, `--${c.scope}`])}`
    : `warn: ${safe(c.spelling)} is its own term (${c.scope}), so it may still be kept as written; to drop that term: ${shownCommand(['lexicon', 'remove', c.canonical, `--${c.scope}`])}`;
}

/**
 * A commander option parser for a positive integer flag. A refused value
 * throws InvalidArgumentError, so commander names the option (`option
 * '--limit <n>' argument '0' is invalid.`), followed by an example of a good
 * one for that flag (`expected a positive integer, e.g. --limit 50`): the bare
 * "expected a positive integer" did not show what to type. Only a string of
 * digits (surrounding spaces aside) is taken, so `5abc` and `1.5` are refused
 * rather than read as 5 and 1.
 */
export function positiveIntOption(flag: string, example: number, max?: number): (value: string) => number {
  return (value: string): number => {
    const n = wholeNumber(value);
    if (n === undefined || n <= 0) throw new InvalidArgumentError(`expected a positive integer, e.g. ${flag} ${example}`);
    if (max !== undefined && n > max) throw new InvalidArgumentError(`expected a positive integer of at most ${max}, e.g. ${flag} ${example}`);
    return n;
  };
}

/**
 * A string of digits (surrounding spaces aside) as a safe integer, else
 * undefined. The rule positiveIntOption and the handlers' own integer options
 * share: parseInt read `5abc` as 5 and `1.5` as 1.
 */
export function wholeNumber(value: string): number | undefined {
  const text = value.trim();
  if (!/^[0-9]+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * After a missing-argument error, print `example`; after any other usage
 * error (an unknown option, say), only where the usage is. An example of the
 * right call does not answer `unknown option '--bogus'`.
 */
export function exampleAfterMissingArgument(cmd: Command, example: string): Command {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  const usage = `(use ${names.join(' ')} --help for usage)`;
  const error = cmd.error.bind(cmd);
  cmd.error = (message, errorOptions) => {
    cmd.showHelpAfterError(errorOptions?.code === 'commander.missingArgument' ? example : usage);
    return error(message, errorOptions);
  };
  return cmd;
}
