/**
 * Atomic file writes and the cross-process lock that guards a read-modify-write
 * around them.
 *
 * `writeFileAtomic` writes a sibling temp file, then renames it over the
 * target. A reader either sees the old file or the new one, never a half
 * written one, and a crash mid-write leaves the original intact. Used for
 * every file this tool owns and rewrites in place (the lexicon YAML, the
 * trust registry, serve.json, the recorder state).
 *
 * A rename is atomic but a *sequence* of read, edit, write is not: five
 * writers share the lexicon (the MCP server, the UserPromptSubmit hook, the
 * serve API, the clipboard daemon and the menu bar app), and two of them
 * reading the same file before either writes means the second rename silently
 * drops whatever the first added. `withFileLock` is the mutual exclusion that
 * closes that window. It is deliberately a lock *file* rather than a library:
 * `open(2)` with `O_CREAT | O_EXCL` is one syscall, works between unrelated
 * processes, and needs no dependency.
 */
import { promises as fs, unlinkSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import path from 'node:path';
import { isEnoent } from './errors.js';

export interface AtomicWriteOptions {
  /**
   * Mode for the finished file. Set on the temp file at creation *and* with an
   * explicit chmod, because writeFile's `mode` only applies when it creates the
   * file — a leftover temp file from a crashed run would otherwise keep its
   * old, possibly looser, mode.
   */
  mode?: number;
  /**
   * Put this process's pid in the temp file name. Use it for files two lexicon
   * processes may write at the same time (the voice recorder state); without it
   * the temp name is `<target>.tmp`, which is what the tests for the
   * single-writer files assert gets cleaned up.
   */
  unique?: boolean;
  /**
   * Copy the target's current bytes to `<target>.bak` before replacing it, so
   * the previous contents survive a write that turns out to be wrong. A target
   * that does not exist yet has nothing to back up and the option is a no-op.
   */
  backup?: boolean;
}

/** Suffix of the file `backup: true` keeps the previous contents in. */
export const BACKUP_SUFFIX = '.bak';

/** Suffix of the lock file `withFileLock` creates beside its target. */
export const LOCK_SUFFIX = '.lock';

/** How long `withFileLock` waits for a held lock before giving up and throwing. */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

/**
 * How long a lock whose owner we cannot check may sit before it is treated as
 * abandoned. Every write this tool makes is milliseconds of local filesystem
 * work, so a lock older than this is debris, not contention.
 */
export const DEFAULT_LOCK_STALE_MS = 30_000;

/** `mkdir -p` the parent directory, then write `data` to `target` atomically. */
export async function writeFileAtomic(target: string, data: string, opts: AtomicWriteOptions = {}): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = opts.unique ? `${target}.${process.pid}.tmp` : `${target}.tmp`;
  if (opts.mode === undefined) {
    await fs.writeFile(tmp, data, 'utf8');
  } else {
    await fs.writeFile(tmp, data, { encoding: 'utf8', mode: opts.mode });
    await fs.chmod(tmp, opts.mode);
  }
  try {
    if (opts.backup) await backupExisting(target);
    await fs.rename(tmp, target);
  } catch (err) {
    // Never leave the temp file behind: callers assert on its absence, and a
    // stale one would keep its old mode.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Copy `target` to `<target>.bak`, itself through a temp file and a rename so
 * a reader never finds a half-written backup. Silent when there is nothing to
 * copy yet.
 */
async function backupExisting(target: string): Promise<void> {
  const bak = `${target}${BACKUP_SUFFIX}`;
  const tmpBak = `${bak}.tmp`;
  try {
    await fs.copyFile(target, tmpBak);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  try {
    await fs.rename(tmpBak, bak);
  } catch (err) {
    await fs.rm(tmpBak, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

export interface FileLockOptions {
  /** Give up and throw after this long. Default `DEFAULT_LOCK_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Treat a lock at least this old as abandoned. Default `DEFAULT_LOCK_STALE_MS`. */
  staleMs?: number;
}

/**
 * Thrown when a lock could not be taken within `timeoutMs`. The point of
 * throwing is that the alternative is worse: a writer that proceeds without
 * the lock is exactly the silent overwrite this module exists to prevent.
 */
export class FileLockError extends Error {
  readonly path: string;
  readonly lockPath: string;

  constructor(target: string, lockPath: string, detail: string) {
    super(`could not lock ${target} for writing: ${detail} (lock file: ${lockPath})`);
    this.name = 'FileLockError';
    this.path = target;
    this.lockPath = lockPath;
  }
}

/**
 * True for a `FileLockError`. Duck-typed by name rather than with `instanceof`
 * so it still holds across a mocked module or a second copy of the package,
 * the same way `isProjectTrustError` does.
 */
export function isFileLockError(err: unknown): boolean {
  return err instanceof Error && err.name === 'FileLockError';
}

interface LockOwner {
  pid: number;
  host: string;
  token: string;
  at: string;
}

/**
 * Lock paths this process currently owns, so a `process.exit` can clear them.
 * A Ctrl-C does not run exit handlers in Node when nothing listens for SIGINT,
 * and we deliberately do not install a SIGINT listener (that would suppress the
 * default termination for the whole program). The stale check below is what
 * actually covers Ctrl-C and hard crashes: the next writer sees a lock whose
 * pid is gone and breaks it immediately.
 */
const ownedLocks = new Set<string>();
let exitHookInstalled = false;

/**
 * Lock paths held by the current async call chain. `writeLexiconFile` takes
 * the same lock the mutation around it already holds, so the lock has to be
 * re-entrant or every `addTerm` would deadlock against itself.
 */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/** One in-flight chain per lock path: two async contexts in this process queue rather than race the file. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Run `fn` with exclusive access to `target`, across processes.
 *
 * Nested calls for the same target reuse the lock the caller already holds.
 * Hold it for local filesystem work only: never across a network call, a
 * transcription or anything else whose duration is not ours to bound.
 */
export async function withFileLock<T>(
  target: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const lockPath = `${path.resolve(target)}${LOCK_SUFFIX}`;
  const held = heldLocks.getStore();
  if (held?.has(lockPath)) return fn();

  const run = async (): Promise<T> => {
    const token = await acquire(
      lockPath,
      target,
      opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      opts.staleMs ?? DEFAULT_LOCK_STALE_MS,
    );
    const next = new Set(held ?? []);
    next.add(lockPath);
    try {
      return await heldLocks.run(next, fn);
    } finally {
      await release(lockPath, token);
    }
  };

  // Chain onto whatever this process is already doing with the file. The stored
  // tail must never reject, or the next waiter would inherit someone else's
  // failure instead of taking its turn.
  const previous = queues.get(lockPath) ?? Promise.resolve();
  const mine = previous.then(run, run);
  const tail = mine.then(ignore, ignore);
  queues.set(lockPath, tail);
  try {
    return await mine;
  } finally {
    if (queues.get(lockPath) === tail) queues.delete(lockPath);
  }
}

function ignore(): void {
  /* the queue only orders turns; results and failures belong to the caller */
}

async function acquire(lockPath: string, target: string, timeoutMs: number, staleMs: number): Promise<string> {
  const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: new Date().toISOString() });
  const deadline = Date.now() + timeoutMs;
  let wait = 4;
  for (;;) {
    try {
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      // O_CREAT | O_EXCL: the create either wins outright or fails with EEXIST.
      await fs.writeFile(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
      rememberForCleanup(lockPath);
      return token;
    } catch (err) {
      if (!isEexist(err)) throw err;
    }
    if (await breakIfStale(lockPath, staleMs)) continue;
    if (Date.now() >= deadline) {
      throw new FileLockError(target, lockPath, `still held after ${timeoutMs}ms by ${await describeHolder(lockPath)}`);
    }
    // Backoff with jitter so a dozen waiters do not retry in lockstep.
    await sleep(wait / 2 + Math.random() * wait);
    wait = Math.min(wait * 2, 120);
  }
}

/**
 * Remove a lock whose owner is gone. A lock written by a live process on this
 * host is never broken, however old it is. One whose pid has exited is broken
 * at once (this is the Ctrl-C and crash path). One we cannot attribute at all
 * (another host, an unreadable payload) only expires by age.
 *
 * The contents are re-read immediately before the unlink so we can only ever
 * delete the exact lock we judged, never one a third process took meanwhile.
 * Returns true when the caller should retry the create.
 */
async function breakIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  let before: string;
  let mtimeMs: number;
  try {
    before = await fs.readFile(lockPath, 'utf8');
    mtimeMs = (await fs.stat(lockPath)).mtimeMs;
  } catch (err) {
    // Gone between the failed create and now: retry immediately.
    return isEnoent(err);
  }
  const owner = parseOwner(before);
  const ours = owner?.host === os.hostname();
  const abandoned = ours && owner.pid !== process.pid && !pidAlive(owner.pid);
  const expired = Date.now() - mtimeMs >= staleMs;
  if (!abandoned && !expired) return false;
  if (ours && owner.pid === process.pid && pidAlive(owner.pid)) return false;
  try {
    if ((await fs.readFile(lockPath, 'utf8')) !== before) return false;
    await fs.unlink(lockPath);
  } catch {
    return false;
  }
  return true;
}

/** Drop the lock, but only while it is still the one we took. */
async function release(lockPath: string, token: string): Promise<void> {
  ownedLocks.delete(lockPath);
  try {
    if (parseOwner(await fs.readFile(lockPath, 'utf8'))?.token !== token) return;
    await fs.unlink(lockPath);
  } catch {
    // Already gone (broken as stale, or the directory was removed): nothing owed.
  }
}

function rememberForCleanup(lockPath: string): void {
  ownedLocks.add(lockPath);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const held of ownedLocks) {
      try {
        unlinkSync(held);
      } catch {
        // Best effort: an unremoved lock expires on its own.
      }
    }
  });
}

async function describeHolder(lockPath: string): Promise<string> {
  try {
    const owner = parseOwner(await fs.readFile(lockPath, 'utf8'));
    if (owner) return `pid ${owner.pid} on ${owner.host} since ${owner.at}`;
  } catch {
    // Fall through to the vague answer.
  }
  return 'another lexicon process';
}

function parseOwner(text: string): LockOwner | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) return undefined;
    const { pid, host, token, at } = raw as Record<string, unknown>;
    if (typeof pid !== 'number' || typeof host !== 'string' || typeof token !== 'string') return undefined;
    return { pid, host, token, at: typeof at === 'string' ? at : 'an unknown time' };
  } catch {
    return undefined;
  }
}

/** Signal 0 probes for existence. EPERM means the process is there but not ours to signal. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
