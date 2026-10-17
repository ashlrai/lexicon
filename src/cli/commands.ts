/**
 * The term-management commands -- init, add, remove, list, normalize, harvest,
 * export, path. The larger commands live in their own `cmd-*.ts` modules and
 * are re-exported from here, because commands.js is the import path index.ts,
 * the MCP server and the tests already use.
 *
 * ---------------------------------------------------------------------------
 * Conventions
 * ---------------------------------------------------------------------------
 * Seven waves of parallel work left this tree with several ways of doing each
 * of the following. These are the ones the majority already used, and the ones
 * every module now follows. Prefer them over inventing a variant.
 *
 * 1. HANDLER SHAPE. `run<Command>(args..., opts, io, deps?) => Promise<number>`.
 *    `opts` is the already-parsed CLI options (an interface extending
 *    `CommonOptions`, one JSDoc line per field). `io` is the output sink.
 *    `deps` is optional collaborator injection for tests, every field optional
 *    with a documented default -- never a required parameter, so production
 *    callers write `runThing(opts, io)`.
 *
 * 2. REGISTRATION. Each `cmd-*.ts` exports `register<Area>Commands(program)`
 *    that does nothing but wire commander to the handlers. index.ts calls it.
 *    No behaviour in index.ts, no commander types in a handler.
 *
 * 3. FAILURE. Handlers return an exit code; they do not call `process.exit`.
 *    A user-facing failure is one stderr line and code 1: `return fail(io, err)`
 *    (io.ts). Throw an `Error` only for a programming/usage error the top-level
 *    wiring should report -- and never print and exit from inside a handler.
 *
 * 4. SUCCESS. Human output goes to stdout via `line(io, ...)`; `--json` prints
 *    `JSON.stringify(value, null, 2)` and nothing else. Warnings that do not
 *    fail the command (a skipped project lexicon) go to stderr.
 *
 * 5. UNTRUSTED TEXT. Anything not from a string literal in this repo -- paths,
 *    canonicals, aliases, notes, harvest evidence, error text quoting any of
 *    those -- goes through `safe()` (single line) or `safeLines()` (multi).
 *    `renderTable` does it per cell. See io.ts.
 *
 * 6. FILESYSTEM. Async `node:fs/promises` everywhere; `existsSync` only where
 *    a synchronous answer is genuinely required (doctor's check table, CLI
 *    entry resolution). A file this tool owns and rewrites is written with
 *    `writeFileAtomic` (util/atomic.ts); a JSON config it shares with another
 *    tool is merged with `readJsonFile` / `writeJsonFile` (util/json.ts),
 *    never clobbered.
 *
 * 7. SHARED HELPERS. Terminal-facing ones in io.ts, everything else in
 *    src/util/ (`errorMessage`, `isRecord`, `findOnPath`, ...). If you find
 *    yourself writing a second copy of one, import it instead.
 */
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  DEMO_LEXICON,
  EXPORT_FORMATS,
  TERM_CATEGORIES,
  EXPORT_FORMAT_INFO,
  addTerm,
  diffSummary,
  emptyLexicon,
  isEmptyLexicon,
  exportLexicon,
  resolveExportFormat,
  harvestRepo,
  loadLexicon,
  normalize,
  isProjectTrustError,
  removeAlias,
  removeTerm,
  termHolders,
  untrustedTermHolder,
  resolvePaths,
  spellingConflicts,
  suggestAliases,
  trustProject,
  withLexiconLock,
  writeLexiconFile,
} from '../core/index.js';
import type {
  ExportFormat,
  ExportOptions,
  HarvestCandidate,
  HarvestOptions,
  LexiconFile,
  NormalizeOptions,
  RemoveAliasResult,
  Term,
  TermCategory,
  TermScope,
} from '../core/index.js';
import {
  bold,
  conflictLine,
  dim,
  ensureNewline,
  green,
  line,
  plural,
  renderTable,
  resolveCwd,
  safe,
  safeLines,
  stillInLine,
  untrustedLine,
  warnSkippedProject,
} from './io.js';
import type { CommonOptions, IO } from './io.js';
/**
 * The CLI's terminal surface lives in io.ts; re-exported here because
 * commands.js is the import path the other command modules and the tests use.
 */
export { processIO, renderTable, safe, safeLines } from './io.js';
export type { CommonOptions, IO } from './io.js';
/**
 * `doctor`, `install claude` and the Claude-settings knowledge they share live
 * in their own modules; re-exported here because commands.js is the import
 * path index.ts, the MCP server and the tests already use.
 */
