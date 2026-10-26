/**
 * Pending aliases: corrections noticed automatically (for example by the
 * UserPromptSubmit hook on "it's Ashlr.AI not Ashler") are queued here for
 * review instead of being written to the lexicon. Nothing in this file is read
 * by the matcher, so a queued alias changes no transcript until the user
 * accepts it with `lexicon pending accept` (which goes through
 * learnCorrection, the same path as `lexicon learn`). `reject` drops it and
 * remembers its id under `rejected:`, so the hook does not queue the same
 * correction again (an explicit `lexicon learn` still works).
 *
 * The queue lives next to the global lexicon as `pending-aliases.yaml`, a
 * small reviewable file that can also be read or edited by hand.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { writeFileAtomic } from '../util/atomic.js';
import { MAX_CORRECTION_LENGTH, learnCorrection } from './learn.js';
import type { LearnResult } from './learn.js';
import { resolvePaths, withLexiconLock } from './store.js';
import type { StoreOptions } from './store.js';
import type { Lexicon } from './types.js';

export const PENDING_FILE_NAME = 'pending-aliases.yaml';
/** Most entries kept; past this the least recently seen are dropped. */
export const MAX_PENDING = 200;
/** Largest pending file read; a bigger one is left alone, never overwritten. */
const MAX_PENDING_BYTES = 256 * 1024;

export interface PendingAlias {
  /** Stable id from heard and meant (case-folded), 8 hex characters. */
  id: string;
  heard: string;
  meant: string;
  /** Where it was noticed, e.g. `prompt-hook`. */
  source: string;
  /** How many times it was noticed. */
  count: number;
  firstSeen: string;
  lastSeen: string;
}

/** Most rejected ids remembered; past this the oldest rejections are forgotten. */
export const MAX_REJECTED = 500;

/** A rejected correction: its pendingId and when it was rejected (no words kept). */
export interface RejectedAlias {
  id: string;
  rejectedAt: string;
}

export class PendingFileError extends Error {}

const HEADER =
  '# Lexicon: aliases noticed in your corrections, waiting for review.\n' +
  '# Nothing here changes matching. Accept with: lexicon pending accept <id>\n' +
  '# Reject with: lexicon pending reject <id>\n';

/** The pending file for a global lexicon path. */
export function pendingPathFor(globalLexiconPath: string): string {
  return path.join(path.dirname(globalLexiconPath), PENDING_FILE_NAME);
}

