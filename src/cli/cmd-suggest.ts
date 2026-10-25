/**
 * `lexicon suggest`: what the lexicon should learn next, mined from the voice
 * history and the lexicon itself (see core/suggestTerms.ts). Prints a table
 * by default; `--json` for machines; `--apply` walks the suggestions with a
 * Prompter (y/n/a/q); `--yes` applies everything at or above
 * AUTO_APPLY_CONFIDENCE without asking. `runSuggest` takes its collaborators
 * as `deps` so tests run it against a mocked store.
 */
import path from 'node:path';
import type { Command } from 'commander';
import {
  AUTO_APPLY_CONFIDENCE,
  ProjectTrustError,
  addTerms,
  defaultProjectPath,
  loadLexicon,
  removeTerm,
  suggestAliases,
  suggestTerms,
  spellingKey,
  termHolders,
  SUGGEST_MAX_LIMIT,
} from '../core/index.js';
import type { LoadedLexicon, SuggestInput, Term, TermScope, TermSuggestion } from '../core/index.js';
import { askKey, createPrompter, isInteractive } from './prompt.js';
import type { Prompter } from './prompt.js';
import { bold, dim, fail, line, plural, positiveIntOption, refuse, renderTable, safe, safeLines, stillInLine, warnSkippedProject } from './io.js';
import type { CommonOptions, IO } from './io.js';

export interface SuggestCliOptions extends CommonOptions {
  json?: boolean;
  /** Walk the suggestions interactively (needs a terminal or a `deps.prompter`). */
  apply?: boolean;
  /** Apply every suggestion at or above AUTO_APPLY_CONFIDENCE without asking. */
  yes?: boolean;
  /** Harvest this repository for new-term candidates (`true` = the cwd). */
  harvest?: string | boolean;
  limit?: number;
  /** Write new terms to the project lexicon instead of the global one. */
  project?: boolean;
  /** Explicit global lexicon path; overrides $LEXICON_PATH (tests). */
  globalPath?: string;
}

/** Collaborators `runSuggest` uses; tests replace them. */
export interface SuggestDeps {
  suggest?: (input: SuggestInput) => Promise<TermSuggestion[]>;
  loadLexicon?: typeof loadLexicon;
  /** Every add goes through it: a run of consecutive adds to one file is one call (one read, one write). */
  addTerms?: typeof addTerms;
  removeTerm?: typeof removeTerm;
  prompter?: Prompter;
  /** Epoch milliseconds for the stale-term age check. */
  now?: number;
}

const APPLY_KEYS = ['y', 'n', 'a', 'q'] as const;
const APPLY_HELP = '[y]es  [n]o  [a]ll remaining  [q]uit';

function describe(s: TermSuggestion): string {
  switch (s.kind) {
    case 'alias':
      return `add alias ${bold(safe(s.alias ?? ''))} to ${bold(safe(s.canonical))}`;
    case 'never':
      return `protect ${bold(safe(s.alias ?? ''))} from ${bold(safe(s.canonical))} (never)`;
    case 'term':
      return `new term ${bold(safe(s.canonical))}${s.aliases?.length ? dim(` (aliases: ${s.aliases.map(safe).join(', ')})`) : ''}`;
    case 'phonetic':
      return `pronounce ${bold(safe(s.canonical))} as ${bold(safe(s.phonetic ?? ''))} (phonetic hint)`;
    case 'stale':
      return `remove ${bold(safe(s.canonical))}`;
    default:
      return safe(s.canonical);
  }
}

function showSuggestion(io: IO, s: TermSuggestion, index: number, total: number): void {
  line(io, `${dim(`[${index + 1}/${total}]`)} ${describe(s)}  ${dim(`${s.kind}, ${s.confidence.toFixed(2)}, seen ${s.count}x`)}`);
  line(io, `  ${safe(s.reason)}`);
  for (const e of s.evidence.slice(0, 3)) line(io, `  ${dim('>')} ${safe(e)}`);
}

export function renderSuggestions(suggestions: readonly TermSuggestion[]): string {
  return renderTable(
    suggestions.map((s) => [s.kind, s.canonical, s.alias ?? '', String(s.count), s.confidence.toFixed(2), s.reason]),
    ['kind', 'canonical', 'alias', 'count', 'confidence', 'reason'],
  );
}