export {
  HOOK_EVENTS,
  findInstalledLexiconPlugin,
  hookConfigFor,
  mergeHookIntoSettings,
  resolveIntegrationPaths,
  settingsHasLexiconHook,
} from './claude-settings.js';
export type { ClaudeSettings, HookCommand, HookGroup, IntegrationPaths } from './claude-settings.js';
export { checkLoginService, renderDoctorReport, runDoctor, runDoctorReport } from './cmd-doctor.js';
export type { DoctorCheck, DoctorDeps, DoctorLevel, DoctorReport } from './cmd-doctor.js';
export { CLAUDE_MD_SNIPPET, runInstallClaude } from './cmd-install.js';
export type { InstallClaudeDeps, InstallClaudeOptions, InstallOutcome } from './cmd-install.js';
import { runHarvestInteractive } from './cmd-review.js';
import { createPrompter, isInteractive, splitList } from './prompt.js';
import type { Prompter } from './prompt.js';
import { errorMessage } from '../util/errors.js';

// ---------------------------------------------------------------------------
// IO + shared helpers
// ---------------------------------------------------------------------------

const PROJECT_FILE_NAME = '.lexicon.yaml';

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
  if (!(TERM_CATEGORIES as readonly string[]).includes(lower)) {
    throw new Error(`unknown category "${value}" (expected one of: ${TERM_CATEGORIES.join(', ')})`);
  }
  return lower as TermCategory;
}

/** Like parseCategory but returns undefined instead of throwing (interactive re-ask loops). */
function parseCategoryLoose(value: string): TermCategory | undefined {
  const lower = value.trim().toLowerCase();
  return (TERM_CATEGORIES as readonly string[]).includes(lower) ? (lower as TermCategory) : undefined;
}

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

  // The existence check, the write and the appended example are one operation.
  // Apart, two inits race to create the same file and the second overwrites the
  // first, and an add landing between the write and the append is renamed away
  // by nothing but read back without the comment. The lock is re-entrant, so
  // the writeLexiconFile inside takes it again for free.
  const created = await withLexiconLock(target, async () => {
    if (existsSync(target)) return false;
    const lexicon = emptyLexicon();
    lexicon.settings = { minConfidence: 0.82, phonetic: true, fuzzy: true, skipCode: true };
    const file: LexiconFile = { path: target, scope, lexicon, exists: false };
    await writeLexiconFile(file);
    // YAML comments survive round-trips as far as parsing goes (they are simply
    // ignored), so appending the example after the generated body is safe.
    await fs.appendFile(target, EXAMPLE_TERM_COMMENT, 'utf8');
    return true;
  });

  if (!created) {
    line(io, `${scope} lexicon already exists: ${safe(target)}`);
    return 0;
  }
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
  /** Print `{ term, path, created, scope, suggested }` as JSON instead of the summary lines. */
  json?: boolean;
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
  if (opts.interactive && opts.json) throw new Error('add: --interactive and --json cannot be combined');
  const ownPrompter = opts.interactive && !prompter;
  const p: Prompter | undefined = opts.interactive
    ? (prompter ?? createPrompter({ input: process.stdin, output: process.stdout }))
    : undefined;

  const aliases = aliasArgs.map((a) => a.trim()).filter(Boolean);
  let suggested: string[] = [];
  // No aliases and no --suggest: the suggestions apply only if this creates the
  // term (addTerm's defaultAliases), so `add X --never w` on an existing X adds none.
  const fallbackOnly = !opts.suggest && aliases.length === 0 && !p;
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
    } else if (!fallbackOnly) {
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
        const answer = (await p.ask(`category (${TERM_CATEGORIES.join('|')})`, { default: category ?? 'other' })).trim();
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

  const result = await addTerm(term, {
    scope,
    cwd,
    ...(opts.globalPath ? { globalPath: opts.globalPath } : {}),
    ...(fallbackOnly && suggested.length > 0 ? { defaultAliases: suggested } : {}),
  });
  // An alias another term already holds may keep being corrected to that
  // term; say so, as MCP add_term does, instead of plain success. Best
  // effort: a lexicon that will not load just loses the report.
  const conflicts = await loadLexicon({ cwd, ...(opts.globalPath ? { globalPath: opts.globalPath } : {}) }).then(
    (loaded) => spellingConflicts(loaded.merged, result.term.aliases, result.term.canonical),
    () => [],
  );
  if (opts.json) {
    line(
      io,
      JSON.stringify(
        { term: result.term, path: result.file.path, created: result.created, scope, suggested, ...(conflicts.length > 0 ? { conflicts } : {}) },
        null,
        2,
      ),
    );
    return 0;
  }
  line(io, `${result.created ? green('created') : green('merged')} ${bold(safe(result.term.canonical))} (${scope}) in ${safe(result.file.path)}`);
  if (suggested.length > 0 && !p && (!fallbackOnly || result.created)) line(io, `suggested aliases: ${safe(suggested.join(', '))}`);
  line(io, `aliases: ${result.term.aliases.length > 0 ? safe(result.term.aliases.join(', ')) : dim('(none)')}`);
  for (const c of conflicts) line(io, conflictLine(c));
  if (scope === 'project') line(io, dim(`project lexicon trusted at its new content (${safe(result.file.path)})`));
  return 0;
}

