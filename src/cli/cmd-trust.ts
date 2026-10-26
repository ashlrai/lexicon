/**
 * `lexicon trust [path]`, `lexicon untrust [path]`, `lexicon trust --list`.
 *
 * A project `.lexicon.yaml` is only merged once the user has looked at it and
 * run `lexicon trust` (see SECURITY.md). Trust pins the file's sha256, so a
 * changed file drops back to 'changed' until trusted again.
 *
 * On a terminal `lexicon trust` asks before it pins the file (default no);
 * `--yes` skips the question. Off a terminal (a script, CI, an agent's shell)
 * there is nobody to ask, so it refuses after printing the preview, pins
 * nothing and exits 1 unless `--yes` was passed: approving a file must be an
 * explicit act, never the side effect of a missing TTY. There is no
 * environment-variable bypass. With `--yes` it prints the path and the sha256
 * it pinned.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  PROJECT_FILE_NAME,
  getTrustPath,
  hashFile,
  isTrusted,
  listTrusted,
  readLexiconFile,
  resolvePaths,
  trustAllEnabled,
  trustPreview,
  trustProject,
  untrustProject,
  isTrustContentChangedError,
  isTrustRegistryUnreadableError,
  parsedContentHash,
  trustRegistryProblem,
} from '../core/index.js';
import type { LexiconFile, Term } from '../core/index.js';
import { jsonError, jsonOk, line, renderTable, resolveCwd, safeMessage, safePath, unreadableLexiconHint } from './io.js';
import type { CommonOptions, IO } from './io.js';
import { PromptClosedError, createPrompter, isInteractive } from './prompt.js';
import type { Prompter } from './prompt.js';

export interface TrustOptions extends CommonOptions {
  list?: boolean;
  /** Print the result as JSON (the shape MCP `trust_project` returns, with the full `trustPreview` in place of its summary). */
  json?: boolean;
  /** Trust without asking, even on a terminal. */
  yes?: boolean;
}

/** Test seams for the confirmation step. */
export interface TrustDeps {
  /** Default: stdin and stdout are both terminals. */
  isInteractive?: () => boolean;
  /** Default: a readline prompter on stdin, writing to stdout (stderr under --json). */
  createPrompter?: () => Prompter;
}

/** Max terms shown in the preview before "... and N more". */
const PREVIEW_ROWS = 25;

/** Explicit path (relative to cwd) or the project file resolved for cwd. A directory means the `.lexicon.yaml` inside it. */
function resolveTarget(target: string | undefined, cwd: string): string | undefined {
  if (!target) return resolvePaths({ cwd }).project;
  const resolved = path.resolve(cwd, target);
  try {
    if (statSync(resolved).isDirectory()) return path.join(resolved, PROJECT_FILE_NAME);
  } catch {
    // Missing path: fall through so the caller reports it.
  }
  return resolved;
}

/** First alias plus a count, e.g. `Ashler (+3)`; renderTable sanitizes the cell so the table stays one row per term. */
function previewAliases(term: Term): string {
  if (term.aliases.length === 0) return '';
  const first = term.aliases[0];
  const more = term.aliases.length - 1;
  return more > 0 ? `${first} (+${more})` : first;
}

function renderPreview(file: LexiconFile, write: (s: string) => void): void {
  const terms = file.lexicon.terms;
  write(`${safePath(file.path)}: ${terms.length} term${terms.length === 1 ? '' : 's'}\n`);
  if (terms.length === 0) return;
  const rows = terms.slice(0, PREVIEW_ROWS).map((t) => [t.canonical, previewAliases(t), t.notes ? 'has notes' : '']);
  write(renderTable(rows, ['canonical', 'first alias', '']));
  if (terms.length > PREVIEW_ROWS) write(`... and ${terms.length - PREVIEW_ROWS} more\n`);
}

function printJson(io: IO, payload: unknown): void {
  line(io, JSON.stringify(payload, null, 2));
}

/**
 * A refusal: the stderr line(s) as always, and under --json one
 * `{ ok: false, error, nextStep?, action, path? }` document on stdout too, so
 * a script that parses stdout is not left with nothing, and reads `ok` as it
 * does on every other command. Always exit code 1. The lines go through
 * `safeMessage` and every path this command prints through `safePath`: the
 * 200-character display cap cut a deep path off, so the file being trusted
 * (or the one an error names) could not be read whole.
 */
function fail(
  io: IO,
  json: boolean | undefined,
  action: 'trust' | 'untrust',
  filePath: string | undefined,
  error: string,
  nextStep?: string,
): number {
  if (json) printJson(io, { ...jsonError(error, nextStep), action, ...(filePath !== undefined ? { path: filePath } : {}) });
  io.stderr(`lexicon: ${safeMessage(error)}\n`);
  if (nextStep) io.stderr(`lexicon: ${safeMessage(nextStep)}\n`);
  return 1;
}

