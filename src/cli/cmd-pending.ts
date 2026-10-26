/**
 * `lexicon pending`: review aliases noticed in your corrections. They are
 * queued (by the prompt hook) and never applied on their own; nothing changes
 * matching until `lexicon pending accept`. Handlers are exported for tests;
 * registerPendingCommands() only wires commander.
 */
import { PendingFileError, acceptPending, alreadyKnown, listPending, loadLexicon, rejectPending } from '../core/index.js';
import type { PendingAlias } from '../core/index.js';
import { jsonOk, line, printJsonError, renderTable, resolveCwd, safe } from './io.js';
import type { CommonOptions, IO } from './io.js';

export interface PendingOptions extends CommonOptions {
  json?: boolean;
  all?: boolean;
  /** Explicit global lexicon path (tests); the pending file sits next to it. */
  globalPath?: string;
}

function storeOpts(opts: PendingOptions): { cwd: string; globalPath?: string } {
  return { cwd: resolveCwd(opts), ...(opts.globalPath ? { globalPath: opts.globalPath } : {}) };
}

function failPending(io: IO, err: unknown, json?: boolean): number {
  const message = err instanceof Error ? err.message : String(err);
  const nextStep = err instanceof PendingFileError ? 'fix or delete the pending file, then run the command again' : undefined;
  if (json) printJsonError(io, message, nextStep);
  io.stderr(`lexicon: ${safe(message)}\n`);
  if (nextStep) io.stderr(`lexicon: ${nextStep}\n`);
  return 1;
}

export async function runPendingList(opts: PendingOptions, io: IO): Promise<number> {
  const so = storeOpts(opts);
  let file: string;
  let entries: PendingAlias[];
  try {
    ({ file, entries } = await listPending(so));
  } catch (err) {
    return failPending(io, err, opts.json);
  }
  let known = new Set<string>();
  try {
    const loaded = await loadLexicon(so);
    known = new Set(entries.filter((e) => alreadyKnown(loaded.merged, e.heard, e.meant)).map((e) => e.id));
  } catch {
    // Listing does not need the lexicon; without it nothing is marked known.
  }
  if (opts.json) {
    line(io, JSON.stringify(jsonOk({ file, pending: entries.map((e) => ({ ...e, alreadyKnown: known.has(e.id) })) }), null, 2));
    return 0;
  }
  if (entries.length === 0) {
    line(io, `no pending aliases (${safe(file)})`);
    return 0;
  }
  line(io, `${entries.length} pending alias${entries.length === 1 ? '' : 'es'} in ${safe(file)}; none of them changes matching until accepted:`);
  line(
    io,
    renderTable(
      entries.map((e) => [e.id, safe(e.heard), safe(e.meant), String(e.count), e.lastSeen.slice(0, 10), known.has(e.id) ? 'already known' : '']),
      ['id', 'heard', 'meant', 'seen', 'last', ''],
    ).trimEnd(),
  );
  line(io, 'accept: lexicon pending accept <id...>   reject: lexicon pending reject <id...>   (or --all)');
  return 0;
}

function needSelection(ids: readonly string[], opts: PendingOptions, io: IO, verb: string): boolean {
  if (ids.length > 0 || opts.all) return true;
  const error = `nothing to ${verb}: name one or more ids, or pass --all`;
  if (opts.json) printJsonError(io, error, 'run: lexicon pending (to list ids)');
  io.stderr(`lexicon: ${error}\n`);
  return false;
}

