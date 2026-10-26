/**
 * Interactive CLI workflows: the `harvest --interactive` walkthrough,
 * `lexicon review` (walk existing terms and keep/delete/edit them) and
 * `lexicon edit` (open a lexicon file in $VISUAL/$EDITOR and validate it
 * afterwards). Handlers take a Prompter so tests can script the answers;
 * registerReviewCommands() only wires commander.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import {
  ProjectTrustError,
  TERM_CATEGORIES,
  addTerm,
  addTerms,
  effectiveHits,
  emptyLexicon,
  isTrusted,
  loadLexicon,
  parsedContentHash,
  readLexiconFile,
  readHitsFor,
  withLexiconLock,
  refreshIndexCache,
  refreshTrust,
  resolvePaths,
  spellingKey,
  writeLexiconFile,
} from '../core/index.js';
import type { HarvestCandidate, Lexicon, LexiconFile, Term, TermCategory, TermScope } from '../core/index.js';
import { PromptClosedError, askKey, createPrompter, isInteractive, splitList } from './prompt.js';
import type { Prompter } from './prompt.js';
import { errorMessage } from '../util/errors.js';
import { CliRefusal, bold, dim, line, parseCategory, plural, refuse, resolveCwd, safe, safeMessage } from './io.js';
import type { CommonOptions, IO } from './io.js';

function isCategory(value: string): value is TermCategory {
  return (TERM_CATEGORIES as readonly string[]).includes(value);
}

/** Ask for a category until a valid one (or the default) is given. */
async function askCategory(prompter: Prompter, def: TermCategory): Promise<TermCategory> {
  for (;;) {
    const answer = (await prompter.ask(`category (${TERM_CATEGORIES.join('|')})`, { default: def })).trim().toLowerCase();
    if (isCategory(answer)) return answer;
    // Re-ask; the prompter shows the list in the question.
  }
}

/**
 * What a walk prints for an answer that is not one of its keys: the key list
 * again, since the one line naming them scrolled away terms ago.
 */
function keyHelp(io: IO, help: string, def: string): (answer: string) => void {
  return () => line(io, `  ${dim(`${help}  (Enter = ${def})`)}`);
}

/** Options every interactive handler shares. `globalPath` is a test hook (no CLI flag). */
export interface InteractiveOptions extends CommonOptions {
  /** Explicit global lexicon path; overrides $LEXICON_PATH (tests). */
  globalPath?: string;
}

function storeOpts(opts: InteractiveOptions, cwd: string): { cwd: string; globalPath?: string } {
  return opts.globalPath ? { cwd, globalPath: opts.globalPath } : { cwd };
}

// ---------------------------------------------------------------------------
// harvest --interactive
// ---------------------------------------------------------------------------

/**
 * What the harvest behind a walk saw (`HarvestReport`'s counts, the root and
 * the `minCount` it ran with), so a walk with no candidates can say why.
 */
export interface HarvestScanContext {
  root: string;
  minCount: number;
  filesScanned: number;
  belowMinCount: number;
  symbolsOnly: number;
}

export interface HarvestInteractiveOptions extends InteractiveOptions {
  /** The scan the candidates came from; without it an empty walk says only that there was nothing to review. */
  harvest?: HarvestScanContext;
  /** Report what each answer would write; nothing is written. */
  dryRun?: boolean;
}

/**
 * The line for a harvest that proposed nothing, saying why and what to try:
 * names left out for `--min-count` or as code symbols only (`--symbols`), no
 * readable file at all, or files scanned and no name in them. `harvest -i`
 * said only "no candidates to review", and plain `harvest` only "no
 * candidates found in <root>". Display-safe.
 */
export function noHarvestCandidatesLine(scan: HarvestScanContext): string {
  const head = `no candidates found in ${safe(scan.root)}`;
  const left = [
    ...(scan.belowMinCount > 0 ? [`${plural(scan.belowMinCount, 'name')} seen fewer than ${scan.minCount} times (to include them: --min-count 1)`] : []),
    ...(scan.symbolsOnly > 0 ? [`${plural(scan.symbolsOnly, 'name')} found only as code symbols (to include them: --symbols)`] : []),
  ];
  if (left.length > 0) return `${head}: left out ${left.join(' and ')}`;
  if (scan.filesScanned === 0) {
    return `${head}: it holds no package manifest, README or source file, and neither its name nor the git log gave one; harvest a project directory, or add a name with: lexicon add <canonical> <alias>`;
  }
  return `${head}: ${plural(scan.filesScanned, 'file')} scanned and no name in them to propose; add one yourself with: lexicon add <canonical> <alias>`;
}

/** `c` is already a term of `lexicon` with every alias the harvest suggests. */
function knownCandidate(lexicon: Lexicon, c: HarvestCandidate): boolean {
  const fold = (s: string): string => s.trim().toLowerCase().normalize('NFC');
  const term = lexicon.terms.find((t) => fold(t.canonical) === fold(c.canonical));
  if (!term) return false;
  const have = new Set([term.canonical, ...term.aliases].map(fold));
  return c.suggestedAliases.every((a) => have.has(fold(a)));
}

/** The next step after `harvest -i` or `review` changed the lexicon. */
const NEXT_LIST = 'next: run lexicon list to see the terms';

const HARVEST_KEYS = ['y', 'n', 'e', 'c', 'a', 'q'] as const;
const HARVEST_HELP = '[y]es  [n]o  [e]dit aliases  [c]ategory  [a]ll remaining  [q]uit';