/** The file a suggestion writes to: the term's own file, or the project file for new terms with --project. */
function scopeFor(s: TermSuggestion, loaded: LoadedLexicon, opts: SuggestCliOptions): TermScope {
  if (s.kind === 'term') return opts.project ? 'project' : 'global';
  const key = spellingKey(s.canonical);
  const existing = loaded.merged.terms.find((t) => spellingKey(t.canonical) === key);
  return existing?.scope ?? 'global';
}

/**
 * What `suggest --yes --json` reports for one suggestion it applied: the
 * suggestion's kind, canonical and alias, what the write did, and the file it
 * wrote (`path`, absent only for a stale term that was already gone).
 */
export interface SuggestApplied {
  kind: TermSuggestion['kind'];
  canonical: string;
  alias?: string;
  scope: TermScope;
  action: 'added' | 'merged' | 'removed' | 'already-gone' | 'skipped';
  path?: string;
  /** For a removed stale term: the other files that still hold a copy. */
  stillIn?: Array<{ scope: TermScope; path: string }>;
}

type Writers = Required<Pick<SuggestDeps, 'addTerms' | 'removeTerm'>>;
type StoreRef = { cwd: string; globalPath?: string };
type Applied = { text: string; record: SuggestApplied };

/** The term an alias, never or term suggestion adds; undefined for the kinds that do not add. */
function termFor(s: TermSuggestion): Term | undefined {
  switch (s.kind) {
    case 'alias':
      return { canonical: s.canonical, aliases: s.alias ? [s.alias] : [] };
    case 'never':
      return { canonical: s.canonical, aliases: [], never: s.alias ? [s.alias] : [] };
    case 'phonetic':
      // The store keeps an existing hint (`phonetic ??=`), so a hint the user wrote is never overwritten.
      return s.phonetic ? { canonical: s.canonical, aliases: [], phonetic: s.phonetic } : undefined;
    case 'term': {
      const term: Term = { canonical: s.canonical, aliases: s.aliases ?? suggestAliases(s.canonical), source: 'learned' };
      if (s.category) term.category = s.category;
      return term;
    }
    default:
      return undefined;
  }
}

function baseRecord(s: TermSuggestion): Pick<SuggestApplied, 'kind' | 'canonical' | 'alias'> {
  return { kind: s.kind, canonical: s.canonical, ...(s.alias !== undefined ? { alias: s.alias } : {}) };
}

/** The report for one add, from what the store did with it. */
function addedReport(s: TermSuggestion, result: { term: Term; created: boolean }, file: { path: string; scope: TermScope }): Applied {
  const record: SuggestApplied = { ...baseRecord(s), scope: file.scope, action: result.created ? 'added' : 'merged', path: file.path };
  switch (s.kind) {
    case 'alias':
      return { text: `alias ${safe(s.alias ?? '')} -> ${safe(result.term.canonical)} in ${safe(file.path)}`, record };
    case 'never':
      return { text: `never ${safe(s.alias ?? '')} for ${safe(result.term.canonical)} in ${safe(file.path)}`, record };
    case 'phonetic':
      return { text: `phonetic ${safe(result.term.phonetic ?? '')} for ${safe(result.term.canonical)} in ${safe(file.path)}`, record };
    default:
      return { text: `${result.created ? 'added' : 'merged'} ${safe(result.term.canonical)} in ${safe(file.path)}`, record };
  }
}

/** Apply a suggestion that does not add (a stale removal, or a kind this build does not know). */
async function applyOther(s: TermSuggestion, scope: TermScope, loaded: LoadedLexicon, store: StoreRef, writers: Writers): Promise<Applied> {
  const base = baseRecord(s);
  if (s.kind !== 'stale') return { text: `skipped ${safe(s.canonical)}`, record: { ...base, scope, action: 'skipped' } };
  const removed = await writers.removeTerm(s.canonical, { ...store, scope });
  if (!removed) return { text: `${safe(s.canonical)} was already gone`, record: { ...base, scope, action: 'already-gone' } };
  // removeTerm edits only `scope`'s file. A copy in the other file keeps
  // correcting, so name it and the command that removes it too.
  const holders = termHolders(loaded, s.canonical);
  const from = holders.find((h) => h.scope === scope);
  const others = holders.filter((h) => h.scope !== scope);
  const head = `removed ${safe(s.canonical)}${from ? ` from ${safe(from.path)}` : ''}`;
  return {
    text: [head, ...others.map((h) => stillInLine(s.canonical, h))].join('\n  '),
    record: {
      ...base,
      scope,
      action: 'removed',
      ...(from ? { path: from.path } : {}),
      ...(others.length > 0 ? { stillIn: others.map((h) => ({ scope: h.scope, path: h.path })) } : {}),
    },
  };
}

