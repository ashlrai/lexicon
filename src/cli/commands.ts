/**
 * CLI command handlers. Every handler is a plain async function that takes its
 * (already parsed) options plus an `io` sink and returns an exit code, so the
 * commander wiring in index.ts stays trivial and the handlers are unit-testable
 * without spawning a process.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectClipboardBackend } from '../daemon/clipboard-backends.js';
import { DEFAULT_MODEL, resolveModel } from '../voice/models.js';
import { findPackageRoot, whichBin } from './cli-entry.js';
import { SYSTEMD_UNIT_NAME, launchAgentPath, programPathFromPlist, programPathFromUnit, serveLabel, systemdUnitPath } from './serve-paths.js';
import { WHISPER_BIN_NAMES, installHint, locateToolSync } from '../voice/process.js';
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_INFO,
  addTerm,
  diffSummary,
  emptyLexicon,
  exportLexicon,
  getTrustPath,
  harvestRepo,
  isTrusted,
  loadLexicon,
  normalize,
  readLexiconFile,
  removeTerm,
  resolvePaths,
  sanitizeForDisplay,
  suggestAliases,
  trustProject,
  writeLexiconFile,
} from '../core/index.js';
import type {
  ExportFormat,
  ExportOptions,
  HarvestCandidate,
  HarvestOptions,
  LexiconFile,
  LoadedLexicon,
  NormalizeOptions,
  Term,
  TermCategory,
  TermScope,
} from '../core/index.js';
import { runHarvestInteractive } from './cmd-review.js';
import { createPrompter, isInteractive, splitList } from './prompt.js';
import type { Prompter } from './prompt.js';

// ---------------------------------------------------------------------------
// IO + shared helpers
// ---------------------------------------------------------------------------

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

export interface CommonOptions {
  /** Directory used for project-lexicon discovery. Default process.cwd(). */
  cwd?: string;
}

const PROJECT_FILE_NAME = '.lexicon.yaml';

const CATEGORIES: readonly TermCategory[] = [
  'brand',
  'person',
  'product',
  'acronym',
  'identifier',
  'place',
  'other',
];

