/**
 * `lexicon trust [path]`, `lexicon untrust [path]`, `lexicon trust --list`.
 *
 * A project `.lexicon.yaml` is only merged once the user has looked at it and
 * run `lexicon trust` (see SECURITY.md). Trust pins the file's sha256, so a
 * changed file drops back to 'changed' until trusted again.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import {
  getTrustPath,
  isTrusted,
  listTrusted,
  readLexiconFile,
  resolvePaths,
  trustAllEnabled,
  trustProject,
  untrustProject,
} from '../core/index.js';
import type { LexiconFile, Term } from '../core/index.js';
import { renderTable, safe, safeLines } from './commands.js';
import type { CommonOptions, IO } from './commands.js';

export interface TrustOptions extends CommonOptions {
  list?: boolean;
}

/** Max terms shown in the preview before "... and N more". */
const PREVIEW_ROWS = 25;

function resolveCwd(opts: CommonOptions): string {
  return path.resolve(opts.cwd ?? process.cwd());
}

/** Explicit path (relative to cwd) or the project file resolved for cwd. */
function resolveTarget(target: string | undefined, cwd: string): string | undefined {
  if (target) return path.resolve(cwd, target);
  return resolvePaths({ cwd }).project;
}

/** First alias plus a count, e.g. `Ashler (+3)`; renderTable sanitizes the cell so the table stays one row per term. */
function previewAliases(term: Term): string {
  if (term.aliases.length === 0) return '';
  const first = term.aliases[0];
  const more = term.aliases.length - 1;
  return more > 0 ? `${first} (+${more})` : first;
}

function renderPreview(file: LexiconFile, io: IO): void {
  const terms = file.lexicon.terms;
  io.stdout(`${safe(file.path)}: ${terms.length} term${terms.length === 1 ? '' : 's'}\n`);
  if (terms.length === 0) return;
  const rows = terms.slice(0, PREVIEW_ROWS).map((t) => [t.canonical, previewAliases(t), t.notes ? 'has notes' : '']);
  io.stdout(renderTable(rows, ['canonical', 'first alias', '']));
  if (terms.length > PREVIEW_ROWS) io.stdout(`... and ${terms.length - PREVIEW_ROWS} more\n`);
}

export async function runTrust(target: string | undefined, opts: TrustOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  if (opts.list) return runTrustList(cwd, io);

  const filePath = resolveTarget(target, cwd);
  if (!filePath) {
    io.stderr(`lexicon: no project .lexicon.yaml found from ${safe(cwd)} (pass a path, or run: lexicon init --project)\n`);
    return 1;
  }
  if (!existsSync(filePath)) {
    io.stderr(`lexicon: file does not exist: ${safe(filePath)}\n`);
    return 1;
  }

  // Parse first so a broken file is reported instead of trusted blind.
  let file: LexiconFile;
  try {
    file = await readLexiconFile(filePath, 'project');
  } catch (err) {
    io.stderr(`lexicon: refusing to trust an invalid lexicon: ${safeLines(err instanceof Error ? err.message : String(err))}\n`);
    return 1;
  }

  const before = await isTrusted(file, { cwd });
  renderPreview(file, io);
  const entry = await trustProject(filePath, { cwd });
  const verb = before === 'trusted' ? 're-pinned' : before === 'changed' ? 'updated' : 'trusted';
  io.stdout(`${verb} ${safe(filePath)} (sha256 ${entry.sha256.slice(0, 12)}) in ${safe(getTrustPath({ cwd }))}\n`);
  io.stdout('It will be merged into the lexicon until its content changes; then run `lexicon trust` again.\n');
  return 0;
}

export async function runUntrust(target: string | undefined, opts: CommonOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  const filePath = resolveTarget(target, cwd);
  if (!filePath) {
    io.stderr(`lexicon: no project .lexicon.yaml found from ${safe(cwd)} (pass a path)\n`);
    return 1;
  }
  const removed = await untrustProject(filePath, { cwd });
  if (!removed) {
    io.stdout(`${safe(filePath)} was not trusted; nothing to do\n`);
    return 0;
  }
  io.stdout(`untrusted ${safe(filePath)}; it will no longer be merged\n`);
  return 0;
}

async function runTrustList(cwd: string, io: IO): Promise<number> {
  const entries = await listTrusted({ cwd });
  io.stdout(`registry: ${safe(getTrustPath({ cwd }))}\n`);
  if (trustAllEnabled()) io.stdout('LEXICON_TRUST_ALL is set: every project lexicon is treated as trusted\n');
  if (entries.length === 0) {
    io.stdout('no trusted project lexicons (run: lexicon trust)\n');
    return 0;
  }
  const rows = entries.map((e) => [e.path, e.status, e.trustedAt]);
  io.stdout(renderTable(rows, ['path', 'status', 'trusted at']));
  return 0;
}

export function registerTrustCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };
  const done = (code: number): void => {
    if (code !== 0) process.exitCode = code;
  };

  program
    .command('trust')
    .description('approve a project .lexicon.yaml so its terms are merged (shows a preview first)')
    .argument('[path]', 'lexicon file (default: the project .lexicon.yaml for the current directory)')
    .option('--list', 'list trusted project lexicons and whether they still match')
    .action(async (target: string | undefined, opts: { list?: boolean }) =>
      done(await runTrust(target, { ...opts, ...globals() }, io)),
    );

  program
    .command('untrust')
    .description('revoke approval for a project .lexicon.yaml')
    .argument('[path]', 'lexicon file (default: the project .lexicon.yaml for the current directory)')
    .action(async (target: string | undefined) => done(await runUntrust(target, globals(), io)));
}