export interface RemoveOptions extends CommonOptions {
  project?: boolean;
  /** Only the global lexicon (the mirror of `project`). */
  global?: boolean;
  /** Print `{ canonical, removed }` as JSON (exit 1 still means not found). */
  json?: boolean;
  /** Remove only this alias from the term, keeping the term. */
  alias?: string;
}

export async function runRemove(canonical: string, opts: RemoveOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  if (opts.project && opts.global) {
    io.stderr('lexicon: --project and --global cannot be combined (omit both to try the project lexicon, then the global one)\n');
    return 1;
  }
  const scope: TermScope | undefined = opts.project ? 'project' : opts.global ? 'global' : undefined;
  if (opts.alias !== undefined) return runRemoveAlias(canonical, opts.alias, opts, scope, cwd, io);
  // Which files hold the term before the edit: removeTerm edits only the
  // first (project, then global), and a copy left in the other file keeps
  // correcting. A skipped (untrusted) project file is never edited, but a copy
  // there wins the merge once the user trusts it, so it is named too (path
  // only). Best effort: a file that will not load just loses the report.
  const loaded = await loadLexicon({ cwd }).catch(() => undefined);
  const holders = loaded ? termHolders(loaded, canonical) : [];
  const untrusted = loaded ? untrustedTermHolder(loaded, canonical) : undefined;
  let removed: boolean;
  try {
    removed = await removeTerm(canonical, scope ? { scope, cwd } : { cwd });
  } catch (err) {
    if (!isProjectTrustError(err)) throw err;
    // Without a scope the untrusted project copy comes first and is refused;
    // the global copy is still removable on its own.
    const global = holders.find((h) => h.scope === 'global');
    if (opts.json) {
      line(io, JSON.stringify({ canonical, removed: false, error: errorMessage(err), ...(untrusted ? { untrustedProject: untrusted } : {}) }, null, 2));
    }
    io.stderr(`lexicon: ${safeLines(errorMessage(err))}\n`);
    if (global) io.stderr(`lexicon: to remove only the global copy (${safe(global.path)}): lexicon remove ${JSON.stringify(safe(canonical))} --global\n`);
    return 1;
  }
  const from = removed ? (scope ? holders.find((h) => h.scope === scope) : holders[0]) : undefined;
  const stillIn = removed ? holders.filter((h) => h !== from) : [];
  const notFound = (): string => {
    const other = scope ? holders.find((h) => h.scope !== scope) : undefined;
    const otherFlag = other?.scope === 'project' ? '--project' : '--global';
    return (
      `lexicon: term "${safe(canonical)}" not found${scope ? ` in ${scope} lexicon` : ''}\n` +
      (other ? `lexicon: it is in the ${other.scope} lexicon (${safe(other.path)}); run with ${otherFlag} to remove it\n` : '') +
      (untrusted
        ? `lexicon: it is in the ${untrusted.trust === 'changed' ? 'changed' : 'untrusted'} project lexicon (${safe(untrusted.path)}), which is not loaded or edited; review it and run lexicon trust before removing it there\n`
        : '')
    );
  };
  const extra = { ...(stillIn.length > 0 ? { stillIn } : {}), ...(untrusted ? { untrustedProject: untrusted } : {}) };
  if (opts.json) {
    line(io, JSON.stringify({ canonical, removed, ...extra }, null, 2));
    if (!removed) io.stderr(notFound());
    return removed ? 0 : 1;
  }
  if (!removed) {
    io.stderr(notFound());
    return 1;
  }
  line(io, `removed ${bold(safe(canonical))}${from ? ` from ${safe(from.path)}` : ''}`);
  for (const h of stillIn) line(io, stillInLine(canonical, h));
  if (untrusted) line(io, untrustedLine(canonical, untrusted));
  return 0;
}

/**
 * `remove <canonical> --alias <alias>`: drop one alias and keep the term. An
 * unknown term or alias exits 1 (with `{ removed: false, error }` under
 * --json); a refused untrusted project file throws as every other write does.
 */