/** A store error while applying `suggestions[index]`; nothing from that suggestion on was written. */
class ApplyFailure extends Error {
  constructor(
    readonly index: number,
    readonly failure: unknown,
  ) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/**
 * Apply `suggestions` in order through the store and hand each report to
 * `onApplied` in that order. A run of consecutive adds bound for the same
 * file is one `addTerms` call, so `suggest --yes` with 30 new aliases reads
 * and writes the lexicon once instead of 30 times (each write re-parses the
 * whole file). Adds to the other file and removals end a run, so every write
 * happens in the order the suggestions came in. A store error throws an
 * ApplyFailure naming the first suggestion that was not written: a refused
 * run writes nothing, and the reports of everything before it have been
 * handed out.
 */
async function applyInOrder(
  suggestions: readonly TermSuggestion[],
  loaded: LoadedLexicon,
  opts: SuggestCliOptions,
  store: StoreRef,
  writers: Writers,
  onApplied: (s: TermSuggestion, applied: Applied, index: number) => void,
): Promise<void> {
  let run: { index: number; s: TermSuggestion; term: Term }[] = [];
  let runScope: TermScope = 'global';
  const flush = async (): Promise<void> => {
    if (run.length === 0) return;
    const pending = run;
    run = [];
    let batch: Awaited<ReturnType<Writers['addTerms']>>;
    try {
      batch = await writers.addTerms(pending.map((p) => p.term), { ...store, scope: runScope });
    } catch (err) {
      throw new ApplyFailure(pending[0].index, err);
    }
    pending.forEach((p, k) => onApplied(p.s, addedReport(p.s, batch.results[k], batch.file), p.index));
  };
  for (let index = 0; index < suggestions.length; index += 1) {
    const s = suggestions[index];
    const scope = scopeFor(s, loaded, opts);
    const term = termFor(s);
    if (term) {
      if (scope !== runScope) await flush();
      runScope = scope;
      run.push({ index, s, term });
      continue;
    }
    await flush();
    let applied: Applied;
    try {
      applied = await applyOther(s, scope, loaded, store, writers);
    } catch (err) {
      throw new ApplyFailure(index, err);
    }
    onApplied(s, applied, index);
  }
  await flush();
}

export async function runSuggest(opts: SuggestCliOptions, io: IO, deps: SuggestDeps = {}): Promise<number> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const store = opts.globalPath ? { cwd, globalPath: opts.globalPath } : { cwd };
  const load = deps.loadLexicon ?? loadLexicon;
  const suggest = deps.suggest ?? suggestTerms;
  const writers: Writers = { addTerms: deps.addTerms ?? addTerms, removeTerm: deps.removeTerm ?? removeTerm };

  // An explicit --cwd or --harvest turns the repo harvest on; a bare `lexicon suggest` only reads the history.
  let harvestDir: string | undefined;
  if (typeof opts.harvest === 'string') harvestDir = path.resolve(opts.harvest);
  else if (opts.harvest === true || opts.cwd) harvestDir = cwd;

  const threshold = AUTO_APPLY_CONFIDENCE.toFixed(2);
  if (opts.apply && opts.yes) {
    return refuse(io, opts.json, '--apply and --yes are mutually exclusive', `pass --apply to choose one by one, or --yes to apply those at or above ${threshold}`);
  }
  // --apply asks a question per suggestion; under --json stdout is the
  // document, so it printed the bare suggestion array and applied nothing.
  if (opts.apply && opts.json) {
    return refuse(io, true, '--apply asks about each suggestion and cannot be combined with --json', `pass --yes --json to apply those at or above ${threshold} without asking, or drop --json`);
  }
  if (opts.apply && !opts.json && !deps.prompter && !isInteractive()) {
    io.stderr(
      `lexicon: suggest --apply needs a terminal (stdin and stdout must be a TTY); use --yes to apply everything at or above ${AUTO_APPLY_CONFIDENCE.toFixed(2)} confidence\n`,
    );
    return 1;
  }