/** A `TrustRegistryUnreadableError`: the registry file is named whole and was not touched. */
function registryFail(io: IO, json: boolean | undefined, action: 'trust' | 'untrust', filePath: string, err: unknown): number {
  const { path: registryPath, problem } = err as { path: string; problem: string };
  return fail(
    io,
    json,
    action,
    filePath,
    `the trust registry at ${registryPath} ${problem}; it was left as it is and nothing was ${action === 'trust' ? 'trusted' : 'untrusted'}`,
    `fix the JSON in ${registryPath}, or move it aside (every project then reads as untrusted until you run \`lexicon trust\` in it again), and retry`,
  );
}

/**
 * Ask the person at the terminal whether to trust the file just previewed.
 * Default no; a closed input (EOF, ctrl-D) is a no. Under --json the question
 * goes to stderr so stdout stays one JSON document.
 */
async function confirmTrust(filePath: string, opts: TrustOptions, deps: TrustDeps): Promise<boolean> {
  const own = deps.createPrompter === undefined;
  const p = deps.createPrompter?.() ?? createPrompter({ input: process.stdin, output: opts.json ? process.stderr : process.stdout });
  try {
    return await p.confirm(`trust ${safePath(filePath)}? its terms will be applied to every prompt in this repo`, false);
  } catch (err) {
    if (err instanceof PromptClosedError) return false;
    throw err;
  } finally {
    if (own) p.close();
  }
}

export async function runTrust(target: string | undefined, opts: TrustOptions, io: IO, deps: TrustDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  if (opts.list) return runTrustList(cwd, opts, io);

  const filePath = resolveTarget(target, cwd);
  if (!filePath) {
    return fail(io, opts.json, 'trust', undefined, `no project .lexicon.yaml found from ${cwd}`, 'pass a path, or run: lexicon init --project');
  }
  if (!existsSync(filePath)) {
    return fail(io, opts.json, 'trust', filePath, `file does not exist: ${filePath}`, 'pass the path of an existing .lexicon.yaml, or run: lexicon init --project');
  }

  // Parse so a broken file is reported instead of trusted blind; the bytes
  // that parse read are the ones the preview shows and the only ones that
  // may be pinned (as MCP trust_project does).
  let file: LexiconFile;
  try {
    file = await readLexiconFile(filePath, 'project');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The skipped-project warning on every other command says `run: lexicon
    // trust`, so this is where a user with a broken file lands: name the fix.
    return fail(io, opts.json, 'trust', filePath, `refusing to trust an invalid lexicon: ${message}`, unreadableLexiconHint(message));
  }

  const registry = getTrustPath({ cwd });
  // A broken registry is refused by trustProject anyway; say so before the
  // preview and the question, not after the person has answered yes.
  const registryProblem = await trustRegistryProblem({ cwd });
  if (registryProblem !== undefined) {
    return registryFail(io, opts.json, 'trust', filePath, { path: registry, problem: registryProblem });
  }
  const shownSha = (await parsedContentHash(file)) ?? (await hashFile(filePath));
  const before = await isTrusted(file, { cwd });
  // The table is for the person deciding; under --json it goes to stderr, and
  // only when there is a question to answer, so stdout stays one document.
  // A file that already reads trusted gains nothing from a yes (MCP
  // trust_project does not ask either), and a no would print "declined" for
  // a file that stays trusted.
  const interactive = (deps.isInteractive ?? isInteractive)();
  const ask = !opts.yes && before !== 'trusted' && interactive;
  if (!opts.json) renderPreview(file, io.stdout);
  else if (ask) renderPreview(file, io.stderr);
  // Off a terminal nobody can answer the question, so only an explicit --yes
  // pins the file. No environment variable stands in for the flag.
  if (!opts.yes && before !== 'trusted' && !interactive) {
    return fail(
      io,
      opts.json,
      'trust',
      filePath,
      `no terminal to confirm trusting ${filePath}; nothing was trusted`,
      `review the preview, then run: lexicon trust ${JSON.stringify(filePath)} --yes`,
    );
  }
  if (ask && !(await confirmTrust(filePath, opts, deps))) {
    if (opts.json) {
      // Exit 0 (a no is an answer, not a failure), so ok is true as on every exit-0 document.
      printJson(io, jsonOk({ action: 'trust', path: filePath, status: before, result: 'declined', summary: 'the user did not approve; nothing was trusted' }));
    } else {
      line(io, 'declined; nothing was trusted.');
    }
    return 0;
  }
  // The answer covers the file that was previewed, not whatever is on disk after the question.
  if (ask && (shownSha === undefined || (await hashFile(filePath)) !== shownSha)) {
    return fail(io, opts.json, 'trust', filePath, `${filePath} changed while waiting for confirmation; nothing was trusted`, 'review it and run: lexicon trust');
  }
  let entry: Awaited<ReturnType<typeof trustProject>>;
  try {
    entry = await trustProject(filePath, { cwd, ...(shownSha !== undefined ? { expectedSha256: shownSha } : {}) });
  } catch (err) {
    if (isTrustRegistryUnreadableError(err)) return registryFail(io, opts.json, 'trust', filePath, err);
    if (!isTrustContentChangedError(err)) throw err;
    return fail(io, opts.json, 'trust', filePath, `${filePath} changed while it was being trusted; nothing was trusted`, 'review it and run: lexicon trust');
  }
  // Asked or not (--yes, off a terminal), only the bytes that were parsed and
  // previewed above may be pinned: trustProject hashes the file again, and a
  // file swapped in meanwhile (even one that does not parse) would otherwise
  // be trusted unseen.
  if (entry.sha256 !== shownSha) {
    await untrustProject(filePath, { cwd });
    return fail(io, opts.json, 'trust', filePath, `${filePath} changed while it was being trusted; trust was revoked`, 'review it and run: lexicon trust');
  }
  // `already-trusted` when the registry already pinned these bytes and nothing was written.
  const verb = entry.alreadyPinned ? 'already-trusted' : before === 'trusted' ? 're-pinned' : before === 'changed' ? 'updated' : 'trusted';
  if (opts.json) {
    // `ok: true`, then the object MCP trust_project returns for action 'trust',
    // with the full preview (trustPreview) where MCP hands the model a summary.
    printJson(io, jsonOk({
      action: 'trust',
      path: filePath,
      previousStatus: before,
      status: 'trusted',
      result: verb,
      sha256: entry.sha256.slice(0, 12),
      trustedAt: entry.trustedAt,
      registry,
      ...trustPreview(file),
      note: 'Merged into the lexicon until its content changes; then it must be trusted again.',
    }));
    return 0;
  }
  if (entry.alreadyPinned) {
    io.stdout(`already trusted: ${safePath(filePath)} (sha256 ${entry.sha256.slice(0, 12)}, since ${entry.trustedAt}) in ${safePath(registry)}; nothing changed\n`);
  } else {
    io.stdout(`${verb} ${safePath(filePath)} (sha256 ${entry.sha256.slice(0, 12)}) in ${safePath(registry)}\n`);
  }
  io.stdout('It will be merged into the lexicon until its content changes; then run `lexicon trust` again.\n');
  return 0;
}

