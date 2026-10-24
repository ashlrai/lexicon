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
 *    Under `--json` a failure also prints `{ ok: false, error, nextStep? }` on
 *    stdout: `fail(io, err, opts.json)`, `refuse(io, opts.json, message)` for
 *    one that is not an exception, and index.ts does it for a thrown error.
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
  commandLine,
  EXPORT_ALIAS_ROW_FORMATS,
  EXPORT_FORMATS,
  TERM_CATEGORIES,
  EXPORT_FORMAT_INFO,
  addTerm,
  addTerms,
  conflictNote,
  unchangedTermNote,
  diffSummary,
  emptyExportNote,
  emptyExportReason,
  emptyLexicon,
  emptyLexiconNote,
  isEmptyLexicon,
  exportLexiconWithNotes,
  selectExportTerms,
  resolveExportFormat,
  harvestReport,
  harvestTruncatedNote,
  loadLexicon,
  normalize,
  isProjectTrustError,
  isTrusted,
  ProjectTrustError,
  removeAlias,
  removeTerm,
  termHolders,
  untrustedAliasHolder,
  untrustedTermHolder,
  noTermMatchesNote,
  noTermsYet,
  onlyUntrustedTerms,
  resolvePaths,
  spellingConflicts,
  suggestAliases,
  trustProject,
  withLexiconLock,
  writeLexiconFile,
} from '../core/index.js';
import { EXPORT_MAX_LIMIT, HARVEST_MAX_LIMIT } from '../core/index.js';
import type {
  ExportFormat,
  ExportOptions,
  HarvestCandidate,
  HarvestOptions,
  LexiconFile,
  LoadedLexicon,
  NormalizeOptions,
  RemoveAliasResult,
  Term,
  TermCategory,
  TermScope,
} from '../core/index.js';
import {
  bold,
  CliRefusal,
  conflictLine,
  dim,
  ensureNewline,
  green,
  jsonError,
  jsonOk,
  line,
  parseCategory,
  plural,
  PROJECT_TRUST_NEXT_STEP,
  refuse,
  renderTable,
  resolveCwd,
  safe,
  safeLines,
  safeMessage,
  shownCommand,
  skippedProjectJson,
  wholeNumber,
  stillInLine,
  unreadableLexiconHint,
  untrustedAliasLine,
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
export type { DoctorAudience, DoctorCheck, DoctorCliOptions, DoctorDeps, DoctorLevel, DoctorReport, DoctorReportOptions } from './cmd-doctor.js';
export { CLAUDE_MD_SNIPPET, runInstallClaude } from './cmd-install.js';
export type { InstallClaudeDeps, InstallClaudeOptions, InstallOutcome } from './cmd-install.js';
import { noHarvestCandidatesLine, runHarvestInteractive } from './cmd-review.js';
import { PromptClosedError, createPrompter, isInteractive, splitList } from './prompt.js';
import type { Prompter } from './prompt.js';
import { errorMessage, isInputError } from '../util/errors.js';
import { writeFileAtomic } from '../util/atomic.js';

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

/**
 * An integer option handed to a handler directly (commander already parsed
 * `--limit` with positiveIntOption). A string takes the same digits-only rule
 * (wholeNumber): parseInt read `5abc` as 5. Zero is refused as
 * positiveIntOption refuses it: a direct `limit: 0` csv export wrote nothing
 * and then said the lexicon had no rows.
 */
function parseIntOption(value: string | number | undefined, flag: string, max?: number): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : wholeNumber(value);
  if (n === undefined || !Number.isSafeInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  if (max !== undefined && n > max) throw new Error(`${flag} must be at most ${max}`);
  return n;
}

/** Like parseCategory but returns undefined instead of throwing (interactive re-ask loops). */
function parseCategoryLoose(value: string): TermCategory | undefined {
  const lower = value.trim().toLowerCase();
  return (TERM_CATEGORIES as readonly string[]).includes(lower) ? (lower as TermCategory) : undefined;
}

/**
 * Read all of stdin as UTF-8. Unbounded on purpose: `lexicon normalize` is a
 * filter whose stdout round-trips the whole input, so there is no size it
 * could refuse without breaking `cat notes.md | lexicon normalize`.
 */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write('lexicon: reading text from stdin (press ctrl-D to finish)\n');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
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
  /** Print `{ ok: true, scope, path, created, trust? }` (or `{ ok: false, error, nextStep? }`). */
  json?: boolean;
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
  // A failure throws to the CLI entry, which prints `{ ok: false, error, nextStep }` under --json.
  const created = await createLexiconFile(target, scope);
  // The user asked for this file; that is the approval `lexicon trust` records.
  if (created && scope === 'project') await trustProject(target, { cwd });
  // `trust` for a project file only: an existing one may be untrusted, which
  // is what decides whether its terms are merged.
  const trust = scope === 'project' ? await isTrusted({ path: target, scope, lexicon: emptyLexicon(), exists: true }, { cwd }) : undefined;
  // An existing project file init did not create may be one the user never
  // reviewed (a cloned repo's) or edited since: its terms are not used until
  // it is trusted, which "already exists" alone did not say.
  const untrustedStep =
    trust !== undefined && trust !== 'trusted'
      ? `${trust === 'changed' ? 'it has changed since it was trusted' : 'it is not trusted yet'}, so its terms are not used; review it and run: lexicon trust`
      : undefined;
  if (opts.json) {
    line(
      io,
      JSON.stringify(jsonOk({ scope, path: target, created, ...(trust !== undefined ? { trust } : {}), ...(untrustedStep ? { nextStep: untrustedStep } : {}) }), null, 2),
    );
    return 0;
  }
  if (!created) {
    line(io, `${scope} lexicon already exists: ${safe(target)}`);
    if (untrustedStep) line(io, dim(untrustedStep));
    return 0;
  }
  line(io, `created ${scope} lexicon: ${safe(target)}`);
  if (scope === 'project') {
    line(io, dim(`trusted ${safe(target)} (it is re-pinned by lexicon add/harvest; after hand edits run: lexicon trust)`));
    line(io, dim('next: add a term with lexicon add "Ashlr.AI" Ashler --project'));
  } else {
    line(io, dim('next: add a term with lexicon add "Ashlr.AI" Ashler, or run lexicon setup for the guided first run'));
  }
  return 0;
}