export async function runPendingAccept(ids: readonly string[], opts: PendingOptions, io: IO): Promise<number> {
  if (!needSelection(ids, opts, io, 'accept')) return 1;
  let res: Awaited<ReturnType<typeof acceptPending>>;
  try {
    res = await acceptPending({ ids, all: opts.all }, storeOpts(opts));
  } catch (err) {
    return failPending(io, err, opts.json);
  }
  const failed = res.accepted.filter((a) => a.error !== undefined);
  const code = failed.length > 0 || res.unknown.length > 0 ? 1 : 0;
  if (opts.json) {
    // `ok` follows the exit code, as `pack update` and `pack validate` do: an
    // unknown id or a failed accept exits 1, which `ok: true` hid.
    line(
      io,
      JSON.stringify(
        {
          ok: code === 0,
          ...partialFailure(failed.map((a) => `${a.entry.id} not accepted: ${a.error}`), res.unknown),
          file: res.file,
          accepted: res.accepted.filter((a) => !a.error).map((a) => ({ id: a.entry.id, heard: a.entry.heard, meant: a.entry.meant, canonical: a.result!.term.canonical, path: a.result!.file.path })),
          failed: failed.map((a) => ({ id: a.entry.id, error: a.error })),
          unknown: res.unknown,
        },
        null,
        2,
      ),
    );
  }
  if (!opts.json && res.accepted.length === 0 && res.unknown.length === 0) line(io, emptyQueueLine('accept', res.file));
  for (const a of res.accepted) {
    if (a.error) io.stderr(`lexicon: ${a.entry.id} not accepted: ${safe(a.error)} (it stays pending)\n`);
    else if (!opts.json) line(io, `accepted ${a.entry.id}: ${safe(a.entry.heard)} -> ${safe(a.result!.term.canonical)} in ${safe(a.result!.file.path)}`);
  }
  // On stderr under --json too, as every other refusal is.
  for (const id of res.unknown) io.stderr(`lexicon: ${unknownPendingLine(id)}\n`);
  return code;
}

/**
 * `error` and `nextStep` for a run that exits 1, so the document carries them
 * as every other `--json` failure does; nothing when everything selected was
 * handled.
 */
function partialFailure(failed: readonly string[], unknown: readonly string[]): { error?: string; nextStep?: string } {
  const problems = [...failed, ...unknown.map((id) => `no pending alias with id ${id}`)];
  if (problems.length === 0) return {};
  return {
    error: problems.join('; '),
    nextStep: unknown.length > 0 ? 'run lexicon pending list to see the ids' : 'the entries not accepted stay pending; fix what error names and accept them again',
  };
}

/**
 * What `accept --all` / `reject --all` print on an empty queue, which used to
 * be nothing at all: what happened and where entries come from.
 */
function emptyQueueLine(verb: 'accept' | 'reject', file: string): string {
  return `no pending aliases to ${verb} (${safe(file)}); corrections the prompt hook notices are queued here, and lexicon pending lists them`;
}

/** A selected id the queue does not hold, and how to see the ones it does. */
function unknownPendingLine(id: string): string {
  return `no pending alias with id ${safe(id)}; run lexicon pending list to see the ids`;
}

export async function runPendingReject(ids: readonly string[], opts: PendingOptions, io: IO): Promise<number> {
  if (!needSelection(ids, opts, io, 'reject')) return 1;
  let res: Awaited<ReturnType<typeof rejectPending>>;
  try {
    res = await rejectPending({ ids, all: opts.all }, storeOpts(opts));
  } catch (err) {
    return failPending(io, err, opts.json);
  }
  const code = res.unknown.length > 0 ? 1 : 0;
  if (opts.json) {
    line(
      io,
      JSON.stringify({ ok: code === 0, ...partialFailure([], res.unknown), file: res.file, rejected: res.rejected.map((e) => e.id), unknown: res.unknown }, null, 2),
    );
  } else {
    if (res.rejected.length === 0 && res.unknown.length === 0) line(io, emptyQueueLine('reject', res.file));
    for (const e of res.rejected) line(io, `rejected ${e.id}: ${safe(e.heard)} -> ${safe(e.meant)} (not learned)`);
  }
  for (const id of res.unknown) io.stderr(`lexicon: ${unknownPendingLine(id)}\n`);
  return code;
}

export { registerPendingCommands } from './program.js';