function showCandidate(io: IO, c: HarvestCandidate, index: number, total: number): void {
  line(io, `${dim(`[${index + 1}/${total}]`)} ${bold(safe(c.canonical))}  ${dim(`${c.category}, seen ${c.count}x`)}`);
  line(io, `  evidence: ${c.evidence.length > 0 ? safe(c.evidence.slice(0, 3).join(', ')) : dim('(none)')}`);
  line(io, `  aliases:  ${c.suggestedAliases.length > 0 ? safe(c.suggestedAliases.join(', ')) : dim('(none)')}`);
}

/**
 * Walk harvest candidates one by one and add the accepted ones to the project
 * lexicon of `opts.cwd` (the harvested root). Returns an exit code: 1 when the
 * project lexicon is untrusted (nothing is written), 0 otherwise.
 */
export async function runHarvestInteractive(
  candidates: readonly HarvestCandidate[],
  opts: HarvestInteractiveOptions,
  io: IO,
  prompter: Prompter,
): Promise<number> {
  const cwd = resolveCwd(opts);
  const store = storeOpts(opts, cwd);

  if (candidates.length === 0) {
    line(io, dim(opts.harvest ? noHarvestCandidatesLine(opts.harvest) : 'no candidates to review'));
    return 0;
  }
  // Every candidate already a term with its aliases: the walk could only
  // merge nothing into each, one prompt at a time.
  const loadedForKnown = await loadLexicon(store).catch(() => undefined);
  if (loadedForKnown && candidates.every((c) => knownCandidate(loadedForKnown.merged, c))) {
    line(
      io,
      dim(
        `nothing to review: ${candidates.length === 1 ? 'the 1 candidate is' : `all ${candidates.length} candidates are`} already in the lexicon with ${candidates.length === 1 ? 'its' : 'their'} suggested aliases. ` +
          'To see them: lexicon list; to go over existing terms: lexicon review',
      ),
    );
    return 0;
  }

  // Check the trust gate up front so the user is not asked twenty questions
  // only to have the first write refused.
  const projectPath = resolvePaths(store).project;
  if (projectPath && existsSync(projectPath)) {
    const status = await isTrusted({ path: projectPath, scope: 'project', lexicon: emptyLexicon(), exists: true }, store);
    if (status !== 'trusted') {
      io.stderr(`lexicon: ${safeMessage(new ProjectTrustError(projectPath, status).message)}\n`);
      return 1;
    }
  }

  line(io, `${bold(`${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`)} ${dim(HARVEST_HELP)}`);
  line(io);

  // Local, editable copies so "e" and "c" never mutate the caller's candidates.
  const work: HarvestCandidate[] = candidates.map((c) => ({ ...c, suggestedAliases: [...c.suggestedAliases] }));
  let created = 0;
  let merged = 0;
  let skipped = 0;
  let filePath: string | undefined;
  let addAll = false;
  let quit = false;

  const dry = opts.dryRun === true;
  const toTerm = (c: HarvestCandidate): Term => ({ canonical: c.canonical, aliases: c.suggestedAliases, category: c.category, source: c.source });
  const report = (result: { term: Term; created: boolean }): void => {
    if (result.created) created += 1;
    else merged += 1;
    line(io, `  ${dry ? 'would add' : result.created ? 'added' : 'merged'} ${bold(safe(result.term.canonical))}`);
  };
  /**
   * A write that failed for any other reason (a full disk, a read-only or
   * unreadable file): it stops the walk, and the summary still says what the
   * earlier answers wrote. Thrown, it ended the walk with only the error, so
   * the terms already added went unmentioned.
   */
  let writeError: unknown;
  /** False after printing why the write was refused or failed (nothing in the call was written). */
  const refused = (err: unknown): false => {
    if (err instanceof ProjectTrustError) {
      io.stderr(`lexicon: ${safeMessage(err.message)}\n`);
      return false;
    }
    writeError = err;
    return false;
  };

  const add = async (c: HarvestCandidate): Promise<boolean> => {
    try {
      const result = await addTerm(toTerm(c), { ...store, scope: 'project', ...(dry ? { dryRun: true } : {}) });
      filePath = result.file.path;
      report(result);
      return true;
    } catch (err) {
      return refused(err);
    }
  };

  /**
   * The "a" key: this candidate and every one after it, in one read and one
   * write of the project file (addTerms) instead of one per candidate. The
   * first result is reported here; the rest are kept in `rest` and reported
   * after the walk's blank line, which is where a write per candidate printed
   * them. False after a refusal (nothing in the batch was written).
   */
  let rest: { term: Term; created: boolean }[] = [];
  const addRest = async (from: number): Promise<boolean> => {
    try {
      const batch = await addTerms(work.slice(from).map(toTerm), { ...store, scope: 'project', ...(dry ? { dryRun: true } : {}) });
      filePath = batch.file.path;
      report(batch.results[0]);
      rest = batch.results.slice(1);
      return true;
    } catch (err) {
      return refused(err);
    }
  };

  /** The candidate on screen; where ctrl-D stopped the walk, if it did. */
  let current = 0;
  let closedAt: number | undefined;
  try {
    walk: for (let i = 0; i < work.length && !quit && !addAll; i += 1) {
      current = i;
      const c = work[i];
      showCandidate(io, c, i, work.length);
      let decided = false;
      while (!decided) {
        const key = await askKey(prompter, `  add? ${dim('[y/n/e/c/a/q]')}`, HARVEST_KEYS, 'y', keyHelp(io, HARVEST_HELP, 'y'));
        switch (key) {
          case 'y':
            if (!(await add(c))) {
              if (writeError === undefined) return 1;
              skipped += work.length - i;
              break walk;
            }
            decided = true;
            break;
          case 'n':
            skipped += 1;
            decided = true;
            break;
          case 'e': {
            const answer = await prompter.ask('  aliases (comma-separated, replaces the suggestions)', {
              default: c.suggestedAliases.join(', '),
            });
            c.suggestedAliases = splitList(answer).filter((a) => a.toLowerCase() !== c.canonical.toLowerCase());
            line(io, `  aliases:  ${c.suggestedAliases.length > 0 ? safe(c.suggestedAliases.join(', ')) : dim('(none)')}`);
            break;
          }
          case 'c':
            c.category = await askCategory(prompter, c.category);
            line(io, `  category: ${c.category}`);
            break;
          case 'a':
            addAll = true;
            if (!(await addRest(i))) {
              if (writeError === undefined) return 1;
              skipped += work.length - i;
              break walk;
            }
            decided = true;
            break;
          case 'q':
            quit = true;
            skipped += work.length - i;
            decided = true;
            break;
          default:
            break;
        }
      }
      line(io);
    }
  } catch (err) {
    // ctrl-D is a quit. Rethrown, it printed only `input closed before the
    // prompt was answered`, so the terms already added (each is written as
    // it is accepted) went unmentioned.
    if (!(err instanceof PromptClosedError)) throw err;
    closedAt = current;
    skipped += work.length - current;
    line(io);
  }
  for (const result of rest) report(result);

  if (closedAt !== undefined) {
    const kept = created + merged > 0 ? 'the terms added before it stay in the project lexicon' : 'nothing was added';
    line(io, `input closed at candidate ${closedAt + 1} of ${work.length}; ${kept}`);
  }
  if (writeError !== undefined) {
    line(io);
    const kept = created + merged > 0 ? 'the terms added before it stay in the project lexicon' : 'nothing was added';
    io.stderr(`lexicon: could not write the project lexicon at candidate ${current + 1} of ${work.length} (${safeMessage(errorMessage(writeError))}); ${kept}\n`);
  }

  const where = filePath ? ` in ${safe(filePath)}` : '';
  line(io, dry ? `would add ${plural(created, 'new term')}, merge ${merged}, skip ${skipped}${where}; nothing was written` : `added ${plural(created, 'new term')}, merged ${merged}, skipped ${skipped}${where}`);
  if (filePath && !dry) line(io, dim(`project lexicon trusted (${safe(filePath)})`));
  // One way on, and only when there is something new to look at.
  if (created + merged > 0) line(io, dim(NEXT_LIST));
  return writeError === undefined ? 0 : 1;
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

export interface ReviewOptions extends InteractiveOptions {
  /** Only terms whose `hits` is 0 / unset. */
  neverHit?: boolean;
  /** Review the project .lexicon.yaml instead of the global file. */
  project?: boolean;
  /** Review the global file (the default; explicit for symmetry with --project). */
  global?: boolean;
  /** Only this category. */
  category?: string;
  /** Refused: review is interactive. Prints `{ ok: false, error, nextStep }` naming the non-interactive commands. */
  json?: boolean;
  /** Walk the terms but write nothing: the summary says what the answers would have changed. */
  dryRun?: boolean;
}

/**
 * What a script or agent runs instead of `lexicon review`: it asks about each
 * term, so it has no --json document to print.
 */
export const REVIEW_NON_INTERACTIVE_NEXT_STEP =
  'read terms with lexicon list --json, delete with lexicon remove <canonical> [--alias <alias>], change with lexicon add <canonical> <aliases...>; MCP: list_terms, remove_term, add_term';

/** What a script or agent runs instead of `lexicon edit`, which opens an editor. */
export const EDIT_NON_INTERACTIVE_NEXT_STEP =
  'change terms with lexicon add <canonical> <aliases...> and lexicon remove <canonical> [--alias <alias>], or edit the file lexicon path names; MCP: add_term, remove_term';

const REVIEW_KEYS = ['k', 'd', 'e', 'p', 'n', 'q'] as const;
const REVIEW_HELP = '[k]eep  [d]elete  [e]dit aliases  [p]honetic  [n]otes  [q]uit';

function showTerm(io: IO, t: Term, index: number, total: number, hits: number): void {
  const meta = [t.category ?? 'uncategorized', `${hits} hit${hits === 1 ? '' : 's'}`];
  if (t.source) meta.push(t.source);
  line(io, `${dim(`[${index + 1}/${total}]`)} ${bold(safe(t.canonical))}  ${dim(meta.join(', '))}`);
  line(io, `  aliases:  ${t.aliases.length > 0 ? safe(t.aliases.join(', ')) : dim('(none)')}`);
  if (t.phonetic) line(io, `  phonetic: ${safe(t.phonetic)}`);
  if (t.notes) line(io, `  notes:    ${safe(t.notes)}`);
}

/** sha256 of the file's bytes, or undefined when it cannot be read (deleted meanwhile). */
async function fileDigest(filePath: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
  } catch {
    return undefined;
  }
}

/** A term's identity as the store compares canonicals: trimmed, lowercased and NFC. */
function termKey(t: Term): string {
  return spellingKey(t.canonical);
}

/** Key-order-independent JSON of a term, for change detection. */
function termFingerprint(t: Term): string {
  return JSON.stringify(t, Object.keys(t).sort());
}

/**
 * Reconcile the reviewed terms with what is on disk now, for the case where
 * the file changed while the user was answering prompts (the MCP server or
 * the hook bumping `hits`, a `lexicon add` in another shell, ...). Without
 * this the review's final write would silently drop those changes.
 *
 * - a term the session deleted stays deleted;
 * - a term the session edited keeps the session's aliases/phonetic/notes and
 *   takes the larger of the two `hits`;
 * - a term the session did not touch takes the on-disk version, so aliases
 *   merged elsewhere and hit counts survive;
 * - a term that vanished from disk is dropped unless the session edited it;
 * - a term added on disk that the session never saw is appended.
 *
 * `changes` counts the terms whose written form differs from what the session
 * alone would have written.
 */
export function reconcileReview(
  session: readonly Term[],
  snapshot: ReadonlyMap<string, string>,
  disk: readonly Term[],
  edited: ReadonlySet<Term>,
  deleted: ReadonlySet<Term>,
): { terms: Term[]; changes: number } {
  const diskByKey = new Map<string, Term>();
  for (const t of disk) if (!diskByKey.has(termKey(t))) diskByKey.set(termKey(t), t);
  const terms: Term[] = [];
  let changes = 0;

  for (const t of session) {
    const key = termKey(t);
    const onDisk = diskByKey.get(key);
    diskByKey.delete(key);
    if (deleted.has(t)) continue;
    if (!onDisk) {
      // Removed elsewhere while we looked at it: only an explicit edit overrides that.
      if (edited.has(t)) terms.push(t);
      else changes += 1;
      continue;
    }
    if (!edited.has(t)) {
      terms.push(onDisk);
      if (termFingerprint(onDisk) !== snapshot.get(key)) changes += 1;
      continue;
    }
    const hits = Math.max(t.hits ?? 0, onDisk.hits ?? 0);
    if (hits > (t.hits ?? 0)) {
      t.hits = hits;
      changes += 1;
    }
    terms.push(t);
  }
  for (const t of diskByKey.values()) {
    terms.push(t);
    changes += 1;
  }
  return { terms, changes };
}

/** What creates a project lexicon with terms in it, for review to walk. */
const PROJECT_FIRST_STEP = 'lexicon harvest -i to pull names from this repo, or lexicon add "Ashlr.AI" Ashler --project';

/**
 * Pick the file a review/edit targets. Global by default; `--project` picks the
 * project file found for cwd (an error when there is none).
 */
async function pickFile(
  opts: { project?: boolean; global?: boolean } & InteractiveOptions,
  cwd: string,
): Promise<LexiconFile> {
  if (opts.project && opts.global) throw new Error('--project and --global are mutually exclusive');
  const paths = resolvePaths(storeOpts(opts, cwd));
  if (opts.project) {
    // `lexicon init --project` makes an empty file, which review then calls
    // empty: name a step that gives it terms to review.
    if (!paths.project) {
      throw new Error(`no project lexicon found for ${cwd}, so nothing to review yet (run: ${PROJECT_FIRST_STEP})`);
    }
    return readLexiconFile(paths.project, 'project');
  }
  return readLexiconFile(paths.global, 'global');
}

export async function runReview(opts: ReviewOptions, io: IO, prompter?: Prompter): Promise<number> {
  if (opts.json) return refuse(io, true, 'review is interactive and has no --json output', REVIEW_NON_INTERACTIVE_NEXT_STEP);
  const cwd = resolveCwd(opts);
  const store = storeOpts(opts, cwd);
  if (!prompter && !isInteractive()) {
    throw new CliRefusal('review needs a terminal (stdin and stdout must be a TTY); nothing was changed', REVIEW_NON_INTERACTIVE_NEXT_STEP);
  }
  const category = parseCategory(opts.category);

  const file = await pickFile(opts, cwd);
  if (!file.exists) {
    // A first run of `lexicon review` landed here and was told only that
    // there was nothing, with no way on.
    const create = file.scope === 'global' ? 'lexicon setup' : PROJECT_FIRST_STEP;
    line(io, dim(`no ${file.scope} lexicon at ${safe(file.path)} yet; run ${create} to create one`));
    return 0;
  }
  if (file.scope === 'project') {
    const status = await isTrusted(file, store);
    if (status !== 'trusted') {
      io.stderr(`lexicon: ${safeMessage(new ProjectTrustError(file.path, status).message)}\n`);
      return 1;
    }
  }
  // Remembered so a concurrent write (hits from the MCP server, an add in
  // another shell) can be detected and merged before the final write.
  const digestAtStart = await fileDigest(file.path);
  const snapshot = new Map(file.lexicon.terms.map((t) => [termKey(t), termFingerprint(t)]));

  // Review reads and writes the file itself, so its terms stay exactly as they
  // are on disk and a term's usage count is not among them any more: it is in
  // this user's sidecar. `--never-hit` would otherwise offer every term for
  // deletion, including the ones that fire every day.
  const hits = await readHitsFor(file, store);
  // A term without a category is an `other` one, as for list and export.
  const subject = file.lexicon.terms.filter(
    (t) => (!opts.neverHit || effectiveHits(t, hits) === 0) && (category === undefined || (t.category ?? 'other') === category),
  );
  if (subject.length === 0) {
    // Which of the two it is, as `lexicon list` says it: an empty file wants
    // a term, a filter that matched none wants the filter dropped.
    const filters = [...(opts.neverHit ? ['--never-hit'] : []), ...(category !== undefined ? [`--category ${category}`] : [])];
    const total = file.lexicon.terms.length;
    line(
      io,
      dim(
        total === 0 || filters.length === 0
          ? `no terms to review in ${safe(file.path)} yet. Try: lexicon add "Ashlr.AI" Ashler`
          : `no terms to review in ${safe(file.path)}: ${plural(total, 'term')} there, none matching ${filters.join(' ')} ` +
              `(run lexicon review without ${filters.length === 1 ? 'it' : 'them'} to see them)`,
      ),
    );
    return 0;
  }

  const own = prompter === undefined;
  const p = prompter ?? createPrompter({ input: process.stdin, output: process.stdout });
  const deleted = new Set<Term>();
  const editedTerms = new Set<Term>();
  let edited = 0;
  let kept = 0;
  let changed = false;
  /** Index of the first term with no answer: `q` there, or the prompt ctrl-D closed. */
  let stoppedAt = subject.length;
  let inputClosed = false;

  try {
    line(io, `${bold(`${plural(subject.length, 'term')} in ${safe(file.path)}`)} ${dim(REVIEW_HELP)}`);
    line(io);
    for (let i = 0; i < subject.length; i += 1) {
      stoppedAt = i;
      const t = subject[i];
      showTerm(io, t, i, subject.length, effectiveHits(t, hits));
      let decided = false;
      let quit = false;
      while (!decided) {
        const key = await askKey(p, `  ${dim('[k/d/e/p/n/q]')}`, REVIEW_KEYS, 'k', keyHelp(io, REVIEW_HELP, 'k'));
        switch (key) {
          case 'k':
            kept += 1;
            decided = true;
            break;
          case 'd':
            deleted.add(t);
            changed = true;
            // Worded as `lexicon remove` reports the same outcome.
            line(io, `  removed ${bold(safe(t.canonical))} from ${safe(file.path)}`);
            decided = true;
            break;
          case 'e': {
            const answer = await p.ask('  aliases (comma-separated)', { default: t.aliases.join(', ') });
            const next = splitList(answer).filter((a) => a.toLowerCase() !== t.canonical.toLowerCase());
            if (next.join('\0') !== t.aliases.join('\0')) {
              t.aliases = next;
              changed = true;
              edited += 1;
              editedTerms.add(t);
            }
            line(io, `  aliases:  ${t.aliases.length > 0 ? safe(t.aliases.join(', ')) : dim('(none)')}`);
            break;
          }
          case 'p': {
            const answer = (await p.ask('  phonetic hint (empty to clear)', { default: t.phonetic ?? '' })).trim();
            const next = answer === '' ? undefined : answer;
            if (next !== t.phonetic) {
              if (next === undefined) delete t.phonetic;
              else t.phonetic = next;
              changed = true;
              edited += 1;
              editedTerms.add(t);
            }
            line(io, `  phonetic: ${t.phonetic ? safe(t.phonetic) : dim('(none)')}`);
            break;
          }
          case 'n': {
            const answer = (await p.ask('  notes (empty to clear)', { default: t.notes ?? '' })).trim();
            const next = answer === '' ? undefined : answer;
            if (next !== t.notes) {
              if (next === undefined) delete t.notes;
              else t.notes = next;
              changed = true;
              edited += 1;
              editedTerms.add(t);
            }
            line(io, `  notes:    ${t.notes ? safe(t.notes) : dim('(none)')}`);
            break;
          }
          case 'q':
            quit = true;
            decided = true;
            break;
          default:
            break;
        }
      }
      line(io);
      if (quit) break;
      stoppedAt = i + 1;
    }
  } catch (err) {
    // ctrl-D (or a closed pipe) is a quit: the answers already given stand,
    // as they do in `harvest -i`, where each one is written as it is given.
    // Rethrown, the review lost every deletion and edit with no word on it.
    if (!(err instanceof PromptClosedError)) throw err;
    inputClosed = true;
    line(io);
  } finally {
    if (own) p.close();
  }
  // The term on screen when `q` or ctrl-D came is not "left as it was" when
  // an `e`, `p` or `n` already changed it: that edit is kept and written.
  const editedInProgress = stoppedAt < subject.length && editedTerms.has(subject[stoppedAt]) ? 1 : 0;
  const notReviewed = subject.length - stoppedAt - editedInProgress;

  let mergedElsewhere = 0;
  /** Set when the project file was rewritten during the review into something not trusted; nothing is written. */
  let untrustedOnDisk: string | undefined;
  /** Set when the file changed during the review and cannot be re-read to merge; nothing is written. */
  let unreadableOnDisk: string | undefined;
  if (changed) {
    // The lock goes here and not around the session. A review is interactive
    // and can sit open for minutes, so holding the file for its duration would
    // block every other writer on a human reading terms; that is what
    // `reconcileReview` exists for instead. What must be atomic is the last
    // few milliseconds: the digest check, the re-read it decides on, the merge
    // and the write. Without the lock a writer landing between the re-read and
    // the write is merged against a copy that is already stale, and the write
    // renames it away while reporting the merge succeeded.
    try {
      await withLexiconLock(file.path, async () => {
        if (digestAtStart !== undefined && (await fileDigest(file.path)) !== digestAtStart) {
          let disk: LexiconFile;
          try {
            disk = await readLexiconFile(file.path, file.scope);
          } catch (err) {
            // Writing the reviewed version here replaced what the other
            // writer put there, which is lost for good: leave it alone.
            unreadableOnDisk = errorMessage(err);
            return;
          }
          // A project file rewritten by something that does not re-pin trust
          // (a git pull, a hand edit) holds terms nobody reviewed. Merged, they
          // were written back and trusted by the refreshTrust below.
          if (file.scope === 'project') {
            const status = await isTrusted(disk, store);
            if (status !== 'trusted') {
              untrustedOnDisk = status;
              return;
            }
          }
          const merged = reconcileReview(file.lexicon.terms, snapshot, disk.lexicon.terms, editedTerms, deleted);
          // The session never touches settings, so the on-disk ones win too.
          file.lexicon = { ...disk.lexicon, terms: merged.terms };
          mergedElsewhere = merged.changes;
        } else {
          file.lexicon.terms = file.lexicon.terms.filter((t) => !deleted.has(t));
        }
        if (!opts.dryRun) await writeLexiconFile(file);
      });
    } catch (err) {
      // Thrown, it ended the review with only the error, not saying that
      // every answer given was lost with the write.
      io.stderr(
        `lexicon: could not write ${safeMessage(file.path)} (${safeMessage(errorMessage(err))}); nothing was written, ` +
          `so this review's ${plural(deleted.size, 'removal')} and ${plural(edited, 'edit')} were not saved\n`,
      );
      return 1;
    }
    if (unreadableOnDisk !== undefined) {
      io.stderr(
        `lexicon: ${safeMessage(file.path)} changed during review and cannot be read (${safeMessage(unreadableOnDisk)}), so nothing was written and ` +
          `this review's ${plural(deleted.size, 'removal')} and ${plural(edited, 'edit')} were not saved; ` +
          `fix the file (lexicon doctor names the problem), then run lexicon review${file.scope === 'project' ? ' --project' : ''} again\n`,
      );
      return 1;
    }
    if (untrustedOnDisk !== undefined) {
      io.stderr(
        `lexicon: ${safeMessage(file.path)} changed during review and is not trusted (${untrustedOnDisk}), so nothing was written and ` +
          `this review's ${plural(deleted.size, 'removal')} and ${plural(edited, 'edit')} were not saved; ` +
          'run lexicon trust to look at the new version, then lexicon review --project again\n',
      );
      return 1;
    }
    // The user's own edit must not flip a trusted project file to 'changed'.
    // Then the cached matcher index the hook reads next (a no-op where there
    // is none); writeLexiconFile already refreshed it for a global file.
    // Pinned to the bytes this write produced, so a lock-less writer (a git
    // pull, a hand edit) landing since is left 'changed', not blessed.
    if (file.scope === 'project' && !opts.dryRun) {
      await refreshTrust(file.path, { ...store, expectedSha256: await parsedContentHash(file) });
      await refreshIndexCache(file, store);
    }
  }
  if (inputClosed) line(io, `input closed at term ${stoppedAt + 1} of ${subject.length}; keeping the answers given before it`);
  if (mergedElsewhere > 0) line(io, `merged ${plural(mergedElsewhere, 'change')} made elsewhere during review`);
  // A quit used to report only the terms answered, so "kept 1, removed 0"
  // after `q` on term 2 of 40 said nothing of the other 39.
  const rest = notReviewed > 0 ? `, ${notReviewed} not reviewed (left as they were)` : '';
  line(
    io,
    `kept ${kept}, removed ${deleted.size}, edited ${edited}${rest}${changed ? (opts.dryRun ? `. Would write ${safe(file.path)}` : `. Wrote ${safe(file.path)}`) : ' (nothing written)'}`,
  );
  if (changed) line(io, dim(NEXT_LIST));
  return 0;
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

export interface EditOptions extends InteractiveOptions {
  /** Open the project .lexicon.yaml instead of the global file. */
  project?: boolean;
  /** Refused: edit opens an editor. Prints `{ ok: false, error, nextStep }` naming the non-interactive commands. */
  json?: boolean;
  /** Lexicon itself writes nothing: a missing file is not created, and a project file is not re-trusted or re-indexed after the edit. */
  dryRun?: boolean;
}

/** Runs `command args... filePath` attached to the terminal and resolves with its exit code. */
export type SpawnEditor = (command: string, args: readonly string[], filePath: string) => Promise<number>;

/** What `spawnEditorInherit` runs: the program, its argv and whether Node must pass that argv as written. */
export interface EditorSpawn {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/** cmd.exe metacharacters, each escaped with `^` (the qntm.org/cmd scheme, as cross-spawn does it). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a cmd.exe command line: quoted for the CRT parser, then every metacharacter `^`-escaped. */
function cmdQuote(arg: string): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`;
  return quoted.replace(CMD_META, '^$1');
}

/** An env lookup that ignores case, as Windows does (`Path`, `PATHEXT`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The editor's real file on win32: `command` as given when it names an
 * extension, else the first PATHEXT match, in the directory it names or on
 * PATH. The current directory is not searched, so a `code.cmd` planted in a
 * repository is not run in place of the one on PATH.
 */
function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv, isFile: (p: string) => boolean): string | undefined {
  const exts = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e.startsWith('.'));
  const hasExt = path.win32.extname(command) !== '';
  const candidates = (base: string): string[] => (hasExt ? [base] : exts.map((e) => base + e));
  const dirs = /[\\/]/.test(command) ? [''] : (envValue(env, 'PATH') ?? '').split(';').filter((d) => d.trim() !== '');
  for (const dir of dirs) {
    const base = dir ? path.win32.join(dir.replace(/^"(.*)"$/, '$1'), command) : command;
    for (const candidate of candidates(base)) if (isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * How to start `command args... filePath` without a shell. On POSIX that is
 * the command itself. On win32 an editor that resolves (PATHEXT, PATH) to a
 * `.cmd` or `.bat` shim, as `code`, `subl` and npm-installed editors do,
 * cannot be spawned directly (ENOENT, or EINVAL since Node's CVE-2024-27980
 * fix), so it runs through `%ComSpec%` (`cmd.exe /d /s /c "<line>"`) with
 * every part quoted and its cmd metacharacters escaped, so a file path with
 * `&`, `%` or spaces reaches the editor as one argument.
 */
export function resolveEditorSpawn(
  command: string,
  args: readonly string[],
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isFile: (p: string) => boolean = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
): EditorSpawn {
  const direct: EditorSpawn = { file: command, args: [...args, filePath], windowsVerbatimArguments: false };
  if (platform !== 'win32') return direct;
  const resolved = resolveWindowsCommand(command, env, isFile);
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return direct;
  const cmdLine = [resolved.replace(CMD_META, '^$1'), ...[...args, filePath].map(cmdQuote)].join(' ');
  return { file: envValue(env, 'COMSPEC') || 'cmd.exe', args: ['/d', '/s', '/c', `"${cmdLine}"`], windowsVerbatimArguments: true };
}

export const spawnEditorInherit: SpawnEditor = (command, args, filePath) =>
  new Promise<number>((resolve, reject) => {
    const run = resolveEditorSpawn(command, args, filePath);
    const child = spawn(run.file, run.args, { stdio: 'inherit', windowsVerbatimArguments: run.windowsVerbatimArguments });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

/**
 * `$VISUAL` then `$EDITOR`, split on whitespace so `code --wait` works, with
 * a single- or double-quoted part kept whole (quotes removed), as a shell
 * reads it: `"/Applications/Sublime Text.app/.../subl" -w` and
 * `"C:\Program Files\Notepad++\notepad++.exe"`. Split on every space, a
 * quoted editor path with a space in it was run as `"/Applications/Sublime`
 * and failed with ENOENT. Backslashes are kept as written (Windows paths).
 */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | undefined {
  const raw = (env.VISUAL?.trim() || env.EDITOR?.trim()) ?? '';
  if (!raw) return undefined;
  const words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (const ch of raw) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
    } else if (/\s/.test(ch)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else {
      word = (word ?? '') + ch;
    }
  }
  if (word !== undefined) words.push(word);
  const [command, ...args] = words;
  return command ? { command, args } : undefined;
}

/** Editors that run in the terminal they are started from (lower case, no `.exe`). */
const TERMINAL_EDITORS = new Set([
  'vi', 'vim', 'nvim', 'lvim', 'view', 'ex', 'nvi', 'elvis', 'vis', 'nano', 'pico', 'micro', 'joe', 'jed', 'jove',
  'ne', 'mg', 'zile', 'kak', 'hx', 'helix', 'ed', 'mcedit', 'tilde', 'amp',
]);

/**
 * True when `command args` is an editor that runs in the terminal: one of
 * TERMINAL_EDITORS (but not `vim -g`, which opens gvim), `emacs` with `-nw`,
 * `-t` or `--no-window-system`, or `emacsclient` with `-t`, `-nw` or `--tty`.
 * A GUI editor (`code --wait`, `subl -w`, `gvim -f`, plain `emacs`) is false.
 */
export function isTerminalEditor(command: string, args: readonly string[]): boolean {
  const name = path.basename(command.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  if (TERMINAL_EDITORS.has(name)) return !(/^(vim|nvim|vi|view)$/.test(name) && args.includes('-g'));
  if (name === 'emacs') return args.some((a) => a === '-nw' || a === '-t' || a === '--no-window-system');
  if (name === 'emacsclient') return args.some((a) => a === '-t' || a === '-nw' || a === '--tty');
  return false;
}

/**
 * Open the global (or `--project`) lexicon in the user's editor, then re-parse
 * it. The file is never rewritten by this command: an invalid result is
 * reported with the path so the user can fix it by hand. A missing global
 * file is created empty first so the editor opens a valid skeleton.
 */
export async function runEdit(
  opts: EditOptions,
  io: IO,
  spawnEditor: SpawnEditor = spawnEditorInherit,
  env: NodeJS.ProcessEnv = process.env,
  interactive: () => boolean = isInteractive,
): Promise<number> {
  if (opts.json) return refuse(io, true, 'edit opens an editor and has no --json output', EDIT_NON_INTERACTIVE_NEXT_STEP);
  const cwd = resolveCwd(opts);
  const store = storeOpts(opts, cwd);
  const paths = resolvePaths(store);
  let target: string;
  let scope: TermScope;
  if (opts.project) {
    if (!paths.project) throw new Error(`no project lexicon found for ${cwd} (run: lexicon init --project)`);
    target = paths.project;
    scope = 'project';
  } else {
    target = paths.global;
    scope = 'global';
  }

  const editor = editorCommand(env);
  // Without a terminal on both ends (a pipe, CI, an agent's shell) a
  // terminal editor waits for keys that never come, so the command hung.
  // Checked before anything is created. A GUI editor opens its own window.
  if (editor && isTerminalEditor(editor.command, editor.args) && !interactive()) {
    const variable = env.VISUAL?.trim() ? '$VISUAL' : '$EDITOR';
    return refuse(
      io,
      false,
      `${variable} (${editor.command}) is a terminal editor, and stdin and stdout are not both a terminal, so it would wait for input that never comes`,
      `run lexicon edit in a terminal, set VISUAL to an editor that opens a window and waits (e.g. VISUAL="code --wait"), or edit the file directly: ${target}`,
    );
  }

  // The existence check and the create are one locked step, the way `runInit`
  // does it. Apart, a `lexicon add` landing between them wrote the file this
  // had just decided was missing, and the empty lexicon written here was
  // renamed straight over the new term. A dry run names the file it would
  // create instead.
  await withLexiconLock(target, async () => {
    if (existsSync(target)) return;
    if (opts.dryRun) {
      line(io, `would create ${scope} lexicon: ${safeMessage(target)}`);
      return;
    }
    await writeLexiconFile({ path: target, scope, lexicon: emptyLexicon(), exists: false });
    line(io, `created ${scope} lexicon: ${safeMessage(target)}`);
  });
  const trustedBefore =
    scope === 'project'
      ? (await isTrusted({ path: target, scope, lexicon: emptyLexicon(), exists: true }, store)) === 'trusted'
      : true;

  if (!editor) {
    line(io, `no $VISUAL or $EDITOR set; edit the file directly:`);
    line(io, safeMessage(target));
    // Nothing checks the file afterwards on this path, and a hand edit leaves
    // a project file untrusted (its terms unused) until it is trusted again.
    line(
      io,
      dim(
        scope === 'project'
          ? 'after saving, run: lexicon trust (it shows the terms and trusts the file; until then its terms are not used)'
          : 'after saving, check it with: lexicon doctor',
      ),
    );
    return 0;
  }

  let code: number;
  try {
    code = await spawnEditor(editor.command, editor.args, target);
  } catch (err) {
    // A $VISUAL or $EDITOR that names no program on PATH ended the command
    // with only `spawn <name> ENOENT`: no word on which variable, or where
    // the file is to edit by hand.
    const variable = env.VISUAL?.trim() ? '$VISUAL' : '$EDITOR';
    return refuse(
      io,
      false,
      `could not start the editor ${variable} names (${editor.command}): ${errorMessage(err)}`,
      `set ${variable} to an editor on your PATH (e.g. ${variable === '$VISUAL' ? 'VISUAL' : 'EDITOR'}=vi), or edit the file directly: ${target}`,
    );
  }
  if (code !== 0) {
    // A non-zero exit is how an editor says the edit was abandoned (vim `:cq`,
    // a killed `code --wait`). Re-trusting the file then would bless whatever
    // an earlier `:w` in that session left there, which the user just backed
    // out of, so nothing is checked or re-trusted.
    io.stderr(
      `lexicon: ${safe(editor.command)} exited with code ${code}, so the edit is treated as aborted` +
        `${scope === 'project' && trustedBefore ? ' and the project lexicon was not re-trusted' : ''}\n`,
    );
    if (scope === 'project' && trustedBefore && (await isTrusted({ path: target, scope, lexicon: emptyLexicon(), exists: true }, store)) !== 'trusted') {
      io.stderr(`lexicon: ${safeMessage(target)} changed anyway, so its terms are not used until you review it and run: lexicon trust\n`);
    }
    io.stderr(`lexicon: to edit it again, run: lexicon edit${opts.project ? ' --project' : ''}\n`);
    return 1;
  }

  /** sha256 of the bytes just checked, the edit the user made: what re-trusting pins. */
  let checkedSha: string | undefined;
  try {
    const file = await readLexiconFile(target, scope);
    checkedSha = await parsedContentHash(file);
    line(io, `ok: ${plural(file.lexicon.terms.length, 'term')} in ${safeMessage(target)}`);
  } catch (err) {
    io.stderr(`lexicon: ${safeMessage(errorMessage(err))}\n`);
    io.stderr(`lexicon: your edits are still in ${safeMessage(target)}; fix the file and run: lexicon edit${opts.project ? ' --project' : ''}\n`);
    return 1;
  }

  if (scope === 'project' && !opts.dryRun) {
    if (trustedBefore) {
      // The user just edited it themselves; that is the approval `lexicon trust` records.
      // Only the bytes checked above: a file rewritten since then by
      // someone else keeps its old pin and reads 'changed'.
      await refreshTrust(target, { ...store, ...(checkedSha !== undefined ? { expectedSha256: checkedSha } : {}) });
      if ((await isTrusted({ path: target, scope, lexicon: emptyLexicon(), exists: true }, store)) === 'trusted') {
        line(io, dim(`project lexicon re-trusted (${safeMessage(target)})`));
      } else {
        io.stderr(`lexicon: ${safeMessage(target)} changed again after the edit was checked, so it was not re-trusted; review it and run: lexicon trust\n`);
      }
    } else {
      line(io, dim(`project lexicon is not trusted yet; review it and run: lexicon trust`));
    }
  }
  if (!opts.dryRun) {
    // The editor wrote the file behind writeLexiconFile's back: refresh the
    // cached index the hook reads next, through the same trust check.
    await refreshIndexCache({ scope, path: target }, store);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------------

export function registerReviewCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };
  const done = (code: number): void => {
    if (code !== 0) process.exitCode = code;
  };

  program
    .command('review')
    .description('walk through existing terms and keep, delete or edit each one')
    .option('--never-hit', 'only terms that have never fired (0 hits)')
    .option('--project', 'review the project .lexicon.yaml instead of the global file')
    .option('--global', 'review the global lexicon (the default)')
    .option('--category <category>', 'only this category')
    .option('--json', 'refused (exit 1): review asks about each term; prints { ok: false, error, nextStep } naming list --json, remove and add, and the MCP tools')
    .action(async (opts: ReviewOptions) => done(await runReview({ ...opts, ...globals() }, io)));

  const edit = program
    .command('edit')
    .description('open the global lexicon (or --project) in $VISUAL/$EDITOR and validate it afterwards')
    .option('--project', 'open the project .lexicon.yaml instead of the global file')
    .option('--json', 'refused (exit 1): edit opens an editor; prints { ok: false, error, nextStep } naming add, remove and the MCP tools')
    .action(async (opts: EditOptions) => done(await runEdit({ ...opts, ...globals() }, io)));
  // `lexicon edit Nope` got commander's "Expected 0 arguments but got 1",
  // which did not say that edit opens the whole file, or what changes one term.
  const error = edit.error.bind(edit);
  edit.error = (message, errorOptions) =>
    error(errorOptions?.code === 'commander.excessArguments' ? EDIT_TAKES_NO_TERM : message, errorOptions);
}

/** The usage error of `lexicon edit <anything>`. */
const EDIT_TAKES_NO_TERM =
  'error: lexicon edit takes no term: it opens the whole lexicon file in $VISUAL/$EDITOR. To change one term: lexicon add <canonical> <alias...>, or lexicon remove <term>';