async function runRemoveAlias(
  canonical: string,
  alias: string,
  opts: RemoveOptions,
  scope: TermScope | undefined,
  cwd: string,
  io: IO,
): Promise<number> {
  let result: RemoveAliasResult;
  try {
    result = await removeAlias(canonical, alias, scope ? { scope, cwd } : { cwd });
  } catch (err) {
    if (isProjectTrustError(err)) throw err;
    const message = errorMessage(err);
    if (opts.json) line(io, JSON.stringify({ canonical, alias, removed: false, error: message }, null, 2));
    io.stderr(`lexicon: ${safeLines(message)}\n`);
    return 1;
  }
  const paths = result.files.map((f) => f.path);
  if (opts.json) {
    line(io, JSON.stringify({ canonical: result.term.canonical, alias, removed: true, aliases: result.term.aliases, paths }, null, 2));
    return 0;
  }
  line(io, `removed alias ${bold(safe(alias))} from ${bold(safe(result.term.canonical))} in ${safe(paths.join(', '))}`);
  line(io, `aliases: ${result.term.aliases.length > 0 ? safe(result.term.aliases.join(', ')) : dim('(none)')}`);
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
    line(io, dim('no terms' + (opts.query || category ? ' match' : ' yet. Try: lexicon add "Ashlr.AI" Ashler')));
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
    // `npx @ashlr/lexicon normalize "ping ashler"` with nothing set up is the
    // cheapest demo of the product, and with an empty lexicon it would print
    // the input back unchanged -- a demo of nothing. Stand in the example
    // terms and say so on stderr, so stdout still round-trips exactly.
    //
    // Arguments only, never stdin: a human typing a sentence is trying the
    // tool, whereas `cat notes.md | lexicon normalize` is a pipeline whose
    // bytes must not be rewritten by terms the user never chose.
    const useExample = fromArgs && isEmptyLexicon(loaded.merged);
    if (useExample) {
      io.stderr(
        'lexicon: no terms yet, so this is the built-in example (Ashlr.AI, Kubernetes, PostgreSQL, Pydantic, SaaS).\n' +
          'lexicon: run `lexicon setup` to build your own; nothing was written.\n',
      );
    }
    const result = normalize(text, useExample ? DEMO_LEXICON : loaded.merged, normalizeOpts);
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
    // Two contracts pull in opposite directions here, so each gets its own
    // channel. stdout still round-trips the text byte-exactly, because
    // `... | lexicon normalize | ...` must never drop or mangle a pipeline's
    // bytes just because the lexicon is broken. The exit code becomes 1,
    // because "no corrections applied" and "nothing needed correcting" are
    // different answers and exit 0 made them indistinguishable: a script, a
    // watcher or a person saw silence and concluded it was working.
    io.stderr(`lexicon: ${safeLines(errorMessage(err))}\n`);
    io.stderr('lexicon: no corrections were applied and the text is unchanged (run: lexicon doctor)\n');
    if (opts.json) {
      line(io, JSON.stringify({ input: text, output: text, replacements: [], changed: false }, null, 2));
    } else {
      emit(text);
    }
    return 1;
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
  /** Also propose names seen only as a PascalCase symbol in source. */
  symbols?: boolean;
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
  if (opts.symbols) harvestOpts.symbols = true;

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

export async function runExport(requested: string | undefined, opts: ExportCliOptions, io: IO): Promise<number> {
  if (requested === undefined) {
    line(io, 'usage: lexicon export <format> [--out <file>] [--category <c...>] [--limit <n>]');
    io.stdout(formatList());
    return 0;
  }
  const format = resolveExportFormat(requested);
  if (format === undefined) {
    io.stderr(`lexicon: unknown export format "${safe(requested)}"\n`);
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
  const loaded = await loadLexicon({ cwd });
  // stderr only: stdout (or --out) is the export, and it leaves the skipped file out.
  warnSkippedProject(loaded, io);
  const { merged } = loaded;
  const text = exportLexicon(merged, format, exportOpts);

  if (opts.out) {
    const outPath = path.resolve(cwd, opts.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, ensureNewline(text), 'utf8');
    // The terms actually written: the same category filter and cap exportLexicon applies.
    const allowed = exportOpts.categories && exportOpts.categories.length > 0 ? new Set(exportOpts.categories) : undefined;
    const matching = allowed
      ? merged.terms.filter((t) => t.category !== undefined && allowed.has(t.category)).length
      : merged.terms.length;
    const written = exportOpts.limit !== undefined ? Math.min(matching, exportOpts.limit) : matching;
    line(io, `wrote ${format} export (${plural(written, 'term')}) to ${safe(outPath)}`);
  } else {
    io.stdout(ensureNewline(text));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// path
// ---------------------------------------------------------------------------

export async function runPath(opts: CommonOptions & { json?: boolean }, io: IO): Promise<number> {
  const paths = resolvePaths({ cwd: resolveCwd(opts) });
  if (opts.json) {
    // `project` is the file the walk found, trusted or not; null when there is none.
    line(io, JSON.stringify({ global: paths.global, project: paths.project ?? null }, null, 2));
    return 0;
  }
  line(io, `global: ${safe(paths.global)}`);
  line(io, `project: ${paths.project ? safe(paths.project) : '(none)'}`);
  return 0;
}