/** Creates `target` with the default settings and the example comment; false when it already exists. */
async function createLexiconFile(target: string, scope: TermScope): Promise<boolean> {
  return withLexiconLock(target, async () => {
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

/**
 * ctrl-D during `add -i` is a cancel: nothing has been written yet, so say so
 * and exit 0, as `review` and `harvest -i` stop. Any other error is rethrown.
 */
function addInputClosed(err: unknown, canonical: string, io: IO): number {
  if (!(err instanceof PromptClosedError)) throw err;
  line(io);
  line(io, `input closed before ${safe(canonical)} was saved; nothing was added`);
  return 0;
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

  // A blank one is kept as given: addTerm refuses it, as MCP add_term and POST /add do.
  const aliases = aliasArgs.map((a) => (a.trim() ? a.trim() : a));
  let suggested: string[] = [];
  // No aliases and no --suggest: the suggestions apply only if this creates the
  // term (addTerm's defaultAliases), so `add X --never w` on an existing X adds none.
  const fallbackOnly = !opts.suggest && aliases.length === 0 && !p;
  if (opts.suggest || aliases.length === 0) {
    // A never word is excluded as given (`--suggest --never sass` on SaaS): the
    // store refuses an alias that is also a never word, since it never applies.
    const have = new Set([...aliases, ...(opts.never ?? []).map((w) => w.trim())].map((a) => a.toLowerCase()));
    suggested = suggestAliases(trimmed).filter((s) => {
      const key = s.toLowerCase();
      if (key === trimmed.toLowerCase() || have.has(key)) return false;
      have.add(key);
      return true;
    });
    if (p && aliasArgs.length === 0) {
      // Interactive: the suggestions are a checklist, not a fait accompli.
      try {
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
      } catch (err) {
        if (ownPrompter) p.close();
        return addInputClosed(err, trimmed, io);
      }
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
    } catch (err) {
      return addInputClosed(err, trimmed, io);
    } finally {
      if (ownPrompter) p.close();
    }
  }
  if (category) term.category = category;
  if (opts.notes) term.notes = opts.notes;
  // Passed as given: addTerm trims them and refuses a blank one, as MCP add_term and POST /add do.
  if (opts.never && opts.never.length > 0) term.never = [...opts.never];

  const result = await addTerm(term, {
    scope,
    cwd,
    ...(opts.globalPath ? { globalPath: opts.globalPath } : {}),
    ...(fallbackOnly && suggested.length > 0 ? { defaultAliases: suggested } : {}),
  });
  // An alias another term already holds may keep being corrected to that
  // term; say so, as MCP add_term does, instead of plain success. Best
  // effort: a lexicon that will not load just loses the report.
  // The check reads the merged terms only, so a skipped (untrusted) project
  // file is never parsed for it (parseSkipped: false).
  const conflicts = await loadLexicon({ cwd, ...(opts.globalPath ? { globalPath: opts.globalPath } : {}), parseSkipped: false }).then(
    (loaded) => spellingConflicts(loaded.merged, result.term.aliases, result.term.canonical),
    () => [],
  );
  if (opts.json) {
    line(
      io,
      JSON.stringify(
        jsonOk({
          term: result.term,
          path: result.file.path,
          created: result.created,
          ...(result.unchanged ? { unchanged: true } : {}),
          scope,
          // The suggestions this call applied: the fallback ones only when it
          // created the term, as the text output marks them. They used to be
          // listed for an existing term too, where none was added.
          suggested: !fallbackOnly || result.created ? suggested : [],
          ...(conflicts.length > 0 ? { conflicts, note: conflictNote(conflicts) } : result.unchanged ? { note: unchangedTermNote(result.term.canonical) } : {}),
        }),
        null,
        2,
      ),
    );
    return 0;
  }
  if (result.unchanged) {
    // The term already had every alias and field given: "merged" read as a change.
    line(io, `${unchangedTermNote(safe(result.term.canonical))} (${scope}: ${safe(result.file.path)})`);
  } else {
    line(io, `${result.created ? green('created') : green('merged')} ${bold(safe(result.term.canonical))} (${scope}) in ${safe(result.file.path)}`);
  }
  // One aliases line: the suggestions are marked in it rather than listed
  // again on a line of their own (`suggested aliases: Fo` then `aliases: Fo`).
  const saved = result.term.aliases;
  const marked =
    suggested.length > 0 && !p && (!fallbackOnly || result.created)
      ? suggested.filter((s) => saved.some((a) => a.toLowerCase() === s.toLowerCase()))
      : [];
  const suggestedNote =
    marked.length === 0 ? '' : marked.length === saved.length ? ' (suggested)' : ` (suggested: ${safe(marked.join(', '))})`;
  line(io, `aliases: ${saved.length > 0 ? safe(saved.join(', ')) + dim(suggestedNote) : dim('(none)')}`);
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
    return refuse(io, opts.json, '--project and --global cannot be combined', 'pass one of --project or --global, or omit both to try the project lexicon, then the global one');
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
      const nextStep = global ? `run ${commandLine(['lexicon', 'remove', canonical, '--global'])} to remove only the global copy, or ${PROJECT_TRUST_NEXT_STEP}` : PROJECT_TRUST_NEXT_STEP;
      line(io, JSON.stringify({ ...jsonError(errorMessage(err), nextStep), canonical, removed: false, ...(untrusted ? { untrustedProject: untrusted } : {}) }, null, 2));
    }
    io.stderr(`lexicon: ${safeMessage(errorMessage(err))}\n`);
    if (global) io.stderr(`lexicon: to remove only the global copy (${safe(global.path)}): ${shownCommand(['lexicon', 'remove', canonical, '--global'])}\n`);
    return 1;
  }
  const from = removed ? (scope ? holders.find((h) => h.scope === scope) : holders[0]) : undefined;
  const stillIn = removed ? holders.filter((h) => h !== from) : [];
  const other = scope ? holders.find((h) => h.scope !== scope) : undefined;
  // What to do about a miss, also the `nextStep` under --json: the flag for
  // the file that does hold it, else how to find the exact spelling.
  const missStep = other
    ? `it is in the ${other.scope} lexicon (${other.path}); run with --${other.scope} to remove it`
    : untrusted
      ? undefined
      : (emptyLexiconRemoveStep(loaded) ?? 'run lexicon list to see the exact canonical spellings');
  const notFound = (): string =>
    `lexicon: term "${safe(canonical)}" not found${scope ? ` in ${scope} lexicon` : ''}\n` +
    (missStep ? `lexicon: ${safeMessage(missStep)}\n` : '') +
    (untrusted
      ? `lexicon: it is in the ${untrusted.trust === 'changed' ? 'changed' : 'untrusted'} project lexicon (${safe(untrusted.path)}), which is not loaded or edited; review it and run lexicon trust before removing it there\n`
      : '');
  const extra = { ...(stillIn.length > 0 ? { stillIn } : {}), ...(untrusted ? { untrustedProject: untrusted } : {}) };
  if (opts.json) {
    // A miss is a failure document like every other --json refusal: `ok: false` and `error` lead it;
    // a removal leads with `ok: true`.
    const failure = removed ? {} : jsonError(`term "${canonical}" not found${scope ? ` in ${scope} lexicon` : ''}`, missStep);
    line(io, JSON.stringify(removed ? jsonOk({ canonical, removed, ...extra }) : { ...failure, canonical, removed, ...extra }, null, 2));
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
 * --json). When the skipped (untrusted) project file's copy of the term holds
 * the alias too, that copy is named (path only, `untrustedAliasHolder`) and
 * never edited: a `warn:` line, and `untrustedProject` under --json. A
 * refused untrusted project file (it comes first without a scope) prints the
 * trust error, a `--global` hint when the global copy holds the alias, and
 * exits 1, as `remove` does for a term.
 */
/**
 * The next step for a `remove` (with or without `--alias`) that missed on a
 * lexicon with no terms, or undefined when it has some (or did not load).
 * `lexicon list` shows nothing there, so pointing to it was a dead end: say
 * there is nothing to remove and how to get terms, or `lexicon trust` when
 * the only terms are in an untrusted project file that was not loaded.
 */
function emptyLexiconRemoveStep(loaded: LoadedLexicon | undefined): string | undefined {
  if (loaded === undefined || loaded.merged.terms.length > 0) return undefined;
  return loaded.skippedProject
    ? `${onlyUntrustedTerms('is not loaded')}; review it and run lexicon trust`
    : `${noTermsYet({ lower: true, so: 'there is nothing to remove' })}; run lexicon setup, or add one with: lexicon add <canonical> <alias>`;
}

async function runRemoveAlias(
  canonical: string,
  alias: string,
  opts: RemoveOptions,
  scope: TermScope | undefined,
  cwd: string,
  io: IO,
): Promise<number> {
  // Best effort: a lexicon that will not load just loses the report.
  const loaded = await loadLexicon({ cwd }).catch(() => undefined);
  const untrusted = loaded ? untrustedAliasHolder(loaded, canonical, alias) : undefined;
  const extra = untrusted ? { untrustedProject: untrusted } : {};
  let result: RemoveAliasResult;
  try {
    result = await removeAlias(canonical, alias, scope ? { scope, cwd } : { cwd });
  } catch (err) {
    const message = errorMessage(err);
    const holdsAlias = (file: LexiconFile | undefined): boolean =>
      file?.lexicon.terms.some(
        (t) => t.canonical.trim().toLowerCase() === canonical.trim().toLowerCase() && t.aliases.some((a) => a.trim().toLowerCase() === alias.trim().toLowerCase()),
      ) === true;
    // --project or --global named a file whose copy lacks the term or the
    // alias while the other (loaded) file's copy has it: name that file and
    // the flag, as `remove` without --alias does.
    const other = scope === 'project' ? loaded?.global : scope === 'global' ? loaded?.project : undefined;
    const elsewhere =
      isInputError(err) && other && holdsAlias(other)
        ? `it is an alias of "${canonical}" in the ${other.scope} lexicon (${other.path}); run with --${other.scope} to remove it there, or with neither flag to remove it from every file whose copy has it`
        : isInputError(err) && !untrusted
          ? emptyLexiconRemoveStep(loaded)
          : undefined;
    if (opts.json) line(io, JSON.stringify({ ...jsonError(message, elsewhere), canonical, alias, removed: false, ...extra }, null, 2));
    io.stderr(`lexicon: ${safeMessage(message)}\n`);
    if (elsewhere) io.stderr(`lexicon: ${safeMessage(elsewhere)}\n`);
    if (isProjectTrustError(err)) {
      if (holdsAlias(loaded?.global)) {
        io.stderr(`lexicon: to remove it only from the global copy (${safe(loaded!.global.path)}): ${shownCommand(['lexicon', 'remove', canonical, '--alias', alias, '--global'])}\n`);
      }
    } else if (untrusted) {
      io.stderr(`lexicon: ${untrustedAliasLine(canonical, alias, untrusted).replace(/^warn: /, '')}\n`);
    }
    return 1;
  }
  const paths = result.files.map((f) => f.path);
  if (opts.json) {
    line(io, JSON.stringify(jsonOk({ canonical: result.term.canonical, alias, removed: true, aliases: result.term.aliases, paths, ...extra }), null, 2));
    return 0;
  }
  line(io, `removed alias ${bold(safe(alias))} from ${bold(safe(result.term.canonical))} in ${safe(paths.join(', '))}`);
  line(io, `aliases: ${result.term.aliases.length > 0 ? safe(result.term.aliases.join(', ')) : dim('(none)')}`);
  if (untrusted) line(io, untrustedAliasLine(result.term.canonical, alias, untrusted));
  return 0;
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListOptions extends CommonOptions {
  json?: boolean;
  /**
   * Print the object MCP `list_terms` returns (`{ terms, counts, paths,
   * projectTrust?, skippedProject?, note? }`) instead of the bare array
   * `--json` prints. Implies `json`.
   */
  full?: boolean;
  category?: string;
  query?: string;
}

export async function runList(opts: ListOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  // A skipped project file is named by path only, so it is never parsed.
  const loaded = await loadLexicon({ cwd, parseSkipped: false });
  warnSkippedProject(loaded, io);
  let terms = loaded.merged.terms;
  const category = parseCategory(opts.category);
  if (category) terms = terms.filter((t) => t.category === category);
  // Trimmed, as MCP list_terms trims it: a pasted " Ashler" matched nothing
  // here while the agent's list_terms found the term, and a query of only
  // spaces filters nothing in either.
  const query = opts.query?.trim();
  if (query) {
    const q = query.toLowerCase();
    terms = terms.filter(
      (t) => t.canonical.toLowerCase().includes(q) || t.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }

  const filters = [
    ...(opts.category !== undefined ? [`--category ${opts.category}`] : []),
    ...(query ? [`--query ${JSON.stringify(query)}`] : []),
  ];
  const total = loaded.merged.terms.length;
  // Why the list is empty, as MCP list_terms says it in `note`: "no terms
  // match" for a lexicon that had none at all sent a first user to fix the
  // filter, and a filter that missed named no way to see what is there.
  const emptyNote =
    terms.length > 0 || loaded.skippedProject
      ? undefined
      : total === 0
        ? emptyLexiconNote()
        : noTermMatchesNote({ filter: filters.join(' '), filters: filters.length, total });

  if (opts.full) {
    // The MCP list_terms shape; plain --json keeps the bare array scripts already parse.
    const skipped = skippedProjectJson(loaded);
    const payload = {
      terms,
      counts: {
        matched: terms.length,
        total: loaded.merged.terms.length,
        global: loaded.global.lexicon.terms.length,
        project: loaded.project?.lexicon.terms.length ?? 0,
      },
      paths: { global: loaded.global.path, ...(loaded.project ? { project: loaded.project.path } : {}) },
      ...skipped,
      ...(emptyNote ? { note: emptyNote } : {}),
    };
    line(io, JSON.stringify(jsonOk(payload), null, 2));
    return 0;
  }
  if (opts.json) {
    line(io, JSON.stringify(terms, null, 2));
    return 0;
  }

  if (terms.length === 0) {
    // With every term in a project file that was skipped, adding a global
    // term is not what is missing: trusting the file is.
    const empty = loaded.skippedProject
      ? ' applied: the project lexicon is not trusted, so its terms are not loaded. Review it and run: lexicon trust'
      : ' yet. Try: lexicon add "Ashlr.AI" Ashler';
    line(
      io,
      dim(
        total > 0 && filters.length > 0
          ? noTermMatchesNote({ filter: safe(filters.join(' ')), filters: filters.length, total })
          : 'no terms' + empty,
      ),
    );
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
  // A bad flag value is a usage error, refused before stdin is read: under
  // --json it is `{ ok: false, error, nextStep }` like every other refusal,
  // where the thrown error left a document with no next step.
  let normalizeOpts: NormalizeOptions;
  try {
    normalizeOpts = buildNormalizeOptions(opts);
  } catch (err) {
    return refuse(io, opts.json, errorMessage(err), 'pass a value from 0 to 1, e.g. --min-confidence 0.8 (see: lexicon normalize --help)');
  }
  const fromArgs = args.length > 0;
  const text = fromArgs ? args.join(' ') : await readInput();
  const emit = (s: string): void => {
    io.stdout(fromArgs ? `${s}\n` : s);
  };

  if (text.length === 0) {
    // Still exit 0 with stdout round-tripping the (empty) input, but say why
    // nothing happened: `lexicon normalize < empty.txt` (or a forgotten pipe)
    // exited 0 without a word. stderr only, so the protocol is unchanged.
    io.stderr(
      `lexicon: no text to correct (${fromArgs ? 'the argument was empty' : 'stdin was empty'}); ` +
        'pass it as arguments: lexicon normalize "ping ashler", or pipe it in: echo "ping ashler" | lexicon normalize\n',
    );
    // Pretty-printed like every other normalize --json document.
    if (opts.json) line(io, JSON.stringify(jsonOk({ input: '', output: '', replacements: [], changed: false }), null, 2));
    return 0;
  }

  try {
    // A skipped project file is named by path only, so it is never parsed;
    // --include-untrusted merges it, and parseSkipped is ignored then.
    const loaded = await loadLexicon({ cwd: resolveCwd(opts), includeUntrusted: opts.includeUntrusted === true, parseSkipped: false });
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
      // A skipped project file holds terms; they are just not trusted yet, so
      // the way to them is `lexicon trust`, not building a lexicon from scratch.
      io.stderr(
        loaded.skippedProject
          ? 'lexicon: no trusted terms yet, so this is the built-in example (Ashlr.AI, Kubernetes, PostgreSQL, Pydantic, SaaS).\n' +
              'lexicon: the project lexicon is not trusted, so its terms were not used; review it and run `lexicon trust` to use them. Nothing was written.\n'
          : 'lexicon: no terms yet, so this is the built-in example (Ashlr.AI, Kubernetes, PostgreSQL, Pydantic, SaaS).\n' +
              'lexicon: run `lexicon setup` to build your own; nothing was written.\n',
      );
    }
    const result = normalize(text, useExample ? DEMO_LEXICON : loaded.merged, normalizeOpts);
    // The summary goes to stderr whatever stdout carries, so `--json --diff`
    // keeps both. `--dry-run` alone shows it too: it promises to report the
    // replacements, and stdout (the unchanged input) reports nothing. Before,
    // `--json` dropped `--diff` and a plain `--dry-run` printed no report at all.
    if (opts.diff || (opts.dryRun && !opts.json)) {
      const summary = diffSummary(result);
      // stdout must round-trip the user's text byte-exactly; the stderr diff quotes lexicon content, so it is sanitized per line.
      if (summary) io.stderr(ensureNewline(safeLines(summary)));
    }
    if (opts.json) {
      // Additive keys, as MCP normalize_transcript carries the skipped-project
      // ones: otherwise a script reading only stdout cannot tell corrections
      // from the built-in example, or an unchanged result from a skipped file.
      // `ok: true` first, as on every other --json success; the rest is the NormalizeResult.
      line(io, JSON.stringify(jsonOk({ ...result, ...(useExample ? { example: true } : {}), ...skippedProjectJson(loaded) }), null, 2));
      return 0;
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
    const message = errorMessage(err);
    io.stderr(`lexicon: ${safeLines(message)}\n`);
    io.stderr('lexicon: no corrections were applied and the text is unchanged (run: lexicon doctor)\n');
    if (opts.json) {
      // `{ ok: false, error, nextStep }` and then the unchanged NormalizeResult,
      // so a script reading `output` still gets the input back.
      const nextStep = unreadableLexiconHint(message) ?? 'no corrections were applied and the text is unchanged; run: lexicon doctor';
      line(io, JSON.stringify({ ...jsonError(message, nextStep), input: text, output: text, replacements: [], changed: false }, null, 2));
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
  /**
   * Print one object instead of the bare candidate array `--json` prints: the
   * keys MCP `harvest_repo` returns (`root`, `candidates`, `count`, and with
   * `--add` the number `added`) plus `created`, `merged` and `path` for an add.
   * Implies `json`. Printed after the add, so it reports what was written.
   */
  full?: boolean;
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
  // --full is --json with one object on stdout instead of the bare array.
  const json = opts.json === true || opts.full === true;
  if (!existsSync(target)) {
    return refuse(io, json, `harvest: path does not exist: ${target}`, 'pass a directory that exists, or leave the path out to harvest the current directory');
  }

  const tty = (deps.isInteractive ?? isInteractive)();
  if (opts.interactive && !tty) {
    throw new Error(
      'harvest --interactive needs a terminal (stdin and stdout must be a TTY); use --add --yes to add every candidate without prompts',
    );
  }
  if (opts.interactive && json) throw new Error('harvest: --interactive and --json cannot be combined');
  const interactive = opts.interactive === true || (opts.add === true && !opts.yes && !json && tty);

  // `--add` writes to the project file, which refuses an untrusted one. Check
  // up front, as the interactive walk does: the table (or the --json array)
  // used to print first, so the output read as a success right before exit 1.
  const store = { cwd: target, ...(opts.globalPath ? { globalPath: opts.globalPath } : {}) };
  if (opts.add && !interactive) {
    const projectPath = resolvePaths(store).project;
    if (projectPath && existsSync(projectPath)) {
      const status = await isTrusted({ path: projectPath, scope: 'project', lexicon: emptyLexicon(), exists: true }, store);
      if (status !== 'trusted') {
        const message = new ProjectTrustError(projectPath, status).message;
        if (json) line(io, JSON.stringify({ ...jsonError(message, `review ${projectPath} and run lexicon trust, then run lexicon harvest --add again`), added: false, path: projectPath, projectTrust: status }, null, 2));
        io.stderr(`lexicon: ${safeLines(message)}\n`);
        return 1;
      }
    }
  }

  const harvestOpts: HarvestOptions = {};
  const limit = parseIntOption(opts.limit, '--limit', HARVEST_MAX_LIMIT);
  const minCount = parseIntOption(opts.minCount, '--min-count');
  if (limit !== undefined) harvestOpts.limit = limit;
  if (minCount !== undefined) harvestOpts.minCount = minCount;
  if (opts.symbols) harvestOpts.symbols = true;

  const report = await harvestReport(target, harvestOpts);
  const candidates: HarvestCandidate[] = report.candidates;
  // The 5000-file cap was never reported, so a large tree looked fully scanned.
  const truncatedLine = report.truncated ? `warn: ${harvestTruncatedNote(target)}` : undefined;
  const scan = { root: target, minCount: harvestOpts.minCount ?? 2, filesScanned: report.filesScanned, belowMinCount: report.belowMinCount, symbolsOnly: report.symbolsOnly };

  if (interactive) {
    // The walkthrough is the display; the table would only repeat it.
    const prompter = (deps.createPrompter ?? (() => createPrompter({ input: process.stdin, output: process.stdout })))();
    try {
      if (truncatedLine) line(io, safeMessage(truncatedLine));
      return await runHarvestInteractive(
        candidates,
        { cwd: target, ...(opts.globalPath ? { globalPath: opts.globalPath } : {}), harvest: scan },
        io,
        prompter,
      );
    } finally {
      prompter.close();
    }
  }

  if (opts.full || (opts.json && opts.add)) {
    // Printed once the add (if any) is done, below: stdout under --json is
    // one document, so a write that fails partway prints only the failure.
  } else if (opts.json) {
    line(io, JSON.stringify(candidates, null, 2));
  } else if (candidates.length === 0) {
    line(io, dim(noHarvestCandidatesLine(scan)));
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

  if (truncatedLine) {
    if (json) io.stderr(`lexicon: ${safeMessage(truncatedLine.replace(/^warn: /, ''))}\n`);
    else line(io, safeMessage(truncatedLine));
  }

  let created = 0;
  let merged = 0;
  let filePath: string | undefined;
  if (opts.add && candidates.length > 0) {
    try {
      // One read and one write for the whole list: one addTerm per candidate
      // re-parsed the growing file on every write, so 50 names took seconds.
      // The batch is all or nothing, so a failure leaves nothing half-added.
      const terms: Term[] = candidates.map((c) => ({
        canonical: c.canonical,
        aliases: c.suggestedAliases,
        category: c.category,
        source: c.source,
      }));
      const { file, results } = await addTerms(terms, { ...store, scope: 'project' });
      filePath = file.path;
      for (const r of results) {
        if (r.created) created += 1;
        else merged += 1;
      }
    } catch (err) {
      if (!json) throw err;
      // The one --json document for a write that failed: the error and the
      // counts (0: the batch writes all or none), never the candidate array.
      const message = errorMessage(err);
      const hint = unreadableLexiconHint(message);
      const where = filePath ? { path: filePath } : {};
      line(io, JSON.stringify({ ...jsonError(message, hint), added: created + merged, created, merged, ...where }, null, 2));
      io.stderr(`lexicon: ${safeLines(message)}\n`);
      if (hint) io.stderr(`lexicon: ${hint}\n`);
      io.stderr('lexicon: nothing was added: the candidates are written together, so none of them are in the project lexicon\n');
      return 1;
    }
    const where = filePath ? ` in ${safe(filePath)}` : '';
    const summary = `added ${created} new term${created === 1 ? '' : 's'}, merged ${merged}${where}`;
    if (json) io.stderr(`${summary}\n`);
    else line(io, green(summary));
    // addTerm(scope: 'project') registers the file as trusted at its new content.
    if (filePath && !json) line(io, dim(`project lexicon trusted (${safe(filePath)})`));
  }
  if (!opts.full && opts.json && opts.add) line(io, JSON.stringify(candidates, null, 2));
  if (opts.full) {
    const addResult = opts.add ? { added: created + merged, created, merged, ...(filePath ? { path: filePath } : {}) } : {};
    const truncated = report.truncated ? { truncated: true as const, note: harvestTruncatedNote(target) } : {};
    line(io, JSON.stringify(jsonOk({ root: target, candidates, count: candidates.length, ...truncated, ...addResult }), null, 2));
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
  /**
   * Print a JSON document instead of the bare export: `{ ok: true, format,
   * terms, bytes, path }` after writing `--out`, `{ ok: true, format, terms,
   * bytes, content }` (the export as a string) without it, and `{ ok: true,
   * formats }` when no format is given. A format that writes one row per
   * alias (EXPORT_ALIAS_ROW_FORMATS) adds `rows`, the rows it wrote: a term
   * without an alias is in `terms` but writes none. `dropped` (only when
   * there is something in it) holds one sentence per kind of entry the
   * format left out to fit its target (`exportLexiconWithNotes`); without
   * `--json` the same sentences go to stderr.
   */
  json?: boolean;
}

/** One row of `lexicon export --json` with no format: what `lexicon export` lists. */
export interface ExportFormatJson {
  name: ExportFormat;
  description: string;
  ext: string;
}

function formatList(): string {
  const rows = EXPORT_FORMATS.map((f) => [f, EXPORT_FORMAT_INFO[f].description, `.${EXPORT_FORMAT_INFO[f].ext}`]);
  return `available formats:\n${renderTable(rows)}`;
}

function formatListJson(): ExportFormatJson[] {
  return EXPORT_FORMATS.map((f) => ({ name: f, description: EXPORT_FORMAT_INFO[f].description, ext: EXPORT_FORMAT_INFO[f].ext }));
}

/** The nextStep of an export that named no format, or one that does not exist. */
function exportFormatNextStep(): string {
  return `run: lexicon export <format>, with one of: ${EXPORT_FORMATS.join(', ')} (lexicon export with no format describes each)`;
}

export async function runExport(requested: string | undefined, opts: ExportCliOptions, io: IO): Promise<number> {
  const json = opts.json === true;
  if (requested === undefined) {
    // `lexicon export --out lex.md` (format forgotten) printed the format list
    // and exited 0, so a script believed the file was written.
    const given = [
      ...(opts.out !== undefined ? ['--out'] : []),
      ...(opts.category !== undefined && opts.category.length > 0 ? ['--category'] : []),
      ...(opts.limit !== undefined ? ['--limit'] : []),
    ];
    if (given.length > 0) {
      const error = `${given.join(', ')} ${given.length === 1 ? 'needs' : 'need'} a format; nothing was exported`;
      if (json) return refuse(io, true, error, exportFormatNextStep());
      const code = refuse(io, false, error, 'run: lexicon export <format> (formats below)');
      io.stderr(formatList());
      return code;
    }
    if (json) {
      line(io, JSON.stringify(jsonOk({ formats: formatListJson() }), null, 2));
      return 0;
    }
    line(io, 'usage: lexicon export <format> [--out <file>] [--category <c...>] [--limit <n>] [--json]');
    io.stdout(formatList());
    return 0;
  }
  const format = resolveExportFormat(requested);
  if (format === undefined) {
    const error = `unknown export format "${requested}"`;
    if (json) return refuse(io, true, error, exportFormatNextStep());
    io.stderr(`lexicon: unknown export format "${safe(requested)}"\n`);
    io.stderr(formatList());
    return 1;
  }

  const exportOpts: ExportOptions = {};
  if (opts.category && opts.category.length > 0) {
    exportOpts.categories = opts.category.map((c) => parseCategory(c)).filter((c): c is TermCategory => !!c);
  }
  const limit = parseIntOption(opts.limit, '--limit', EXPORT_MAX_LIMIT);
  if (limit !== undefined) exportOpts.limit = limit;

  const cwd = resolveCwd(opts);
  const loaded = await loadLexicon({ cwd, parseSkipped: false });
  // stderr only: stdout (or --out) is the export, and it leaves the skipped file out.
  warnSkippedProject(loaded, io);
  const { merged } = loaded;
  const exported = exportLexiconWithNotes(merged, format, exportOpts);
  const text = ensureNewline(exported.text);
  // What the format left out to stay within its target's limits: stderr
  // only (stdout or --out is the export itself), and `dropped` under --json.
  if (!json) for (const n of exported.notes) io.stderr(`lexicon: ${format} export ${safeMessage(n)}\n`);
  const dropped = exported.notes.length > 0 ? { dropped: exported.notes } : {};
  // The terms actually exported: the same category filter and cap exportLexicon applies.
  const selected = selectExportTerms(merged, exportOpts, format);
  const terms = selected.length;
  // An alias-row format writes one row per non-blank alias (aliasPairs), so a
  // term without one writes nothing: "wrote csv export (2 terms)" counted it.
  const aliasRows = EXPORT_ALIAS_ROW_FORMATS.includes(format)
    ? // One row per distinct alias in NFC, as aliasPairs writes them.
      selected.map((t) => new Set(t.aliases.map((a) => a.trim().normalize('NFC')).filter((a) => a !== '')).size)
    : undefined;
  // The rows the exporter wrote: fewer than the aliases when it left some out (a formula cell, a shared trigger).
  const rows = aliasRows !== undefined ? (exported.rows ?? aliasRows.reduce((sum, n) => sum + n, 0)) : undefined;
  const bytes = Buffer.byteLength(text, 'utf8');
  // An empty export read as a complete one: no word on stderr or under --json,
  // where MCP export_lexicon says why in a note. stderr only, as above.
  const reason = emptyExportReason(loaded, format, exportOpts);
  const empty = reason && emptyExportNote(reason, { format, filter: `--category ${(exportOpts.categories ?? []).join(' ')}` });
  if (empty) io.stderr(`lexicon: ${safe(empty.charAt(0).toLowerCase() + empty.slice(1))}\n`);
  const skipped = skippedProjectJson(loaded, 'Its terms are not in the export.');
  const notes = { ...skipped, ...(empty || skipped.note ? { note: [empty, skipped.note].filter(Boolean).join(' ') } : {}) };

  const rowsField = rows !== undefined ? { rows } : {};

  if (opts.out) {
    const outPath = path.resolve(cwd, opts.out);
    const problem = await exportTargetProblem(outPath, loaded);
    if (problem) return refuse(io, json, problem, 'name another file with --out, or leave --out off to print the export');
    // Through a temp file and a rename: an export cut short (a full disk, a
    // killed process) left a truncated file where the last good export was.
    await writeFileAtomic(outPath, text);
    if (json) {
      line(io, JSON.stringify(jsonOk({ format, terms, ...rowsField, bytes, path: outPath, ...dropped, ...notes }), null, 2));
    } else {
      let counted = plural(terms, 'term');
      if (aliasRows !== undefined && rows !== undefined) {
        const without = aliasRows.filter((n) => n === 0).length;
        counted = `${plural(rows, 'row')} from ${plural(terms - without, 'term')}`;
        if (without > 0) counted += `; ${plural(without, 'term')} without an alias wrote no row`;
      }
      line(io, `wrote ${format} export (${counted}) to ${safe(outPath)}`);
    }
  } else if (json) {
    line(io, JSON.stringify(jsonOk({ format, terms, ...rowsField, bytes, content: text, ...dropped, ...notes }), null, 2));
  } else {
    io.stdout(text);
  }
  return 0;
}

/** `p` resolved through links when it exists, case-folded where the filesystem usually ignores case. */
async function samePathKey(p: string): Promise<string> {
  let real = path.resolve(p);
  try {
    real = await fs.realpath(real);
  } catch {
    // Not there yet: compare the path as given.
  }
  return process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase().normalize('NFC') : real;
}

/**
 * Why `lexicon export --out <outPath>` must not write there, or undefined. A
 * directory failed with a bare EISDIR, and the lexicon file the export was
 * read from (`--out ~/.config/lexicon/lexicon.yaml`, a slip of the shell
 * history) was overwritten with the export, losing every term.
 */
async function exportTargetProblem(outPath: string, loaded: LoadedLexicon): Promise<string | undefined> {
  try {
    if ((await fs.stat(outPath)).isDirectory()) return `--out ${outPath} is a directory, so nothing was exported`;
  } catch {
    // Nothing there: the export creates it.
  }
  const target = await samePathKey(outPath);
  for (const file of [loaded.global, loaded.project, loaded.skippedProject]) {
    if (file && (await samePathKey(file.path)) === target) {
      return `--out ${outPath} is the ${file.scope} lexicon file the export reads, so nothing was written (it would replace your terms with the export)`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// path
// ---------------------------------------------------------------------------

export interface PathOptions extends CommonOptions {
  /** Print `{ global, project }` as JSON (`project` is null when there is no project lexicon). */
  json?: boolean;
}

export async function runPath(opts: PathOptions, io: IO): Promise<number> {
  const paths = resolvePaths({ cwd: resolveCwd(opts) });
  if (opts.json) {
    line(io, JSON.stringify(jsonOk({ global: paths.global, project: paths.project ?? null }), null, 2));
    return 0;
  }
  line(io, `global: ${safe(paths.global)}`);
  line(io, `project: ${paths.project ? safe(paths.project) : '(none)'}`);
  return 0;
}