export function pendingPath(opts: StoreOptions = {}): string {
  return pendingPathFor(resolvePaths(opts).global);
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

export function pendingId(heard: string, meant: string): string {
  const key = `${norm(heard).toLowerCase()}\u0000${norm(meant).toLowerCase()}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** Why a correction cannot be queued, or undefined when it can. */
export function queueRefusal(heard: string, meant: string): string | undefined {
  const h = norm(heard);
  const m = norm(meant);
  if (!h || !m) return 'empty';
  if (h.length > MAX_CORRECTION_LENGTH || m.length > MAX_CORRECTION_LENGTH) return 'too-long';
  if (h === m) return 'same';
  return undefined;
}

/** True when `heard` already resolves to `meant` in `lexicon` (nothing to review). */
export function alreadyKnown(lexicon: Lexicon, heard: string, meant: string): boolean {
  const h = norm(heard).toLowerCase();
  const m = norm(meant).toLowerCase();
  return lexicon.terms.some(
    (t) =>
      t.canonical.toLowerCase() === m &&
      (t.canonical.toLowerCase() === h || t.aliases.some((a) => a.toLowerCase() === h)),
  );
}

function isEntry(v: unknown): v is PendingAlias {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.heard === 'string' &&
    typeof e.meant === 'string' &&
    typeof e.source === 'string' &&
    typeof e.count === 'number' &&
    typeof e.firstSeen === 'string' &&
    typeof e.lastSeen === 'string'
  );
}

function isRejected(v: unknown): v is RejectedAlias {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.rejectedAt === 'string';
}

/** Entries in the pending file; [] when it does not exist. Throws PendingFileError on a bad file. */
export async function readPending(file: string): Promise<PendingAlias[]> {
  return (await readPendingFile(file)).entries;
}

/** Pending entries and remembered rejections. Throws PendingFileError on a bad file. */
export async function readPendingFile(file: string): Promise<{ entries: PendingAlias[]; rejected: RejectedAlias[] }> {
  let text: string;
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_PENDING_BYTES) throw new PendingFileError(`${file} is larger than ${MAX_PENDING_BYTES} bytes`);
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], rejected: [] };
    throw err;
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    throw new PendingFileError(`${file} is not valid YAML`);
  }
  if (doc === null || doc === undefined) return { entries: [], rejected: [] };
  const list = (doc as { pending?: unknown }).pending;
  if (typeof doc !== 'object' || (list !== undefined && !Array.isArray(list))) {
    throw new PendingFileError(`${file} does not hold a pending list`);
  }
  const entries = (list ?? []) as unknown[];
  if (!entries.every(isEntry)) throw new PendingFileError(`${file} has an entry that is not a pending alias`);
  const rej = (doc as { rejected?: unknown }).rejected;
  if (rej !== undefined && (!Array.isArray(rej) || !rej.every(isRejected))) {
    throw new PendingFileError(`${file} has a rejected list that is not id and rejectedAt pairs`);
  }
  return { entries, rejected: (rej ?? []) as RejectedAlias[] };
}

async function writePending(file: string, entries: PendingAlias[], rejected: RejectedAlias[]): Promise<void> {
  const doc: Record<string, unknown> = { version: 1, pending: entries };
  if (rejected.length > 0) doc.rejected = rejected;
  await writeFileAtomic(file, HEADER + stringify(doc), { mode: 0o600 });
}

export interface QueueOptions extends StoreOptions {
  source?: string;
  now?: Date;
  /** Skip corrections the lexicon already knows. */
  lexicon?: Lexicon;
  /**
   * Give up on the pending file's lock after this long (FileLockError),
   * default DEFAULT_LOCK_TIMEOUT_MS. The prompt hook passes a short one so a
   * held lock cannot hold the user's prompt for ten seconds.
   */
  lockTimeoutMs?: number;
}

export interface QueueResult {
  queued: PendingAlias[];
  skipped: number;
  file: string;
}

/**
 * Queue corrections for review. Never touches the lexicon. A correction that
 * is already queued gets its count and lastSeen bumped. A bad pending file is
 * left alone (PendingFileError), never overwritten.
 */
export async function queueCorrections(
  corrections: ReadonlyArray<{ heard: string; meant: string }>,
  opts: QueueOptions = {},
): Promise<QueueResult> {
  const file = pendingPath(opts);
  const now = (opts.now ?? new Date()).toISOString();
  const source = opts.source ?? 'manual';
  const lockOpts = opts.lockTimeoutMs !== undefined ? { timeoutMs: opts.lockTimeoutMs } : undefined;
  return withLexiconLock(file, async () => {
    const { entries, rejected } = await readPendingFile(file);
    const rejectedIds = new Set(rejected.map((r) => r.id));
    const queued: PendingAlias[] = [];
    let skipped = 0;
    for (const c of corrections) {
      if (queueRefusal(c.heard, c.meant) !== undefined || (opts.lexicon && alreadyKnown(opts.lexicon, c.heard, c.meant))) {
        skipped++;
        continue;
      }
      const id = pendingId(c.heard, c.meant);
      // The user already said no to this exact correction; do not ask again.
      if (rejectedIds.has(id)) {
        skipped++;
        continue;
      }
      const hit = entries.find((e) => e.id === id);
      if (hit) {
        hit.count++;
        hit.lastSeen = now;
        queued.push(hit);
      } else {
        const entry: PendingAlias = { id, heard: norm(c.heard), meant: norm(c.meant), source, count: 1, firstSeen: now, lastSeen: now };
        entries.push(entry);
        queued.push(entry);
      }
    }
    if (queued.length > 0) {
      entries.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0));
      entries.splice(MAX_PENDING);
      entries.sort((a, b) => (a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : 0));
      await writePending(file, entries, rejected);
    }
    return { queued, skipped, file };
  }, lockOpts);
}

export async function listPending(opts: StoreOptions = {}): Promise<{ file: string; entries: PendingAlias[] }> {
  const file = pendingPath(opts);
  return { file, entries: await readPending(file) };
}

export interface ResolveSelection {
  ids?: readonly string[];
  all?: boolean;
}

function select(entries: PendingAlias[], sel: ResolveSelection): { picked: PendingAlias[]; unknown: string[] } {
  if (sel.all) return { picked: [...entries], unknown: [] };
  const want = [...new Set((sel.ids ?? []).map((s) => s.trim().toLowerCase()))];
  const picked: PendingAlias[] = [];
  const unknown: string[] = [];
  for (const id of want) {
    const e = entries.find((x) => x.id === id);
    if (e) picked.push(e);
    else unknown.push(id);
  }
  return { picked, unknown };
}

/** Drop the selected entries without learning them, and remember their ids so they are not queued again. */
export async function rejectPending(
  sel: ResolveSelection,
  opts: StoreOptions & { now?: Date } = {},
): Promise<{ rejected: PendingAlias[]; unknown: string[]; file: string }> {
  const file = pendingPath(opts);
  const now = (opts.now ?? new Date()).toISOString();
  return withLexiconLock(file, async () => {
    const { entries, rejected } = await readPendingFile(file);
    const { picked, unknown } = select(entries, sel);
    if (picked.length > 0) {
      const ids = new Set(picked.map((e) => e.id));
      const kept = rejected.filter((r) => !ids.has(r.id));
      for (const e of picked) kept.push({ id: e.id, rejectedAt: now });
      await writePending(file, entries.filter((e) => !picked.includes(e)), kept.slice(-MAX_REJECTED));
    }
    return { rejected: picked, unknown, file };
  });
}

export interface AcceptedAlias {
  entry: PendingAlias;
  result?: LearnResult;
  error?: string;
}

/**
 * Hold the lock of every lexicon file learnCorrection may write (the global
 * one, then the project one when there is one) around `fn`. The lexicon lock
 * is always the outer one (see withFileLock in CONTRACT.md), so acceptPending
 * takes these before the pending file's lock, never inside it: a writer that
 * holds a lexicon lock and then queues a correction would otherwise wait on
 * the pending lock while accept waited on its lexicon lock.
 */
function withLexiconWriteLocks<T>(opts: StoreOptions, fn: () => Promise<T>): Promise<T> {
  const paths = resolvePaths(opts);
  const inner = paths.project ? () => withLexiconLock(paths.project as string, fn) : fn;
  return withLexiconLock(paths.global, inner);
}

/**
 * Learn the selected entries (through learnCorrection, as `lexicon learn`
 * does) and remove each one that was learned. One that fails stays queued.
 * The lexicon locks are taken first and the pending lock inside them, and all
 * of them are held from reading the queue to writing it back, so a concurrent
 * accept, reject or queue cannot see an entry that is half accepted.
 */
export async function acceptPending(
  sel: ResolveSelection,
  opts: StoreOptions = {},
  learn: typeof learnCorrection = learnCorrection,
): Promise<{ accepted: AcceptedAlias[]; unknown: string[]; file: string }> {
  const file = pendingPath(opts);
  return withLexiconWriteLocks(opts, () => withLexiconLock(file, async () => {
    const { entries, rejected } = await readPendingFile(file);
    const { picked, unknown } = select(entries, sel);
    const accepted: AcceptedAlias[] = [];
    const done = new Set<PendingAlias>();
    for (const entry of picked) {
      try {
        const result = await learn({ heard: entry.heard, meant: entry.meant }, opts);
        accepted.push({ entry, result });
        done.add(entry);
      } catch (err) {
        accepted.push({ entry, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (done.size > 0) await writePending(file, entries.filter((e) => !done.has(e)), rejected);
    return { accepted, unknown, file };
  }));
}