/** Minimal ANSI styling, only when writing to a terminal. No dependency. */
function paint(code: string): (s: string) => string {
  return (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
}
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');

function line(io: IO, s = ''): void {
  io.stdout(`${s}\n`);
}

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

function ensureNewline(s: string): string {
  return s.endsWith('\n') || s === '' ? s : `${s}\n`;
}

function resolveCwd(opts: CommonOptions): string {
  return path.resolve(opts.cwd ?? process.cwd());
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One stderr line when a project lexicon exists but was not merged (untrusted or changed). */
function warnSkippedProject(loaded: Pick<LoadedLexicon, 'projectTrust' | 'skippedProject'>, io: IO): void {
  if (!loaded.skippedProject) return;
  const why = loaded.projectTrust === 'changed' ? 'changed since trusted' : 'untrusted';
  io.stderr(`lexicon: ${why} project lexicon skipped: ${safe(loaded.skippedProject.path)} (run: lexicon trust)\n`);
}

function findGitRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function parseIntOption(value: string | number | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
}

function parseCategory(value: string | undefined): TermCategory | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (!(CATEGORIES as readonly string[]).includes(lower)) {
    throw new Error(`unknown category "${value}" (expected one of: ${CATEGORIES.join(', ')})`);
  }
  return lower as TermCategory;
}

/** Like parseCategory but returns undefined instead of throwing (interactive re-ask loops). */
function parseCategoryLoose(value: string): TermCategory | undefined {
  const lower = value.trim().toLowerCase();
  return (CATEGORIES as readonly string[]).includes(lower) ? (lower as TermCategory) : undefined;
}

function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

/** Locate an executable on PATH (a tiny `which`). Lives in cli-entry.ts; re-exported for callers and tests. */
export { whichBin } from './cli-entry.js';

/**
 * Read all of stdin as UTF-8. With `maxBytes` the read is abandoned (and an
 * Error thrown) as soon as more than that has arrived, so a runaway pipe
 * cannot be buffered whole before the caller gets to refuse it.
 */
export async function readStdin(maxBytes?: number): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write('lexicon: reading text from stdin (press ctrl-D to finish)\n');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new Error(`stdin exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

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
// init
// ---------------------------------------------------------------------------

export interface InitOptions extends CommonOptions {
  project?: boolean;
}

const EXAMPLE_TERM_COMMENT = `
# Example term. To enable it, replace the empty \`terms: []\` above with:
#
# terms:
#   - canonical: Ashlr.AI
#     aliases: [Ashler, Ashlar, Ashler AI, Ashley our AI]
#     phonetic: ASH-ler
#     category: brand
#     notes: my company; never write Ashlar
#
# Or simply run:  lexicon add "Ashlr.AI" Ashler Ashlar --category brand
`;

export async function runInit(opts: InitOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  const paths = resolvePaths({ cwd });
  const scope: TermScope = opts.project ? 'project' : 'global';
  const target = opts.project
    ? (paths.project ?? path.join(findGitRoot(cwd) ?? cwd, PROJECT_FILE_NAME))
    : paths.global;

  if (existsSync(target)) {
    line(io, `${scope} lexicon already exists: ${safe(target)}`);
    return 0;
  }

  const lexicon = emptyLexicon();
  lexicon.settings = { minConfidence: 0.82, phonetic: true, fuzzy: true, skipCode: true };
  const file: LexiconFile = { path: target, scope, lexicon, exists: false };
  await writeLexiconFile(file);
  // YAML comments survive round-trips as far as parsing goes (they are simply
  // ignored), so appending the example after the generated body is safe.
  await fs.appendFile(target, EXAMPLE_TERM_COMMENT, 'utf8');
  line(io, `created ${scope} lexicon: ${safe(target)}`);
  if (scope === 'project') {
    // The user asked for this file; that is the approval `lexicon trust` records.
    await trustProject(target, { cwd });
    line(io, dim(`trusted ${safe(target)} (it is re-pinned by lexicon add/harvest; after hand edits run: lexicon trust)`));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// add / remove
// ---------------------------------------------------------------------------

export interface AddOptions extends CommonOptions {
  phonetic?: string;
  category?: string;
  notes?: string;
  project?: boolean;
  suggest?: boolean;
  never?: string[];
  /** `-i`: confirm suggested aliases as a checklist, then ask for phonetic and category. */
  interactive?: boolean;
  /** Explicit global lexicon path (test hook, no CLI flag). */
  globalPath?: string;
}

export async function runAdd(
  canonical: string,
  aliasArgs: readonly string[],
  opts: AddOptions,
  io: IO,
  prompter?: Prompter,
): Promise<number> {
  const trimmed = canonical.trim();
  if (!trimmed) throw new Error('canonical must not be empty');
  const cwd = resolveCwd(opts);
  const scope: TermScope = opts.project ? 'project' : 'global';
  if (opts.interactive && !prompter && !isInteractive()) {
    throw new Error('add --interactive needs a terminal (stdin and stdout must be a TTY); pass aliases as arguments instead');
  }
  const ownPrompter = opts.interactive && !prompter;
  const p: Prompter | undefined = opts.interactive
    ? (prompter ?? createPrompter({ input: process.stdin, output: process.stdout }))
    : undefined;

  const aliases = aliasArgs.map((a) => a.trim()).filter(Boolean);
  let suggested: string[] = [];
  if (opts.suggest || aliases.length === 0) {
    const have = new Set(aliases.map((a) => a.toLowerCase()));
    suggested = suggestAliases(trimmed).filter((s) => {
      const key = s.toLowerCase();
      if (key === trimmed.toLowerCase() || have.has(key)) return false;
      have.add(key);
      return true;
    });
    if (p && aliasArgs.length === 0) {
      // Interactive: the suggestions are a checklist, not a fait accompli.
      const kept =
        suggested.length > 0
          ? await p.choose(
              `aliases for ${trimmed} (what STT is likely to write)`,
              suggested.map((s) => ({ label: s, value: s })),
              { multi: true },
            )
          : [];
      const extra = splitList(await p.ask('more aliases (comma-separated, Enter for none)')).filter((a) => {
        const key = a.toLowerCase();
        if (key === trimmed.toLowerCase() || kept.some((k) => k.toLowerCase() === key)) return false;
        return true;
      });
      suggested = kept;
      aliases.push(...kept, ...extra);
    } else {
      aliases.push(...suggested);
    }
  }

  const term: Term = { canonical: trimmed, aliases };
  if (opts.phonetic) term.phonetic = opts.phonetic;
  let category = parseCategory(opts.category);
  if (p) {
    try {
      const phonetic = (await p.ask('phonetic hint (e.g. ASH-ler, Enter for none)', { default: opts.phonetic ?? '' })).trim();
      if (phonetic) term.phonetic = phonetic;
      else delete term.phonetic;
      for (;;) {
        const answer = (await p.ask(`category (${CATEGORIES.join('|')})`, { default: category ?? 'other' })).trim();
        const parsed = parseCategoryLoose(answer);
        if (parsed) {
          category = parsed;
          break;
        }
        io.stderr(`lexicon: unknown category "${answer}"\n`);
      }
    } finally {
      if (ownPrompter) p.close();
    }
  }
  if (category) term.category = category;
  if (opts.notes) term.notes = opts.notes;
  const never = (opts.never ?? []).map((w) => w.trim()).filter(Boolean);
  if (never.length > 0) term.never = never;

  const result = await addTerm(term, { scope, cwd, ...(opts.globalPath ? { globalPath: opts.globalPath } : {}) });
  line(io, `${result.created ? green('created') : green('merged')} ${bold(safe(result.term.canonical))} (${scope}) in ${safe(result.file.path)}`);
  if (suggested.length > 0 && !p) line(io, `suggested aliases: ${safe(suggested.join(', '))}`);
  line(io, `aliases: ${result.term.aliases.length > 0 ? safe(result.term.aliases.join(', ')) : dim('(none)')}`);
  if (scope === 'project') line(io, dim(`project lexicon trusted at its new content (${safe(result.file.path)})`));
  return 0;
}

export interface RemoveOptions extends CommonOptions {
  project?: boolean;
}

export async function runRemove(canonical: string, opts: RemoveOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  const removed = await removeTerm(canonical, opts.project ? { scope: 'project', cwd } : { cwd });
  if (!removed) {
    io.stderr(`lexicon: term "${safe(canonical)}" not found${opts.project ? ' in project lexicon' : ''}\n`);
    return 1;
  }
  line(io, `removed ${bold(safe(canonical))}`);
  return 0;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListOptions extends CommonOptions {
  json?: boolean;
  category?: string;
  query?: string;
}

export async function runList(opts: ListOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  const loaded = await loadLexicon({ cwd });
  warnSkippedProject(loaded, io);
  let terms = loaded.merged.terms;
  const category = parseCategory(opts.category);
  if (category) terms = terms.filter((t) => t.category === category);
  if (opts.query) {
    const q = opts.query.toLowerCase();
    terms = terms.filter(
      (t) => t.canonical.toLowerCase().includes(q) || t.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }

  if (opts.json) {
    line(io, JSON.stringify(terms, null, 2));
    return 0;
  }

  if (terms.length === 0) {
    line(io, dim('no terms' + (opts.query || category ? ' match' : ' yet — try: lexicon add "Ashlr.AI" Ashler')));
  } else {
    const rows = terms.map((t) => [
      t.canonical,
      t.aliases.join(', '),
      t.category ?? '',
      String(t.hits ?? 0),
    ]);
    io.stdout(renderTable(rows, ['canonical', 'aliases', 'category', 'hits']));
  }
  line(io);
  line(io, `global: ${safe(loaded.global.path)}`);
  const projectLabel = loaded.project
    ? safe(loaded.project.path)
    : loaded.skippedProject
      ? `${safe(loaded.skippedProject.path)} (${loaded.projectTrust === 'changed' ? 'changed since trusted' : 'untrusted'}, not loaded)`
      : '(none)';
  line(io, `project: ${projectLabel}`);
  return 0;
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

export interface NormalizeCliOptions extends CommonOptions {
  json?: boolean;
  diff?: boolean;
  dryRun?: boolean;
  minConfidence?: string | number;
  /** commander `--no-phonetic`: true unless the flag was given. Only `false` is forwarded. */
  phonetic?: boolean;
  /** commander `--no-fuzzy`: same convention as phonetic. */
  fuzzy?: boolean;
  /** Merge the project lexicon even when it is not trusted. */
  includeUntrusted?: boolean;
}

export function buildNormalizeOptions(opts: NormalizeCliOptions): NormalizeOptions {
  const out: NormalizeOptions = {};
  if (opts.minConfidence !== undefined) {
    const n = typeof opts.minConfidence === 'number' ? opts.minConfidence : Number(opts.minConfidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new Error('--min-confidence must be a number between 0 and 1');
    }
    out.minConfidence = n;
  }
  // Only forward explicit disables so the lexicon's own settings stay in charge otherwise.
  if (opts.phonetic === false) out.phonetic = false;
  if (opts.fuzzy === false) out.fuzzy = false;
  if (opts.dryRun) out.dryRun = true;
  return out;
}

/**
 * `lexicon normalize`: a filter. Always exits 0; if the lexicon cannot be loaded
 * the input is passed through unchanged and the problem is reported on stderr.
 */
export async function runNormalize(
  args: readonly string[],
  opts: NormalizeCliOptions,
  io: IO,
  readInput: () => Promise<string> = readStdin,
): Promise<number> {
  const fromArgs = args.length > 0;
  const text = fromArgs ? args.join(' ') : await readInput();
  const normalizeOpts = buildNormalizeOptions(opts);
  const emit = (s: string): void => {
    io.stdout(fromArgs ? `${s}\n` : s);
  };

  if (text.length === 0) {
    if (opts.json) line(io, JSON.stringify({ input: '', output: '', replacements: [], changed: false }));
    return 0;
  }

  try {
    const loaded = await loadLexicon({ cwd: resolveCwd(opts), includeUntrusted: opts.includeUntrusted === true });
    warnSkippedProject(loaded, io);
    const result = normalize(text, loaded.merged, normalizeOpts);
    if (opts.json) {
      line(io, JSON.stringify(result, null, 2));
      return 0;
    }
    if (opts.diff) {
      const summary = diffSummary(result);
      // stdout must round-trip the user's text byte-exactly; the stderr diff quotes lexicon content, so it is sanitized per line.
      if (summary) io.stderr(ensureNewline(safeLines(summary)));
    }
    emit(result.output);
  } catch (err) {
    io.stderr(`lexicon: ${safeLines(errorMessage(err))} (passing text through unchanged)\n`);
    if (opts.json) {
      line(io, JSON.stringify({ input: text, output: text, replacements: [], changed: false }, null, 2));
    } else {
      emit(text);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// harvest
// ---------------------------------------------------------------------------

export interface HarvestCliOptions extends CommonOptions {
  limit?: string | number;
  minCount?: string | number;
  add?: boolean;
  json?: boolean;
  /** `-i`: walk candidates one by one. Implied by `--add` on a terminal unless `--yes`. */
  interactive?: boolean;
  /** With `--add`: add every candidate without prompting even on a terminal. */
  yes?: boolean;
  /** Explicit global lexicon path (test hook, no CLI flag). */
  globalPath?: string;
}

/** Test hooks for runHarvest: TTY detection and the prompter used for the walkthrough. */
export interface HarvestDeps {
  isInteractive?: () => boolean;
  createPrompter?: () => Prompter;
}

export async function runHarvest(
  root: string | undefined,
  opts: HarvestCliOptions,
  io: IO,
  deps: HarvestDeps = {},
): Promise<number> {
  const cwd = resolveCwd(opts);
  const target = path.resolve(cwd, root ?? '.');
  if (!existsSync(target)) throw new Error(`harvest: path does not exist: ${safe(target)}`);

  const tty = (deps.isInteractive ?? isInteractive)();
  if (opts.interactive && !tty) {
    throw new Error(
      'harvest --interactive needs a terminal (stdin and stdout must be a TTY); use --add --yes to add every candidate without prompts',
    );
  }
  if (opts.interactive && opts.json) throw new Error('harvest: --interactive and --json cannot be combined');
  const interactive = opts.interactive === true || (opts.add === true && !opts.yes && !opts.json && tty);

  const harvestOpts: HarvestOptions = {};
  const limit = parseIntOption(opts.limit, '--limit');
  const minCount = parseIntOption(opts.minCount, '--min-count');
  if (limit !== undefined) harvestOpts.limit = limit;
  if (minCount !== undefined) harvestOpts.minCount = minCount;

  const candidates: HarvestCandidate[] = await harvestRepo(target, harvestOpts);

  if (interactive) {
    // The walkthrough is the display; the table would only repeat it.
    const prompter = (deps.createPrompter ?? (() => createPrompter({ input: process.stdin, output: process.stdout })))();
    try {
      return await runHarvestInteractive(
        candidates,
        { cwd: target, ...(opts.globalPath ? { globalPath: opts.globalPath } : {}) },
        io,
        prompter,
      );
    } finally {
      prompter.close();
    }
  }

  if (opts.json) {
    line(io, JSON.stringify(candidates, null, 2));
  } else if (candidates.length === 0) {
    line(io, dim(`no candidates found in ${safe(target)}`));
  } else {
    const rows = candidates.map((c) => [
      c.canonical,
      c.category,
      String(c.count),
      c.suggestedAliases.join(', '),
      c.evidence[0] ?? '',
    ]);
    io.stdout(renderTable(rows, ['canonical', 'category', 'count', 'suggested aliases', 'evidence']));
  }

  if (opts.add && candidates.length > 0) {
    let created = 0;
    let merged = 0;
    let filePath: string | undefined;
    for (const c of candidates) {
      const term: Term = {
        canonical: c.canonical,
        aliases: c.suggestedAliases,
        category: c.category,
        source: c.source,
      };
      const result = await addTerm(term, { scope: 'project', cwd: target });
      filePath = result.file.path;
      if (result.created) created += 1;
      else merged += 1;
    }
    const where = filePath ? ` in ${safe(filePath)}` : '';
    const summary = `added ${created} new term${created === 1 ? '' : 's'}, merged ${merged}${where}`;
    if (opts.json) io.stderr(`${summary}\n`);
    else line(io, green(summary));
    // addTerm(scope: 'project') registers the file as trusted at its new content.
    if (filePath && !opts.json) line(io, dim(`project lexicon trusted (${safe(filePath)})`));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export interface ExportCliOptions extends CommonOptions {
  out?: string;
  category?: string[];
  limit?: string | number;
}

function formatList(): string {
  const rows = EXPORT_FORMATS.map((f) => [f, EXPORT_FORMAT_INFO[f].description, `.${EXPORT_FORMAT_INFO[f].ext}`]);
  return `available formats:\n${renderTable(rows)}`;
}

export async function runExport(format: string | undefined, opts: ExportCliOptions, io: IO): Promise<number> {
  if (format === undefined) {
    line(io, 'usage: lexicon export <format> [--out <file>] [--category <c...>] [--limit <n>]');
    io.stdout(formatList());
    return 0;
  }
  if (!isExportFormat(format)) {
    io.stderr(`lexicon: unknown export format "${safe(format)}"\n`);
    io.stderr(formatList());
    return 1;
  }

  const exportOpts: ExportOptions = {};
  if (opts.category && opts.category.length > 0) {
    exportOpts.categories = opts.category.map((c) => parseCategory(c)).filter((c): c is TermCategory => !!c);
  }
  const limit = parseIntOption(opts.limit, '--limit');
  if (limit !== undefined) exportOpts.limit = limit;

  const cwd = resolveCwd(opts);
  const { merged } = await loadLexicon({ cwd });
  const text = exportLexicon(merged, format, exportOpts);

  if (opts.out) {
    const outPath = path.resolve(cwd, opts.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, ensureNewline(text), 'utf8');
    line(io, `wrote ${format} export (${merged.terms.length} terms) to ${safe(outPath)}`);
  } else {
    io.stdout(ensureNewline(text));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// path
// ---------------------------------------------------------------------------

export async function runPath(opts: CommonOptions, io: IO): Promise<number> {
  const paths = resolvePaths({ cwd: resolveCwd(opts) });
  line(io, `global: ${safe(paths.global)}`);
  line(io, `project: ${paths.project ? safe(paths.project) : '(none)'}`);
  return 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/** Obvious English words that make terrible aliases (they'd fire constantly). */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did',
  'get', 'let', 'say', 'she', 'too', 'use', 'off', 'ash', 'sauce', 'with', 'this', 'that', 'from',
  'they', 'have', 'been', 'will', 'what', 'when', 'your', 'there', 'their', 'about', 'which', 'time',
  'like', 'just', 'over', 'also', 'into', 'some', 'than', 'then', 'them', 'well', 'were', 'more',
]);

export interface DoctorDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Run a binary and return stdout; must throw on failure. */
  exec?: (file: string, args: readonly string[]) => string;
  /** Claude settings file. Default ~/.claude/settings.json. */
  settingsPath?: string;
  /** Claude's plugin registry. Default ~/.claude/plugins/installed_plugins.json. */
  installedPluginsPath?: string;
  /** Home directory the login service files live under. Default os.homedir(). */
  home?: string;
  /** Numeric uid for `launchctl print gui/<uid>/<label>`. Default process.getuid(). */
  uid?: number;
}

/** Hook events the lexicon hook handles; `install-claude` registers both. */
export const HOOK_EVENTS: readonly string[] = ['UserPromptSubmit', 'SessionStart'];

/** Commands `install-claude` (any version) or the plugin register for the hook. */
const LEXICON_HOOK_COMMAND = /user-prompt-submit\.js|plugin[\\/]hook\.mjs|lexicon/i;

interface JsonFileRead {
  exists: boolean;
  value?: unknown;
  error?: string;
}

async function readJsonFile(file: string): Promise<JsonFileRead> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT') return { exists: false };
    return { exists: true, error: errorMessage(err) };
  }
  try {
    return { exists: true, value: raw.trim() === '' ? {} : (JSON.parse(raw) as unknown) };
  } catch (err) {
    return { exists: true, error: errorMessage(err) };
  }
}

/**
 * The id (`lexicon@<marketplace>`) under which the lexicon plugin is recorded,
 * either in Claude's plugin registry (`installed_plugins.json`, `plugins` keyed
 * by id) or in settings.json `enabledPlugins`; undefined when neither lists it.
 */
export function findInstalledLexiconPlugin(settings: unknown, installedPlugins: unknown): string | undefined {
  const isLexicon = (id: string): boolean => /^lexicon@/i.test(id);
  if (isRecord(installedPlugins) && isRecord(installedPlugins.plugins)) {
    const id = Object.keys(installedPlugins.plugins).find(isLexicon);
    if (id) return id;
  }
  if (isRecord(settings) && isRecord(settings.enabledPlugins)) {
    const id = Object.entries(settings.enabledPlugins).find(([k, v]) => isLexicon(k) && v === true)?.[0];
    if (id) return id;
  }
  return undefined;
}

/** True when settings.json registers a lexicon hook command for `event`. */
export function settingsHasLexiconHook(settings: unknown, event: string): boolean {
  if (!isRecord(settings) || !isRecord(settings.hooks)) return false;
  const groups = settings.hooks[event];
  if (!Array.isArray(groups)) return false;
  return groups.some(
    (g) =>
      isRecord(g) &&
      Array.isArray(g.hooks) &&
      g.hooks.some((h) => isRecord(h) && typeof h.command === 'string' && LEXICON_HOOK_COMMAND.test(h.command)),
  );
}

export type DoctorLevel = 'ok' | 'fail' | 'warn' | 'info';

export interface DoctorCheck {
  level: DoctorLevel;
  /** Unsanitized: quotes paths, canonicals, aliases and error text. Renderers apply `safeLines`. */
  message: string;
}

/** Structured `lexicon doctor` result; `runDoctor` renders it, the MCP `lexicon_doctor` tool returns it as JSON. */
export interface DoctorReport {
  /** True when no check is at level `fail`. */
  ok: boolean;
  checks: DoctorCheck[];
  paths: {
    global: string;
    project?: string;
    /** Trust registry next to the global lexicon. */
    trust: string;
    /** Claude Code settings.json that was inspected for hooks. */
    settings: string;
    /** Claude Code plugin registry that was inspected. */
    installedPlugins: string;
  };
  versions: {
    lexicon: string;
    node: string;
    platform: NodeJS.Platform;
  };
}

function defaultExec(file: string, args: readonly string[]): string {
  return execFileSync(file, [...args], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * Version of the @ashlr/lexicon package.json: two levels above src/cli or
 * dist/cli, one level above the plugin/ bundles (which inline this module).
 * '0.0.0' when neither can be read.
 */
function readCliPackageVersion(): string {
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      const raw = readFileSync(new URL(rel, import.meta.url), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && parsed.name === '@ashlr/lexicon' && typeof parsed.version === 'string') return parsed.version;
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

interface LoginServiceProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exec: (file: string, args: readonly string[]) => string;
  home: string;
  uid?: number;
}

const SERVE_REINSTALL_HINT = 'run: lexicon serve --uninstall && lexicon serve --install';

/**
 * One check for the `lexicon serve` login service. darwin: `launchctl print
 * gui/<uid>/<label>` (loaded when it exits 0) and the plist's program path;
 * linux: `systemctl --user is-active lexicon-serve.service` and the unit's
 * ExecStart path. A loaded service whose program file is missing is a `fail`
 * (it crash-loops under KeepAlive and nothing listens on the port); a service
 * file that exists but is not loaded is a `warn`; no service is an `info`.
 */
export async function checkLoginService(probe: LoginServiceProbe): Promise<DoctorCheck> {
  const { platform, env, exec, home } = probe;
  let loaded = false;
  let file: string | undefined;
  let program: string | undefined;
  let name: string;
  if (platform === 'darwin') {
    name = `login service ${serveLabel(env)}`;
    const uid = probe.uid ?? process.getuid?.() ?? 501;
    try {
      exec('launchctl', ['print', `gui/${uid}/${serveLabel(env)}`]);
      loaded = true;
    } catch {
      loaded = false;
    }
    file = launchAgentPath(home, env);
  } else if (platform === 'linux') {
    name = `login service ${SYSTEMD_UNIT_NAME}`;
    try {
      loaded = exec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]).trim() === 'active';
    } catch {
      loaded = false;
    }
    file = systemdUnitPath(home, env);
  } else {
    return { level: 'info', message: `login service is not automated on ${platform} (lexicon serve --install prints the Scheduled Task command)` };
  }
  let fileExists = false;
  try {
    const text = await fs.readFile(file, 'utf8');
    fileExists = true;
    program = platform === 'darwin' ? programPathFromPlist(text) : programPathFromUnit(text);
  } catch {
    fileExists = false;
  }
  if (!loaded && !fileExists) {
    return { level: 'info', message: 'no login service installed (optional; keeps the local API up: lexicon serve --install)' };
  }
  if (program !== undefined && !existsSync(program)) {
    return { level: 'fail', message: `${name} points at a missing file: ${program} (${SERVE_REINSTALL_HINT})` };
  }
  if (!loaded) {
    return { level: 'warn', message: `${name} is installed at ${file} but not loaded (${SERVE_REINSTALL_HINT})` };
  }
  return { level: 'ok', message: `${name} loaded${program !== undefined ? ` (${program} exists)` : fileExists ? '' : ` (${file} not found; it was loaded from elsewhere)`}` };
}

/** Check messages quote paths, canonicals, aliases and error text, so the whole message is sanitized here. */
function renderCheck(c: DoctorCheck): string {
  const message = safeLines(c.message);
  switch (c.level) {
    case 'ok':
      return `${green('✓')} ${message}`;
    case 'fail':
      return `${red('✗')} ${message}`;
    case 'warn':
      return `${yellow('!')} ${message}`;
    default:
      return `${dim('·')} ${message}`;
  }
}

/** Prints a report the way `lexicon doctor` always has: one line per check, a blank line, then the verdict. Returns the exit code. */
export function renderDoctorReport(report: DoctorReport, io: IO): number {
  for (const c of report.checks) line(io, renderCheck(c));
  const failures = report.checks.filter((c) => c.level === 'fail').length;
  line(io);
  line(io, failures === 0 ? green('all checks passed') : red(`${failures} check${failures === 1 ? '' : 's'} failed`));
  return failures === 0 ? 0 : 1;
}

export async function runDoctor(opts: CommonOptions, io: IO, deps: DoctorDeps = {}): Promise<number> {
  return renderDoctorReport(await runDoctorReport(opts, deps), io);
}

/**
 * Runs every doctor check and returns them as data (no output). `runDoctor`
 * is this plus rendering; the MCP server hands the report to the model as is.
 */
export async function runDoctorReport(opts: CommonOptions, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exec = deps.exec ?? defaultExec;
  const cwd = resolveCwd(opts);
  const checks: DoctorCheck[] = [];
  const push = (level: DoctorLevel, message: string): void => {
    checks.push({ level, message });
  };

  // --- lexicon files -------------------------------------------------------
  const paths = resolvePaths({ cwd });
  const files: LexiconFile[] = [];

  try {
    const g = await readLexiconFile(paths.global, 'global');
    if (g.exists) {
      push('ok', `global lexicon parses: ${paths.global} (${g.lexicon.terms.length} terms)`);
      files.push(g);
    } else {
      push('fail', `global lexicon missing: ${paths.global} (run: lexicon init)`);
    }
  } catch (err) {
    push('fail', `global lexicon: ${errorMessage(err)}`);
  }

  if (paths.project) {
    try {
      const p = await readLexiconFile(paths.project, 'project');
      push('ok', `project lexicon parses: ${paths.project} (${p.lexicon.terms.length} terms)`);
      const trust = await isTrusted(p, { cwd });
      if (trust === 'trusted') {
        push('ok', 'project lexicon is trusted and merged');
        files.push(p);
      } else if (trust === 'changed') {
        push('warn', `project lexicon content changed since trusted; not merged (run lexicon trust again)`);
      } else {
        push('warn', `project lexicon is untrusted and not merged: ${paths.project} (review it, then run: lexicon trust)`);
      }
    } catch (err) {
      push('fail', `project lexicon: ${errorMessage(err)}`);
    }
  } else {
    push('info', 'no project lexicon (.lexicon.yaml) found from ' + cwd);
  }

  // --- term-level checks -----------------------------------------------------
  const canonicalOwners = new Map<string, { term: Term; scope: TermScope }[]>();
  const allTerms: { term: Term; scope: TermScope }[] = [];
  for (const f of files) {
    for (const term of f.lexicon.terms) {
      const entry = { term, scope: f.scope };
      allTerms.push(entry);
      const key = term.canonical.trim().toLowerCase();
      const list = canonicalOwners.get(key) ?? [];
      list.push(entry);
      canonicalOwners.set(key, list);
    }
  }
  push('info', `${canonicalOwners.size} unique terms across ${files.length} file${files.length === 1 ? '' : 's'}`);

  for (const [, owners] of canonicalOwners) {
    const scopes = new Set(owners.map((o) => o.scope));
    if (scopes.size > 1) {
      push('warn', `"${owners[0].term.canonical}" is defined in both global and project lexicons (project wins, aliases merge)`);
    } else if (owners.length > 1) {
      push('fail', `"${owners[0].term.canonical}" is defined ${owners.length} times in the ${owners[0].scope} lexicon`);
    }
  }

  const aliasOwners = new Map<string, Term[]>();
  for (const { term } of allTerms) {
    for (const alias of term.aliases) {
      const key = alias.trim().toLowerCase();
      if (!key) continue;
      const other = canonicalOwners.get(key);
      if (other && !other.some((o) => o.term === term) && key !== term.canonical.trim().toLowerCase()) {
        push('fail', `alias "${alias}" of "${term.canonical}" equals the canonical of "${other[0].term.canonical}" (conflict)`);
      }
      if (COMMON_WORDS.has(key)) {
        push('warn', `alias "${alias}" of "${term.canonical}" is a common English word and will fire on ordinary text`);
      }
      const list = aliasOwners.get(key) ?? [];
      list.push(term);
      aliasOwners.set(key, list);
    }
  }
  for (const [alias, owners] of aliasOwners) {
    const distinct = new Set(owners.map((t) => t.canonical.toLowerCase()));
    if (distinct.size > 1) {
      push('warn', `alias "${alias}" belongs to several terms: ${[...distinct].join(', ')} (ambiguous)`);
    }
  }
  if (allTerms.length > 0 && !checks.some((c) => c.level === 'fail' && c.message.includes('conflict'))) {
    push('ok', 'no alias/canonical conflicts');
  }

  // --- Claude Code plugin / hooks -------------------------------------------------
  const settingsPath = deps.settingsPath ?? path.join(os.homedir(), '.claude', 'settings.json');
  const installedPluginsPath =
    deps.installedPluginsPath ?? path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  const settings = await readJsonFile(settingsPath);
  const installed = await readJsonFile(installedPluginsPath);
  if (settings.error) push('warn', `could not parse ${settingsPath}: ${settings.error}`);
  const pluginId = findInstalledLexiconPlugin(settings.value, installed.value);
  if (pluginId) {
    push('ok', `lexicon plugin installed as ${pluginId} (its hooks and MCP server are used)`);
  } else {
    for (const event of HOOK_EVENTS) {
      if (settingsHasLexiconHook(settings.value, event)) {
        push('ok', `${event} hook found in ${settingsPath}`);
      } else {
        push(
          'warn',
          `${event} hook not found in ${settingsPath} (fine if you use the plugin; otherwise run: lexicon install-claude --apply)`,
        );
      }
    }
  }

  // --- claude CLI ---------------------------------------------------------------
  const claudeBin = whichBin('claude', env);
  if (!claudeBin) {
    push('warn', 'claude CLI not found on PATH (MCP + hook integration unavailable)');
  } else {
    push('ok', `claude CLI found: ${claudeBin}`);
    try {
      const out = exec('claude', ['mcp', 'list']);
      if (/lexicon/i.test(out)) push('ok', 'lexicon MCP server is registered with claude');
      else if (pluginId) push('warn', `lexicon MCP server not listed by "claude mcp list"; the ${pluginId} plugin provides it when enabled`);
      else push('fail', 'lexicon MCP server not registered with claude (run: lexicon install-claude --apply)');
    } catch (err) {
      push('warn', `could not run "claude mcp list": ${errorMessage(err)}`);
    }
  }

  // --- login service (lexicon serve --install) ------------------------------------
  checks.push(await checkLoginService({ platform, env, exec, home: deps.home ?? os.homedir(), ...(deps.uid !== undefined ? { uid: deps.uid } : {}) }));

  // --- clipboard -----------------------------------------------------------------
  try {
    const backend = await detectClipboardBackend(platform, env, async (bin) => whichBin(bin, env) !== undefined);
    push('ok', `clipboard backend: ${backend.name}${backend.description ? ` (${backend.description})` : ''}`);
  } catch (err) {
    push('warn', `no clipboard backend found (${errorMessage(err)})`);
  }

  // --- voice (lexicon voice: ffmpeg -> whisper.cpp) ------------------------------
  // Warnings only: dictation is optional and the rest of the tool works without it.
  const whisperOverride = env.LEXICON_WHISPER_BIN;
  const whisperCli = whisperOverride ? (existsSync(whisperOverride) ? whisperOverride : undefined) : locateToolSync(WHISPER_BIN_NAMES, env, platform);
  if (whisperCli) push('ok', `whisper-cli found: ${whisperCli}`);
  else push('warn', `whisper-cli not found (needed by lexicon voice; ${installHint(platform)})`);
  const ffmpegOverride = env.LEXICON_FFMPEG_BIN;
  const ffmpegBin = ffmpegOverride ? (existsSync(ffmpegOverride) ? ffmpegOverride : undefined) : locateToolSync(['ffmpeg'], env, platform);
  if (ffmpegBin) push('ok', `ffmpeg found: ${ffmpegBin}`);
  else push('warn', `ffmpeg not found (needed by lexicon voice; ${installHint(platform)})`);
  const model = resolveModel(DEFAULT_MODEL, { globalPath: paths.global, env });
  push('info', model.present ? `whisper model ${DEFAULT_MODEL} present: ${model.path}` : `whisper model ${DEFAULT_MODEL} absent (lexicon voice downloads it to ${model.path} on first run)`);
  if (platform === 'darwin') {
    push('info', 'lexicon voice records the microphone: the terminal or launcher running it needs Microphone permission (System Settings > Privacy & Security > Microphone)');
  }

  return {
    ok: !checks.some((c) => c.level === 'fail'),
    checks,
    paths: {
      global: paths.global,
      ...(paths.project ? { project: paths.project } : {}),
      trust: getTrustPath({ cwd }),
      settings: settingsPath,
      installedPlugins: installedPluginsPath,
    },
    versions: { lexicon: readCliPackageVersion(), node: process.version, platform },
  };
}

// ---------------------------------------------------------------------------
// install-claude
// ---------------------------------------------------------------------------

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hookConfigFor(
  command: string,
  timeout = 5,
  events: readonly string[] = ['UserPromptSubmit'],
): { hooks: Record<string, HookGroup[]> } {
  const hooks: Record<string, HookGroup[]> = {};
  for (const event of events) hooks[event] = [{ hooks: [{ type: 'command', command, timeout }] }];
  return { hooks };
}

/**
 * Merge a hook running `command` for each of `events` into a Claude settings
 * object. Never mutates the input. Existing hooks (any event) are preserved;
 * an event that already has a hook with an identical command is left alone.
 */
export function mergeHookIntoSettings(
  settings: unknown,
  command: string,
  timeout = 5,
  events: readonly string[] = ['UserPromptSubmit'],
): { settings: ClaudeSettings; changed: boolean } {
  const base: ClaudeSettings = isRecord(settings) ? (structuredClone(settings) as ClaudeSettings) : {};
  if (base.hooks !== undefined && !isRecord(base.hooks)) {
    throw new Error('settings.hooks is not an object; refusing to overwrite it');
  }
  const hooks: Record<string, unknown> = isRecord(base.hooks) ? base.hooks : {};
  let changed = false;

  for (const event of events) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new Error(`settings.hooks.${event} is not an array; refusing to overwrite it`);
    }
    const groups: HookGroup[] = Array.isArray(existing) ? (existing as HookGroup[]) : [];
    const alreadyPresent = groups.some(
      (g) => isRecord(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isRecord(h) && h.command === command),
    );
    if (alreadyPresent) continue;
    groups.push({ hooks: [{ type: 'command', command, timeout }] });
    hooks[event] = groups;
    changed = true;
  }

  if (changed) base.hooks = hooks as Record<string, HookGroup[]>;
  return { settings: base, changed };
}

export interface IntegrationPaths {
  /** Absolute path to the MCP server entry point. */
  server: string;
  /** Absolute path to the hook entry point. */
  hook: string;
  /** True when the self-contained bundles under plugin/ were found and chosen. */
  bundled: boolean;
}

/**
 * Where `install-claude` / `install` point clients at. Prefers the
 * self-contained bundles in `<package root>/plugin/` (no node_modules needed
 * at runtime, same files the Claude Code plugin uses) and falls back to the
 * tsc output under `<package root>/dist/` when they are absent (e.g. a
 * checkout that only ran `npm run build`). Without `cliDir` the package root
 * comes from `findPackageRoot` (cli-entry.ts), so the result is the same
 * whether this module runs from dist/ or inlined in the plugin bundle.
 */
export function resolveIntegrationPaths(cliDir?: string): IntegrationPaths {
  const pkgRoot = cliDir === undefined ? findPackageRoot(import.meta.url) : undefined;
  const dir = cliDir ?? (pkgRoot ? path.join(pkgRoot, 'dist', 'cli') : path.dirname(fileURLToPath(import.meta.url)));
  const root = path.resolve(dir, '..', '..');
  const bundledServer = path.join(root, 'plugin', 'mcp-server.mjs');
  const bundledHook = path.join(root, 'plugin', 'hook.mjs');
  if (existsSync(bundledServer) && existsSync(bundledHook)) {
    return { server: bundledServer, hook: bundledHook, bundled: true };
  }
  return {
    server: path.resolve(dir, '../mcp/server.js'),
    hook: path.resolve(dir, '../hooks/user-prompt-submit.js'),
    bundled: false,
  };
}

export interface InstallClaudeOptions extends CommonOptions {
  apply?: boolean;
  scope?: string;
}

/** What an installer did to one file; reported through `InstallClaudeDeps.onWritten` / `InstallDeps.onWritten`. */
export type InstallOutcome = 'created' | 'updated' | 'unchanged';

export interface InstallClaudeDeps {
  /** Directory containing the built CLI (dist/cli). Default: the package root's dist/cli. */
  cliDir?: string;
  /** Claude settings file. Default ~/.claude/settings.json. */
  settingsPath?: string;
  exec?: (file: string, args: readonly string[]) => string;
  /** Called once per config file touched under `--apply` (setup uses it for its summary). */
  onWritten?: (file: string, outcome: InstallOutcome) => void;
}

export const CLAUDE_MD_SNIPPET = 'Read the `lexicon://me` resource before interpreting dictated text.';

export async function runInstallClaude(
  opts: InstallClaudeOptions,
  io: IO,
  deps: InstallClaudeDeps = {},
): Promise<number> {
  const scope = opts.scope ?? 'user';
  if (scope !== 'user' && scope !== 'project') {
    throw new Error(`--scope must be "user" or "project" (got "${scope}")`);
  }
  const { server: serverPath, hook: hookPath, bundled } = resolveIntegrationPaths(deps.cliDir);
  const settingsPath = deps.settingsPath ?? path.join(os.homedir(), '.claude', 'settings.json');
  const exec = deps.exec ?? defaultExec;
  let failed = false;

  // 1. MCP server registration ------------------------------------------------
  const mcpArgs = ['mcp', 'add', '--scope', scope, 'lexicon', '--', 'node', serverPath];
  line(io, bold('1. Register the MCP server'));
  line(io, `   claude ${mcpArgs.map(quoteArg).join(' ')}`);
  if (bundled) line(io, dim('   (self-contained bundle: no node_modules needed at runtime)'));
  if (opts.apply) {
    if (!existsSync(serverPath)) {
      line(io, yellow(`   note: ${safe(serverPath)} does not exist yet (run npm run build first)`));
    }
    try {
      const out = exec('claude', mcpArgs).trim();
      line(io, green(`   ${out || 'registered'}`));
    } catch (err) {
      failed = true;
      line(io, red(`   failed: ${safeLines(errorMessage(err))}`));
    }
  }
  line(io);

  // 2. UserPromptSubmit + SessionStart hooks ----------------------------------------
  // Always quoted: the path is embedded in a shell command string in settings.json.
  const hookCommand = `node "${hookPath.replace(/(["\\$`])/g, '\\$1')}"`;
  line(io, bold(`2. Add the ${HOOK_EVENTS.join(' and ')} hooks`));
  line(io, `   merge into ${safe(settingsPath)}:`);
  line(io, indent(JSON.stringify(hookConfigFor(hookCommand, 5, HOOK_EVENTS), null, 2), '   '));
  if (opts.apply) {
    let current: unknown = {};
    let existed = false;
    try {
      const raw = await fs.readFile(settingsPath, 'utf8');
      existed = true;
      current = raw.trim() === '' ? {} : (JSON.parse(raw) as unknown);
    } catch (err) {
      if (!(typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT')) {
        throw new Error(`could not read ${safe(settingsPath)}: ${safeLines(errorMessage(err))}`);
      }
    }
    const { settings, changed } = mergeHookIntoSettings(current, hookCommand, 5, HOOK_EVENTS);
    if (changed) {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      line(io, green(`   ${existed ? 'updated' : 'created'} ${safe(settingsPath)}: added ${HOOK_EVENTS.join(' + ')} hooks`));
      deps.onWritten?.(settingsPath, existed ? 'updated' : 'created');
    } else {
      line(io, dim(`   ${safe(settingsPath)}: hooks already present, nothing changed`));
      deps.onWritten?.(settingsPath, 'unchanged');
    }
  }
  line(io);

  // 3. CLAUDE.md nudge ----------------------------------------------------------------
  line(io, bold('3. Add to your CLAUDE.md'));
  line(io, `   ${CLAUDE_MD_SNIPPET}`);
  if (!opts.apply) {
    line(io);
    line(io, dim('run again with --apply to perform steps 1 and 2'));
  }
  return failed ? 1 : 0;
}

function quoteArg(s: string): string {
  return /[\s"'$`\\]/.test(s) ? `"${s.replace(/(["\\$`])/g, '\\$1')}"` : s;
}

function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}