  let loaded: LoadedLexicon;
  let suggestions: TermSuggestion[];
  try {
    // Suggestions read only the merged terms, the global file and a trusted
    // project file, and a skipped file is named by path, so an untrusted or
    // changed one is never parsed (as MCP suggest_terms loads).
    loaded = await load({ ...store, parseSkipped: false });
    warnSkippedProject(loaded, io);
    const input: SuggestInput = { loaded };
    if (harvestDir !== undefined) input.cwd = harvestDir;
    if (opts.limit !== undefined) input.limit = opts.limit;
    if (deps.now !== undefined) input.now = deps.now;
    suggestions = await suggest(input);
  } catch (err) {
    return fail(io, err, opts.json);
  }
  // A new term goes to the project lexicon with --project (scopeFor), but
  // suggestTerms names the global file for one, so `--project --json`
  // printed the wrong `scope` and `path` for every 'term' suggestion.
  if (opts.project) {
    const projectPath = loaded.project?.path ?? loaded.skippedProject?.path ?? defaultProjectPath(cwd);
    suggestions = suggestions.map((s) => (s.kind === 'term' ? { ...s, scope: 'project' as const, path: projectPath } : s));
  }

  if (opts.json && opts.yes) return applyAllJson(suggestions, loaded, opts, store, writers, io);
  if (opts.json) {
    line(io, JSON.stringify(suggestions, null, 2));
    return 0;
  }
  if (suggestions.length === 0) {
    // After --harvest it still said to run --harvest, the step just taken.
    line(
      io,
      dim(
        harvestDir === undefined
          ? 'no suggestions: dictate with `lexicon voice` for a while, or run `lexicon suggest --harvest` inside a repo'
          : `no suggestions: the voice history and ${safe(harvestDir)} hold nothing the lexicon does not already have; dictate with \`lexicon voice\` for a while`,
      ),
    );
    return 0;
  }

  /**
   * applyInOrder for the text modes: true, or false once a ProjectTrustError
   * is on stderr; any other store error is thrown. `onFailed` gets the index
   * (in `list`) of the suggestion that was not written, before either.
   */
  const applyText = async (
    list: readonly TermSuggestion[],
    onApplied: (s: TermSuggestion, applied: Applied, index: number) => void,
    onFailed: (index: number) => void,
  ): Promise<boolean> => {
    try {
      await applyInOrder(list, loaded, opts, store, writers, onApplied);
      return true;
    } catch (err) {
      if (!(err instanceof ApplyFailure)) throw err;
      onFailed(err.index);
      if (err.failure instanceof ProjectTrustError) {
        io.stderr(`lexicon: ${safeLines(err.failure.message)}\n`);
        return false;
      }
      throw err.failure;
    }
  };

  if (opts.yes) {
    const confident = suggestions.filter((s) => s.confidence >= AUTO_APPLY_CONFIDENCE);
    const skipped = suggestions.length - confident.length;
    const head = (s: TermSuggestion): void => line(io, `${describe(s)}  ${dim(`${s.confidence.toFixed(2)}, seen ${s.count}x`)}`);
    let applied = 0;
    const ok = await applyText(
      confident,
      (s, done) => {
        head(s);
        line(io, `  ${done.text}`);
        applied += 1;
      },
      (index) => head(confident[index]),
    );
    if (!ok) return 1;
    line(io, `applied ${plural(applied, 'suggestion')}, skipped ${skipped} below ${AUTO_APPLY_CONFIDENCE.toFixed(2)}${skipped > 0 ? ' (run `lexicon suggest --apply` to review them)' : ''}`);
    return 0;
  }

  if (!opts.apply) {
    io.stdout(renderSuggestions(suggestions));
    line(io, dim(`${plural(suggestions.length, 'suggestion')}. \`lexicon suggest --apply\` walks them; \`--yes\` applies those at or above ${AUTO_APPLY_CONFIDENCE.toFixed(2)}.`));
    return 0;
  }

