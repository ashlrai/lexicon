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
  addTerm,
  loadLexicon,
  removeTerm,
  suggestAliases,
  suggestTerms,
} from '../core/index.js';
import type { LoadedLexicon, SuggestInput, Term, TermScope, TermSuggestion } from '../core/index.js';
import { askKey, createPrompter, isInteractive } from './prompt.js';
import type { Prompter } from './prompt.js';
import { bold, dim, fail, line, plural, renderTable, safe, safeLines, warnSkippedProject } from './io.js';
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
  addTerm?: typeof addTerm;
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
      return `new term ${bold(safe(s.canonical))}${s.aliases?.length ? dim(` (aliases: ${safe(s.aliases.join(', '))})`) : ''}`;
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
  const existing = loaded.merged.terms.find((t) => t.canonical.trim().toLowerCase() === s.canonical.trim().toLowerCase());
  return existing?.scope ?? 'global';
}

/**
 * Apply one suggestion through the store. Returns a one-line report.
 * Throws ProjectTrustError (and any other store error) to the caller.
 */
async function applyOne(
  s: TermSuggestion,
  loaded: LoadedLexicon,
  opts: SuggestCliOptions,
  store: { cwd: string; globalPath?: string },
  deps: Required<Pick<SuggestDeps, 'addTerm' | 'removeTerm'>>,
): Promise<string> {
  const scope = scopeFor(s, loaded, opts);
  switch (s.kind) {
    case 'alias': {
      const result = await deps.addTerm({ canonical: s.canonical, aliases: s.alias ? [s.alias] : [] }, { ...store, scope });
      return `alias ${safe(s.alias ?? '')} -> ${safe(result.term.canonical)} in ${safe(result.file.path)}`;
    }
    case 'never': {
      const result = await deps.addTerm(
        { canonical: s.canonical, aliases: [], never: s.alias ? [s.alias] : [] },
        { ...store, scope },
      );
      return `never ${safe(s.alias ?? '')} for ${safe(result.term.canonical)} in ${safe(result.file.path)}`;
    }
    case 'term': {
      const term: Term = {
        canonical: s.canonical,
        aliases: s.aliases ?? suggestAliases(s.canonical),
        source: 'learned',
      };
      if (s.category) term.category = s.category;
      const result = await deps.addTerm(term, { ...store, scope });
      return `${result.created ? 'added' : 'merged'} ${safe(result.term.canonical)} in ${safe(result.file.path)}`;
    }
    case 'stale': {
      const removed = await deps.removeTerm(s.canonical, { ...store, scope });
      return removed ? `removed ${safe(s.canonical)}` : `${safe(s.canonical)} was already gone`;
    }
    default:
      return `skipped ${safe(s.canonical)}`;
  }
}

export async function runSuggest(opts: SuggestCliOptions, io: IO, deps: SuggestDeps = {}): Promise<number> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const store = opts.globalPath ? { cwd, globalPath: opts.globalPath } : { cwd };
  const load = deps.loadLexicon ?? loadLexicon;
  const suggest = deps.suggest ?? suggestTerms;
  const writers = { addTerm: deps.addTerm ?? addTerm, removeTerm: deps.removeTerm ?? removeTerm };

  // An explicit --cwd or --harvest turns the repo harvest on; a bare `lexicon suggest` only reads the history.
  let harvestDir: string | undefined;
  if (typeof opts.harvest === 'string') harvestDir = path.resolve(opts.harvest);
  else if (opts.harvest === true || opts.cwd) harvestDir = cwd;

  if (opts.apply && opts.yes) {
    io.stderr('lexicon: --apply and --yes are mutually exclusive\n');
    return 1;
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
    loaded = await load(store);
    warnSkippedProject(loaded, io);
    const input: SuggestInput = { loaded };
    if (harvestDir !== undefined) input.cwd = harvestDir;
    if (opts.limit !== undefined) input.limit = opts.limit;
    if (deps.now !== undefined) input.now = deps.now;
    suggestions = await suggest(input);
  } catch (err) {
    return fail(io, err);
  }

  if (opts.json) {
    line(io, JSON.stringify(suggestions, null, 2));
    return 0;
  }
  if (suggestions.length === 0) {
    line(io, dim('no suggestions: dictate with `lexicon voice` for a while, or run `lexicon suggest --harvest` inside a repo'));
    return 0;
  }

  const apply = async (s: TermSuggestion): Promise<boolean> => {
    try {
      line(io, `  ${await applyOne(s, loaded, opts, store, writers)}`);
      return true;
    } catch (err) {
      if (err instanceof ProjectTrustError) {
        io.stderr(`lexicon: ${safeLines(err.message)}\n`);
        return false;
      }
      throw err;
    }
  };

  if (opts.yes) {
    let applied = 0;
    let skipped = 0;
    for (const s of suggestions) {
      if (s.confidence < AUTO_APPLY_CONFIDENCE) {
        skipped += 1;
        continue;
      }
      line(io, `${describe(s)}  ${dim(`${s.confidence.toFixed(2)}, seen ${s.count}x`)}`);
      if (!(await apply(s))) return 1;
      applied += 1;
    }
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
        key = await askKey(prompter, `  apply? ${dim(`[y/n/a/q]`)}`, APPLY_KEYS, def);
      }
      if (key === 'q') {
        skipped += suggestions.length - i;
        break;
      }
      if (key === 'a') {
        all = true;
        key = 'y';
      }
      if (key === 'y') {
        if (!(await apply(s))) return 1;
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
  const positiveInt = (value: string): number => {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error('expected a positive integer');
    return n;
  };

  program
    .command('suggest')
    .description('suggest aliases, new terms, never-words and stale terms from your voice history')
    .option('--json', 'print the suggestions as JSON')
    .option('--apply', 'walk the suggestions one by one: y apply, n skip, a apply all remaining, q quit')
    .option('--yes', `apply every suggestion at or above ${AUTO_APPLY_CONFIDENCE.toFixed(2)} confidence without asking`)
    .option('--harvest [dir]', 'also harvest a repository for new-term candidates (default: the --cwd directory); an explicit --cwd harvests too')
    .option('--limit <n>', 'max suggestions (default 20)', positiveInt)
    .option('--project', 'write new terms to the project lexicon instead of the global one')
    .action(async (opts: SuggestCliOptions) => done(await runSuggest({ ...opts, ...globals() }, io)));
}