export async function runUntrust(target: string | undefined, opts: CommonOptions & { json?: boolean }, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  const filePath = resolveTarget(target, cwd);
  if (!filePath) return fail(io, opts.json, 'untrust', undefined, `no project .lexicon.yaml found from ${cwd}`, 'pass the path of the .lexicon.yaml to untrust (lexicon trust --list shows the trusted ones)');
  let removed: boolean;
  try {
    removed = await untrustProject(filePath, { cwd });
  } catch (err) {
    if (isTrustRegistryUnreadableError(err)) return registryFail(io, opts.json, 'untrust', filePath, err);
    throw err;
  }
  if (opts.json) {
    // `ok: true`, then the object MCP trust_project returns for action 'untrust'.
    printJson(io, jsonOk({
      action: 'untrust',
      path: filePath,
      removed,
      registry: getTrustPath({ cwd }),
      summary: removed ? `untrusted ${filePath}; it will no longer be merged` : `${filePath} was not trusted; nothing to do`,
    }));
    return 0;
  }
  if (!removed) {
    io.stdout(`${safePath(filePath)} was not trusted; nothing to do\n`);
    return 0;
  }
  io.stdout(`untrusted ${safePath(filePath)}; it will no longer be merged\n`);
  return 0;
}

async function runTrustList(cwd: string, opts: TrustOptions, io: IO): Promise<number> {
  // A broken registry reads as empty, so the list said "no trusted project
  // lexicons (run: lexicon trust)", and lexicon trust then refused the file.
  const problem = await trustRegistryProblem({ cwd });
  if (problem !== undefined) {
    const registryPath = getTrustPath({ cwd });
    const error = `the trust registry at ${registryPath} ${problem}, so the trusted project lexicons cannot be listed; every project reads as untrusted until it is fixed`;
    const nextStep = `fix the JSON in ${registryPath}, or move it aside (then run \`lexicon trust\` in each project again)`;
    if (opts.json) printJson(io, { ...jsonError(error, nextStep), registry: registryPath });
    io.stderr(`lexicon: ${safeMessage(error)}\n`);
    io.stderr(`lexicon: ${safeMessage(nextStep)}\n`);
    return 1;
  }
  const entries = await listTrusted({ cwd });
  if (opts.json) {
    // `ok: true`, then the registry fields of MCP trust_project's 'status' result.
    printJson(io, jsonOk({ registry: getTrustPath({ cwd }), trustAll: trustAllEnabled(), trusted: entries }));
    return 0;
  }
  io.stdout(`registry: ${safePath(getTrustPath({ cwd }))}\n`);
  if (trustAllEnabled()) io.stdout('LEXICON_TRUST_ALL is set: every project lexicon is treated as trusted\n');
  if (entries.length === 0) {
    io.stdout('no trusted project lexicons (run: lexicon trust)\n');
    return 0;
  }
  const rows = entries.map((e) => [e.path, e.status, e.trustedAt]);
  io.stdout(renderTable(rows, ['path', 'status', 'trusted at'], { pathColumns: [0] }));
  return 0;
}

export { registerTrustCommands } from './program.js';
