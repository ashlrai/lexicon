/**
 * Interactive CLI workflows: the `harvest --interactive` walkthrough,
 * `lexicon review` (walk existing terms and keep/delete/edit them) and
 * `lexicon edit` (open a lexicon file in $VISUAL/$EDITOR and validate it
 * afterwards). Handlers take a Prompter so tests can script the answers;
 * registerReviewCommands() only wires commander.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
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
  readLexiconFile,
  readHitsFor,
  withLexiconLock,
  refreshIndexCache,
  refreshTrust,
  resolvePaths,
  writeLexiconFile,
} from '../core/index.js';
import type { HarvestCandidate, Lexicon, LexiconFile, Term, TermCategory, TermScope } from '../core/index.js';
import { PromptClosedError, askKey, createPrompter, isInteractive, splitList } from './prompt.js';
import type { Prompter } from './prompt.js';
import { errorMessage } from '../util/errors.js';
import { CliRefusal, bold, dim, line, parseCategory, plural, refuse, resolveCwd, safe, safeLines } from './io.js';
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
      io.stderr(`lexicon: ${safeLines(new ProjectTrustError(projectPath, status).message)}\n`);
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

  const toTerm = (c: HarvestCandidate): Term => ({ canonical: c.canonical, aliases: c.suggestedAliases, category: c.category, source: c.source });
  const report = (result: { term: Term; created: boolean }): void => {
    if (result.created) created += 1;
    else merged += 1;
    line(io, `  ${result.created ? 'added' : 'merged'} ${bold(safe(result.term.canonical))}`);
  };
  /** False after printing a ProjectTrustError (nothing in the call was written); any other error is thrown. */
  const refused = (err: unknown): false => {
    if (err instanceof ProjectTrustError) {
      io.stderr(`lexicon: ${safeLines(err.message)}\n`);
      return false;
    }
    throw err;
  };

  const add = async (c: HarvestCandidate): Promise<boolean> => {
    try {
      const result = await addTerm(toTerm(c), { ...store, scope: 'project' });
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
      const batch = await addTerms(work.slice(from).map(toTerm), { ...store, scope: 'project' });
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
    for (let i = 0; i < work.length && !quit && !addAll; i += 1) {
      current = i;
      const c = work[i];
      showCandidate(io, c, i, work.length);
      let decided = false;
      while (!decided) {
        const key = await askKey(prompter, `  add? ${dim('[y/n/e/c/a/q]')}`, HARVEST_KEYS, 'y', keyHelp(io, HARVEST_HELP, 'y'));
        switch (key) {
          case 'y':
            if (!(await add(c))) return 1;
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
            if (!(await addRest(i))) return 1;
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

  const where = filePath ? ` in ${safe(filePath)}` : '';
  line(io, `added ${plural(created, 'new term')}, merged ${merged}, skipped ${skipped}${where}`);
  if (filePath) line(io, dim(`project lexicon trusted (${safe(filePath)})`));
  // One way on, and only when there is something new to look at.
  if (created + merged > 0) line(io, dim(NEXT_LIST));
  return 0;
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

function termKey(t: Term): string {
  return t.canonical.trim().toLowerCase();
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
      io.stderr(`lexicon: ${safeLines(new ProjectTrustError(file.path, status).message)}\n`);
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
  const subject = file.lexicon.terms.filter(
    (t) => (!opts.neverHit || effectiveHits(t, hits) === 0) && (category === undefined || t.category === category),
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
  const notReviewed = subject.length - stoppedAt;

  let mergedElsewhere = 0;
  if (changed) {
    // The lock goes here and not around the session. A review is interactive
    // and can sit open for minutes, so holding the file for its duration would
    // block every other writer on a human reading terms; that is what
    // `reconcileReview` exists for instead. What must be atomic is the last
    // few milliseconds: the digest check, the re-read it decides on, the merge
    // and the write. Without the lock a writer landing between the re-read and
    // the write is merged against a copy that is already stale, and the write
    // renames it away while reporting the merge succeeded.
    await withLexiconLock(file.path, async () => {
      if (digestAtStart !== undefined && (await fileDigest(file.path)) !== digestAtStart) {
        try {
          const disk = await readLexiconFile(file.path, file.scope);
          const merged = reconcileReview(file.lexicon.terms, snapshot, disk.lexicon.terms, editedTerms, deleted);
          // The session never touches settings, so the on-disk ones win too.
          file.lexicon = { ...disk.lexicon, terms: merged.terms };
          mergedElsewhere = merged.changes;
        } catch (err) {
          io.stderr(
            `lexicon: ${safe(file.path)} changed during review but could not be re-read (${safeLines(errorMessage(err))}); writing the reviewed version\n`,
          );
          file.lexicon.terms = file.lexicon.terms.filter((t) => !deleted.has(t));
        }
      } else {
        file.lexicon.terms = file.lexicon.terms.filter((t) => !deleted.has(t));
      }
      await writeLexiconFile(file);
    });
    // The user's own edit must not flip a trusted project file to 'changed'.
    // Then the cached matcher index the hook reads next (a no-op where there
    // is none); writeLexiconFile already refreshed it for a global file.
    if (file.scope === 'project') {
      await refreshTrust(file.path, store);
      await refreshIndexCache(file, store);
    }
  }
  if (inputClosed) line(io, `input closed at term ${stoppedAt + 1} of ${subject.length}; keeping the answers given before it`);
  if (mergedElsewhere > 0) line(io, `merged ${plural(mergedElsewhere, 'change')} made elsewhere during review`);
  // A quit used to report only the terms answered, so "kept 1, removed 0"
  // after `q` on term 2 of 40 said nothing of the other 39.
  const rest = notReviewed > 0 ? `, ${notReviewed} not reviewed (left as they were)` : '';
  line(io, `kept ${kept}, removed ${deleted.size}, edited ${edited}${rest}${changed ? `. Wrote ${safe(file.path)}` : ' (nothing written)'}`);
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
}

/** Runs `command args... filePath` attached to the terminal and resolves with its exit code. */
export type SpawnEditor = (command: string, args: readonly string[], filePath: string) => Promise<number>;

export const spawnEditorInherit: SpawnEditor = (command, args, filePath) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(command, [...args, filePath], { stdio: 'inherit' });
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

  // The existence check and the create are one locked step, the way `runInit`
  // does it. Apart, a `lexicon add` landing between them wrote the file this
  // had just decided was missing, and the empty lexicon written here was
  // renamed straight over the new term.
  await withLexiconLock(target, async () => {
    if (existsSync(target)) return;
    await writeLexiconFile({ path: target, scope, lexicon: emptyLexicon(), exists: false });
    line(io, `created ${scope} lexicon: ${safe(target)}`);
  });
  const trustedBefore =
    scope === 'project'
      ? (await isTrusted({ path: target, scope, lexicon: emptyLexicon(), exists: true }, store)) === 'trusted'
      : true;

  const editor = editorCommand(env);
  if (!editor) {
    line(io, `no $VISUAL or $EDITOR set; edit the file directly:`);
    line(io, safe(target));
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
  if (code !== 0) io.stderr(`lexicon: ${editor.command} exited with code ${code}; checking the file anyway\n`);

  try {
    const file = await readLexiconFile(target, scope);
    line(io, `ok: ${plural(file.lexicon.terms.length, 'term')} in ${safe(target)}`);
  } catch (err) {
    io.stderr(`lexicon: ${safeLines(errorMessage(err))}\n`);
    io.stderr(`lexicon: your edits are still in ${safe(target)}; fix the file and run: lexicon edit${opts.project ? ' --project' : ''}\n`);
    return 1;
  }

  if (scope === 'project') {
    if (trustedBefore) {
      // The user just edited it themselves; that is the approval `lexicon trust` records.
      await refreshTrust(target, store);
      line(io, dim(`project lexicon re-trusted (${safe(target)})`));
    } else {
      line(io, dim(`project lexicon is not trusted yet; review it and run: lexicon trust`));
    }
  }
  // The editor wrote the file behind writeLexiconFile's back: refresh the
  // cached index the hook reads next, through the same trust check.
  await refreshIndexCache({ scope, path: target }, store);
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
