/**
 * `lexicon pending`: review aliases noticed in your corrections. They are
 * queued (by the prompt hook) and never applied on their own; nothing changes
 * matching until `lexicon pending accept`. Handlers are exported for tests;
 * registerPendingCommands() only wires commander.
 */
import type { Command } from 'commander';
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
  if (opts.json) {
    line(
      io,
      JSON.stringify(
        jsonOk({
          file: res.file,
          accepted: res.accepted.filter((a) => !a.error).map((a) => ({ id: a.entry.id, heard: a.entry.heard, meant: a.entry.meant, canonical: a.result!.term.canonical, path: a.result!.file.path })),
          failed: failed.map((a) => ({ id: a.entry.id, error: a.error })),
          unknown: res.unknown,
        }),
        null,
        2,
      ),
    );
  } else {
    for (const a of res.accepted) {
      if (a.error) io.stderr(`lexicon: ${a.entry.id} not accepted: ${safe(a.error)} (it stays pending)\n`);
      else line(io, `accepted ${a.entry.id}: ${safe(a.entry.heard)} -> ${safe(a.result!.term.canonical)} in ${safe(a.result!.file.path)}`);
    }
    for (const id of res.unknown) io.stderr(`lexicon: no pending alias with id ${safe(id)}\n`);
  }
  return failed.length > 0 || res.unknown.length > 0 ? 1 : 0;
}

export async function runPendingReject(ids: readonly string[], opts: PendingOptions, io: IO): Promise<number> {
  if (!needSelection(ids, opts, io, 'reject')) return 1;
  let res: Awaited<ReturnType<typeof rejectPending>>;
  try {
    res = await rejectPending({ ids, all: opts.all }, storeOpts(opts));
  } catch (err) {
    return failPending(io, err, opts.json);
  }
  if (opts.json) {
    line(io, JSON.stringify(jsonOk({ file: res.file, rejected: res.rejected.map((e) => e.id), unknown: res.unknown }), null, 2));
  } else {
    for (const e of res.rejected) line(io, `rejected ${e.id}: ${safe(e.heard)} -> ${safe(e.meant)} (not learned)`);
    for (const id of res.unknown) io.stderr(`lexicon: no pending alias with id ${safe(id)}\n`);
  }
  return res.unknown.length > 0 ? 1 : 0;
}

export function registerPendingCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };
  const done = (code: number): void => {
    if (code !== 0) process.exitCode = code;
  };
  const pending = program
    .command('pending')
    .description('review aliases noticed in your corrections; nothing is applied until you accept')
    .option('--json', 'print as JSON')
    .action(async (opts: PendingOptions) => done(await runPendingList({ ...opts, ...globals() }, io)));
  pending
    .command('list')
    .description('list pending aliases')
    .option('--json', 'print as JSON')
    .action(async (opts: PendingOptions) => done(await runPendingList({ ...opts, ...globals() }, io)));
  pending
    .command('accept')
    .description('learn pending aliases (as lexicon learn does) and remove them from the queue')
    .argument('[ids...]', 'ids from lexicon pending')
    .option('--all', 'accept every pending alias')
    .option('--json', 'print as JSON')
    .action(async (ids: string[], opts: PendingOptions) => done(await runPendingAccept(ids, { ...opts, ...globals() }, io)));
  pending
    .command('reject')
    .description('drop pending aliases without learning them')
    .argument('[ids...]', 'ids from lexicon pending')
    .option('--all', 'reject every pending alias')
    .option('--json', 'print as JSON')
    .action(async (ids: string[], opts: PendingOptions) => done(await runPendingReject(ids, { ...opts, ...globals() }, io)));
}