  const own = deps.prompter === undefined;
  const prompter = deps.prompter ?? createPrompter({ input: process.stdin, output: process.stdout });
  let applied = 0;
  let skipped = 0;
  let all = false;
  try {
    line(io, `${bold(plural(suggestions.length, 'suggestion'))} ${dim(APPLY_HELP)}`);
    line(io);
    for (let i = 0; i < suggestions.length; i += 1) {
      const s = suggestions[i];
      showSuggestion(io, s, i, suggestions.length);
      let key: string;
      if (all && s.kind !== 'stale') {
        key = 'y';
      } else {
        // Removing a term is the one irreversible step: never the default, never swept up by "all".
        const def = s.kind === 'stale' ? 'n' : 'y';
        // An answer that is not a key reprints what the keys do, as review and
        // harvest -i do; the one line naming them scrolled away suggestions ago.
        key = await askKey(prompter, `  apply? ${dim(`[y/n/a/q]`)}`, APPLY_KEYS, def, () =>
          line(io, `  ${dim(`${APPLY_HELP}  (Enter = ${def})`)}`),
        );
      }
      if (key === 'q') {
        skipped += suggestions.length - i;
        break;
      }
      if (key === 'a') {
        all = true;
        key = 'y';
      }
      if (key === 'y' && all && s.kind !== 'stale') {
        // "all": this suggestion and every one up to the next stale removal
        // (which is still asked about), applied together; each is shown and
        // reported as it was when they were applied one at a time.
        let end = i + 1;
        while (end < suggestions.length && suggestions[end].kind !== 'stale') end += 1;
        const sweep = suggestions.slice(i, end);
        const at = i;
        const ok = await applyText(
          sweep,
          (swept, done, k) => {
            if (k > 0) showSuggestion(io, swept, at + k, suggestions.length);
            line(io, `  ${done.text}`);
            line(io);
            applied += 1;
          },
          (k) => {
            if (k > 0) showSuggestion(io, sweep[k], at + k, suggestions.length);
          },
        );
        if (!ok) return 1;
        i = end - 1;
        continue;
      }
      if (key === 'y') {
        if (!(await applyText([s], (_, done) => line(io, `  ${done.text}`), () => undefined))) return 1;
        applied += 1;
      } else {
        skipped += 1;
      }
      line(io);
    }
  } finally {
    if (own) prompter.close();
  }
  line(io, `applied ${plural(applied, 'suggestion')}, skipped ${skipped}`);
  return 0;
}

/**
 * `suggest --yes --json`: apply every suggestion at or above
 * AUTO_APPLY_CONFIDENCE and print one document, `{ ok: true, threshold,
 * applied, skipped }` (`applied` the SuggestApplied records, `skipped` the
 * suggestions below the threshold, as `--json` prints them). It printed the
 * bare suggestion array and wrote nothing, so a script could not tell `--yes`
 * was dropped. A write the store refuses stops the run with `{ ok: false,
 * error, nextStep, applied }`, `applied` listing what was written before it.
 */
async function applyAllJson(
  suggestions: readonly TermSuggestion[],
  loaded: LoadedLexicon,
  opts: SuggestCliOptions,
  store: StoreRef,
  writers: Writers,
  io: IO,
): Promise<number> {
  const applied: SuggestApplied[] = [];
  const skipped = suggestions.filter((s) => s.confidence < AUTO_APPLY_CONFIDENCE);
  const confident = suggestions.filter((s) => s.confidence >= AUTO_APPLY_CONFIDENCE);
  try {
    await applyInOrder(confident, loaded, opts, store, writers, (_, done) => applied.push(done.record));
  } catch (failure) {
    if (!(failure instanceof ApplyFailure)) throw failure;
    const err = failure.failure;
    const error = err instanceof Error ? err.message : String(err);
    const nextStep =
      err instanceof ProjectTrustError
        ? 'review the project lexicon and run lexicon trust, or drop --project to write new terms to the global lexicon, then run lexicon suggest --yes --json again'
        : 'fix the problem in error, then run lexicon suggest --yes --json again';
    io.stderr(`lexicon: ${safeLines(error)}\n`);
    line(io, JSON.stringify({ ok: false, error, nextStep, applied }, null, 2));
    return 1;
  }
  line(io, JSON.stringify({ ok: true, threshold: AUTO_APPLY_CONFIDENCE, applied, skipped }, null, 2));
  return 0;
}

// ---------------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------------

export function registerSuggestCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };
  const done = (code: number): void => {
    if (code !== 0) process.exitCode = code;
  };

  program
    .command('suggest')
    .description('suggest aliases, new terms, never-words and stale terms from your voice history')
    .option('--json', 'print the suggestions as JSON; with --yes, one document naming what was applied and the file each went to')
    .option('--apply', 'walk the suggestions one by one: y apply, n skip, a apply all remaining, q quit')
    .option('--yes', `apply every suggestion at or above ${AUTO_APPLY_CONFIDENCE.toFixed(2)} confidence without asking`)
    .option('--harvest [dir]', 'also harvest a repository for new-term candidates (default: the --cwd directory); an explicit --cwd harvests too')
    .option('--limit <n>', `max suggestions (default 20, at most ${SUGGEST_MAX_LIMIT})`, positiveIntOption('--limit', 20, SUGGEST_MAX_LIMIT))
    .option('--project', 'write new terms to the project lexicon instead of the global one')
    .action(async (opts: SuggestCliOptions) => done(await runSuggest({ ...opts, ...globals() }, io)));
}
