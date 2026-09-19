/**
 * Interactive CLI workflows: the `harvest --interactive` walkthrough,
 * `lexicon review` (walk existing terms and keep/delete/edit them) and
 * `lexicon edit` (open a lexicon file in $VISUAL/$EDITOR and validate it
 * afterwards). Handlers take a Prompter so tests can script the answers;
 * registerReviewCommands() only wires commander.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import {
  ProjectTrustError,
  addTerm,
  emptyLexicon,
  isTrusted,
  readLexiconFile,
  refreshTrust,
  resolvePaths,
  writeLexiconFile,
} from '../core/index.js';
import type { HarvestCandidate, LexiconFile, Term, TermCategory, TermScope } from '../core/index.js';
import type { CommonOptions, IO } from './commands.js';
import { askKey, createPrompter, isInteractive, splitList, styler } from './prompt.js';
import type { Prompter } from './prompt.js';

const CATEGORIES: readonly TermCategory[] = [
  'brand',
  'person',
  'product',
  'acronym',
  'identifier',
  'place',
  'other',
];

const { bold, dim } = styler(process.stdout);

function line(io: IO, s = ''): void {
  io.stdout(`${s}\n`);
}

function resolveCwd(opts: CommonOptions): string {
  return path.resolve(opts.cwd ?? process.cwd());
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function isCategory(value: string): value is TermCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** Ask for a category until a valid one (or the default) is given. */
async function askCategory(prompter: Prompter, def: TermCategory): Promise<TermCategory> {
  for (;;) {
    const answer = (await prompter.ask(`category (${CATEGORIES.join('|')})`, { default: def })).trim().toLowerCase();
    if (isCategory(answer)) return answer;
    // Re-ask; the prompter shows the list in the question.
  }
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

export type HarvestInteractiveOptions = InteractiveOptions;

const HARVEST_KEYS = ['y', 'n', 'e', 'c', 'a', 'q'] as const;
const HARVEST_HELP = '[y]es  [n]o  [e]dit aliases  [c]ategory  [a]ll remaining  [q]uit';

function showCandidate(io: IO, c: HarvestCandidate, index: number, total: number): void {
  line(io, `${dim(`[${index + 1}/${total}]`)} ${bold(c.canonical)}  ${dim(`${c.category}, seen ${c.count}x`)}`);
  line(io, `  evidence: ${c.evidence.length > 0 ? c.evidence.slice(0, 3).join(', ') : dim('(none)')}`);
  line(io, `  aliases:  ${c.suggestedAliases.length > 0 ? c.suggestedAliases.join(', ') : dim('(none)')}`);
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
    line(io, dim('no candidates to review'));
    return 0;
  }

  // Check the trust gate up front so the user is not asked twenty questions
  // only to have the first write refused.
  const projectPath = resolvePaths(store).project;
  if (projectPath && existsSync(projectPath)) {
    const status = await isTrusted({ path: projectPath, scope: 'project', lexicon: emptyLexicon(), exists: true }, store);
    if (status !== 'trusted') {
      io.stderr(`lexicon: ${new ProjectTrustError(projectPath, status).message}\n`);
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

  const add = async (c: HarvestCandidate): Promise<boolean> => {
    const term: Term = { canonical: c.canonical, aliases: c.suggestedAliases, category: c.category, source: c.source };
    try {
      const result = await addTerm(term, { ...store, scope: 'project' });
      filePath = result.file.path;
      if (result.created) created += 1;
      else merged += 1;
      line(io, `  ${result.created ? 'added' : 'merged'} ${bold(result.term.canonical)}`);
      return true;
    } catch (err) {
      if (err instanceof ProjectTrustError) {
        io.stderr(`lexicon: ${err.message}\n`);
        return false;
      }
      throw err;
    }
  };

  for (let i = 0; i < work.length && !quit; i += 1) {
    const c = work[i];
    if (addAll) {
      if (!(await add(c))) return 1;
      continue;
    }
    showCandidate(io, c, i, work.length);
    let decided = false;
    while (!decided) {
      const key = await askKey(prompter, `  add? ${dim('[y/n/e/c/a/q]')}`, HARVEST_KEYS, 'y');
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
          line(io, `  aliases:  ${c.suggestedAliases.length > 0 ? c.suggestedAliases.join(', ') : dim('(none)')}`);
          break;
        }
        case 'c':
          c.category = await askCategory(prompter, c.category);
          line(io, `  category: ${c.category}`);
          break;
        case 'a':
          addAll = true;
          if (!(await add(c))) return 1;
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

  const where = filePath ? ` in ${filePath}` : '';
  line(io, `added ${plural(created, 'new term')}, merged ${merged}, skipped ${skipped}${where}`);
  if (filePath) line(io, dim(`project lexicon trusted (${filePath})`));
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
}

const REVIEW_KEYS = ['k', 'd', 'e', 'p', 'n', 'q'] as const;
const REVIEW_HELP = '[k]eep  [d]elete  [e]dit aliases  [p]honetic  [n]otes  [q]uit';

function showTerm(io: IO, t: Term, index: number, total: number): void {
  const meta = [t.category ?? 'uncategorized', `${t.hits ?? 0} hit${(t.hits ?? 0) === 1 ? '' : 's'}`];
  if (t.source) meta.push(t.source);
  line(io, `${dim(`[${index + 1}/${total}]`)} ${bold(t.canonical)}  ${dim(meta.join(', '))}`);
  line(io, `  aliases:  ${t.aliases.length > 0 ? t.aliases.join(', ') : dim('(none)')}`);
  if (t.phonetic) line(io, `  phonetic: ${t.phonetic}`);
  if (t.notes) line(io, `  notes:    ${t.notes}`);
}

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
    if (!paths.project) throw new Error(`no project lexicon found for ${cwd} (run: lexicon init --project)`);
    return readLexiconFile(paths.project, 'project');
  }
  return readLexiconFile(paths.global, 'global');
}

export async function runReview(opts: ReviewOptions, io: IO, prompter?: Prompter): Promise<number> {
  const cwd = resolveCwd(opts);
  const store = storeOpts(opts, cwd);
  if (!prompter && !isInteractive()) {
    throw new Error('review needs a terminal (stdin and stdout must be a TTY); use `lexicon list` to print terms instead');
  }
  const category = opts.category?.toLowerCase();
  if (category !== undefined && !isCategory(category)) {
    throw new Error(`unknown category "${opts.category}" (expected one of: ${CATEGORIES.join(', ')})`);
  }

  const file = await pickFile(opts, cwd);
  if (!file.exists) {
    line(io, dim(`no ${file.scope} lexicon at ${file.path}`));
    return 0;
  }
  if (file.scope === 'project') {
    const status = await isTrusted(file, store);
    if (status !== 'trusted') {
      io.stderr(`lexicon: ${new ProjectTrustError(file.path, status).message}\n`);
      return 1;
    }
  }

  const subject = file.lexicon.terms.filter(
    (t) => (!opts.neverHit || (t.hits ?? 0) === 0) && (category === undefined || t.category === category),
  );
  if (subject.length === 0) {
    line(io, dim(`no terms to review in ${file.path}`));
    return 0;
  }

  const own = prompter === undefined;
  const p = prompter ?? createPrompter({ input: process.stdin, output: process.stdout });
  const deleted = new Set<Term>();
  let edited = 0;
  let kept = 0;
  let changed = false;

  try {
    line(io, `${bold(`${plural(subject.length, 'term')} in ${file.path}`)} ${dim(REVIEW_HELP)}`);
    line(io);
    for (let i = 0; i < subject.length; i += 1) {
      const t = subject[i];
      showTerm(io, t, i, subject.length);
      let decided = false;
      let quit = false;
      while (!decided) {
        const key = await askKey(p, `  ${dim('[k/d/e/p/n/q]')}`, REVIEW_KEYS, 'k');
        switch (key) {
          case 'k':
            kept += 1;
            decided = true;
            break;
          case 'd':
            deleted.add(t);
            changed = true;
            line(io, `  deleted ${bold(t.canonical)}`);
            decided = true;
            break;
          case 'e': {
            const answer = await p.ask('  aliases (comma-separated)', { default: t.aliases.join(', ') });
            const next = splitList(answer).filter((a) => a.toLowerCase() !== t.canonical.toLowerCase());
            if (next.join(' ') !== t.aliases.join(' ')) {
              t.aliases = next;
              changed = true;
              edited += 1;
            }
            line(io, `  aliases:  ${t.aliases.length > 0 ? t.aliases.join(', ') : dim('(none)')}`);
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
            }
            line(io, `  phonetic: ${t.phonetic ?? dim('(none)')}`);
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
            }
            line(io, `  notes:    ${t.notes ?? dim('(none)')}`);
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
    }
  } finally {
    if (own) p.close();
  }

  if (changed) {
    file.lexicon.terms = file.lexicon.terms.filter((t) => !deleted.has(t));
    await writeLexiconFile(file);
    // The user's own edit must not flip a trusted project file to 'changed'.
    if (file.scope === 'project') await refreshTrust(file.path, store);
  }
  line(io, `kept ${kept}, deleted ${deleted.size}, edited ${edited}${changed ? ` — wrote ${file.path}` : ' (nothing written)'}`);
  return 0;
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

export interface EditOptions extends InteractiveOptions {
  /** Open the project .lexicon.yaml instead of the global file. */
  project?: boolean;
}

/** Runs `command args... filePath` attached to the terminal and resolves with its exit code. */
export type SpawnEditor = (command: string, args: readonly string[], filePath: string) => Promise<number>;

export const spawnEditorInherit: SpawnEditor = (command, args, filePath) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(command, [...args, filePath], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

/** `$VISUAL` then `$EDITOR`, split on whitespace so `code --wait` works. */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } | undefined {
  const raw = (env.VISUAL?.trim() || env.EDITOR?.trim()) ?? '';
  if (!raw) return undefined;
  const [command, ...args] = raw.split(/\s+/);
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

  if (!existsSync(target)) {
    await writeLexiconFile({ path: target, scope, lexicon: emptyLexicon(), exists: false });
    line(io, `created ${scope} lexicon: ${target}`);
  }
  const trustedBefore =
    scope === 'project'
      ? (await isTrusted({ path: target, scope, lexicon: emptyLexicon(), exists: true }, store)) === 'trusted'
      : true;

  const editor = editorCommand(env);
  if (!editor) {
    line(io, `no $VISUAL or $EDITOR set; edit the file directly:`);
    line(io, target);
    return 0;
  }

  const code = await spawnEditor(editor.command, editor.args, target);
  if (code !== 0) io.stderr(`lexicon: ${editor.command} exited with code ${code}; checking the file anyway\n`);

  try {
    const file = await readLexiconFile(target, scope);
    line(io, `ok: ${plural(file.lexicon.terms.length, 'term')} in ${target}`);
  } catch (err) {
    io.stderr(`lexicon: ${errorMessage(err)}\n`);
    io.stderr(`lexicon: your edits are still in ${target}; fix the file and run: lexicon edit${opts.project ? ' --project' : ''}\n`);
    return 1;
  }

  if (scope === 'project') {
    if (trustedBefore) {
      // The user just edited it themselves; that is the approval `lexicon trust` records.
      await refreshTrust(target, store);
      line(io, dim(`project lexicon re-trusted (${target})`));
    } else {
      line(io, dim(`project lexicon is not trusted yet; review it and run: lexicon trust`));
    }
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
    .action(async (opts: ReviewOptions) => done(await runReview({ ...opts, ...globals() }, io)));

  program
    .command('edit')
    .description('open the global lexicon (or --project) in $VISUAL/$EDITOR and validate it afterwards')
    .option('--project', 'open the project .lexicon.yaml instead of the global file')
    .action(async (opts: EditOptions) => done(await runEdit({ ...opts, ...globals() }, io)));
}
