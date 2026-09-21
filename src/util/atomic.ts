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
 *
 * Lock ordering. More than one of these files is taken at a time: a lexicon
 * write re-pins `trust.json`, and removing a term drops its count from
 * `hits.json`. The rule is that the lexicon file's lock is always the outer
 * one and the sidecars (`hits.json`, `trust.json`, `serve.json`) are always
 * taken inside it, never the reverse. Two chains taking two paths in opposite
 * orders would wait on each other forever, so the in-process queue is bounded
 * by `queueTimeoutMs` and a mistake fails loudly instead of hanging.
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
   *
   * Left out, an existing target keeps the mode it already has. Without that a
   * lexicon the user had chmod'd to 0600 came back 0644 on the next write,
   * because the temp file was created fresh under the umask and the rename
   * carried the looser mode across. It holds their names; widening it is not
   * ours to do. A target that does not exist yet is created under the umask.
   */
  mode?: number;
  /**
   * Copy the target's current bytes to `<target>.bak` before replacing it, so
   * the previous contents survive a write that turns out to be wrong. A target
   * that does not exist yet has nothing to back up and the option is a no-op.
   *
   * `<target>.bak` alone is one generation deep and the very next write
   * replaces it, which for the lexicon is seconds away: the prompt hook
   * records hit counts on every turn, so a write that turned out to be wrong
   * had its good copy destroyed before anyone could look. A second copy at
   * `<target>.1.bak` is therefore kept alongside it and refreshed only once it
   * is `BACKUP_ROTATE_MS` old, so the pair is "the write before this one" and
   * "the file as it stood at least fifteen minutes ago", and no amount of
   * ordinary churn can consume the second one.
   */
  backup?: boolean;
}

/** Suffix of the file `backup: true` keeps the previous contents in. */
export const BACKUP_SUFFIX = '.bak';

/**
 * Suffix of the older, rate-limited copy `backup: true` keeps beside `.bak`.
 *
 * `.1.bak` rather than `.bak.1` on purpose: every `.gitignore` that already
 * ignores `*.bak` (this repository's does, and so does whichever one a user
 * keeps a project lexicon in) keeps ignoring it, with nothing to add.
 */
export const OLDER_BACKUP_SUFFIX = '.1.bak';

/**
 * How old `<target>.1.bak` has to be before a write refreshes it.
 *
 * It sets how long you have to notice. Below it, no number of writes can
 * touch that copy; above it, the next write replaces it, so it is always
 * roughly this old on a file that is being written to. Fifteen minutes is
 * chosen against how the damage is actually found: a person sees a word has
 * gone, while the writes that were destroying the only copy were hit counters
 * arriving seconds apart from the prompt hook.
 */
export const BACKUP_ROTATE_MS = 15 * 60_000;

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

/**
 * How long a call waits for its turn in this process's own queue for a lock
 * before failing loudly.
 *
 * Separate from `timeoutMs`, and much longer, because the two bound different
 * things. `timeoutMs` bounds contention with *other processes*, where the
 * right answer is to give up quickly and tell the user. The queue is this
 * process's own work: `installPack` legitimately holds a lexicon for a minute
 * on a large file, and anything queued behind it should wait. What the bound
 * is for is the one case waiting can never resolve: two chains taking two
 * of these files in opposite orders, each holding what the other needs. That
 * is a bug in this codebase, not contention, and it should surface as an
 * error someone can read rather than a process that never returns.
 */
export const DEFAULT_LOCK_QUEUE_TIMEOUT_MS = 300_000;

/**
 * The real file `target` names.
 *
 * A lexicon path is often a symlink: a dotfiles repository or a cloud-synced
 * folder is the documented way to carry one between machines. Writing a temp
 * file beside the *link* and renaming it over the link replaces the link with
 * a regular file, so the real file never sees the term again. Reads kept
 * working, which is why nothing looked broken. Resolving first puts the temp
 * beside the real file and renames over that, leaving the link alone.
 *
 * Only a link whose target exists is followed. A dangling one (a cloud folder
 * that is not mounted yet) is left exactly as it is rather than having its
 * destination invented here.
 */
async function resolveWriteTarget(target: string): Promise<string> {
  const abs = path.resolve(target);
  try {
    return await fs.realpath(abs);
  } catch {
    return abs;
  }
}

/**
 * The mode the finished file should have: the caller's, else the one the
 * target already carries, else undefined for "create under the umask".
 */
async function resolveMode(target: string, opts: AtomicWriteOptions): Promise<number | undefined> {
  if (opts.mode !== undefined) return opts.mode;
  try {
    return (await fs.stat(target)).mode & 0o7777;
  } catch {
    return undefined;
  }
}

/** `mkdir -p` the parent directory, then write `data` to `target` atomically. */
export async function writeFileAtomic(target: string, data: string, opts: AtomicWriteOptions = {}): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(target)), { recursive: true });
  const real = await resolveWriteTarget(target);
  // The temp name always carries this process's pid. A shared `<target>.tmp`
  // means two writers that are in the critical section together (a lock that
  // was broken, or a file that had none) overwrite each other's half-written
  // temp, so the failure is a corrupt rename rather than only a lost update.
  const tmp = `${real}.${process.pid}.tmp`;
  const mode = await resolveMode(real, opts);
  if (mode === undefined) {
    await fs.writeFile(tmp, data, 'utf8');
  } else {
    await fs.writeFile(tmp, data, { encoding: 'utf8', mode });
    await fs.chmod(tmp, mode);
  }
  try {
    if (opts.backup) await backupExisting(real);
    await fs.rename(tmp, real);
  } catch (err) {
    // Never leave the temp file behind: callers assert on its absence, and a
    // stale one would keep its old mode.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Keep the target's current bytes at `<target>.bak`, and at
 * `<target>.1.bak` when that one has aged out. Silent when there is nothing
 * to copy yet.
 *
 * Promoting `.bak` into `.1.bak` instead of taking a second copy would not
 * work, and it is worth saying why, because it is the obvious shape. The good
 * bytes are in `.bak` for exactly one write; a bad write pushes them there,
 * and the ordinary write after that overwrites them before any promotion gate
 * has had time to open. The copy that has to survive is the one nothing
 * routine is allowed to touch, so `.1.bak` is written from the target
 * directly and only when it is old enough.
 */
async function backupExisting(target: string): Promise<void> {
  const copied = await copyThroughTemp(target, `${target}${BACKUP_SUFFIX}`);
  if (!copied) return; // nothing on disk yet
  const older = `${target}${OLDER_BACKUP_SUFFIX}`;
  if (await isYoungerThan(older, BACKUP_ROTATE_MS)) return;
  await copyThroughTemp(target, older);
}

/**
 * Copy `from` to `to` through a temp file and a rename, so a reader never
 * finds a half-written backup. False when `from` does not exist.
 */
async function copyThroughTemp(from: string, to: string): Promise<boolean> {
  const tmp = `${to}.${process.pid}.tmp`;
  try {
    await fs.copyFile(from, tmp);
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
  try {
    await fs.rename(tmp, to);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return true;
}

/** True when `file` exists and was written less than `ms` ago. A missing file is due a copy. */
async function isYoungerThan(file: string, ms: number): Promise<boolean> {
  try {
    return Date.now() - (await fs.stat(file)).mtimeMs < ms;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

export interface FileLockOptions {
  /** Give up and throw after this long. Default `DEFAULT_LOCK_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Treat a lock at least this old as abandoned, but only one we cannot
   * attribute to a live process on this host. Default `DEFAULT_LOCK_STALE_MS`.
   */
  staleMs?: number;
  /**
   * Give up waiting for this process's own turn after this long. Default
   * `DEFAULT_LOCK_QUEUE_TIMEOUT_MS`. See the constant for why it is separate
   * from `timeoutMs`.
   */
  queueTimeoutMs?: number;
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

  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const queueTimeoutMs = opts.queueTimeoutMs ?? DEFAULT_LOCK_QUEUE_TIMEOUT_MS;

  const run = async (): Promise<T> => {
    const token = await acquire(lockPath, target, timeoutMs, staleMs);
    const stopHeartbeat = startHeartbeat(lockPath, token, staleMs);
    const next = new Set(held ?? []);
    next.add(lockPath);
    try {
      return await heldLocks.run(next, fn);
    } finally {
      stopHeartbeat();
      await release(lockPath, token);
    }
  };

  // Chain onto whatever this process is already doing with the file. The stored
  // tail must never reject, or the next waiter would inherit someone else's
  // failure instead of taking its turn.
  //
  // `started` is what makes giving up on the queue safe. It is set at the top
  // of our turn, and the bound only fires while it is still false, so we never
  // report failure to the caller while `fn` is running: JavaScript runs both
  // callbacks to completion, so there is no moment where one sees a value the
  // other is midway through writing.
  let started = false;
  let abandoned = false;
  const previous = queues.get(lockPath) ?? Promise.resolve();
  const turn = async (): Promise<T> => {
    if (abandoned) throw new FileLockError(target, lockPath, 'the caller stopped waiting for its turn');
    started = true;
    return run();
  };
  const mine = previous.then(turn, turn);
  const tail = mine.then(ignore, ignore);
  queues.set(lockPath, tail);
  try {
    return await new Promise<T>((resolve, reject) => {
      // Deliberately not unref'd. An unref'd timer lets a wedged process exit
      // 0 with nothing written and nothing said, which is the failure this
      // bound exists to replace.
      const timer = setTimeout(() => {
        if (started) return; // our turn came; `timeoutMs` governs from here
        abandoned = true;
        reject(
          new FileLockError(
            target,
            lockPath,
            `another operation in this process still held it after ${queueTimeoutMs}ms (a lock ordering bug, not contention)`,
          ),
        );
      }, queueTimeoutMs);
      mine.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err as Error);
        },
      );
    });
  } finally {
    if (queues.get(lockPath) === tail) queues.delete(lockPath);
  }
}

function ignore(): void {
  /* the queue only orders turns; results and failures belong to the caller */
}

/**
 * Keep the held lock's mtime current while `fn` runs.
 *
 * The age rule below is the only thing standing between an unattributable
 * lock and a wedged file, and it cannot tell a minute-long operation from
 * debris by the timestamp it was created with. A holder that keeps saying it
 * is there can: `installPack` rewriting a three thousand term lexicon holds
 * for around a minute, and its lock stays young the whole time.
 *
 * Unref'd, so it never keeps a process alive by itself, and it touches the
 * file only while the lock is still the one we took.
 */
function startHeartbeat(lockPath: string, token: string, staleMs: number): () => void {
  const every = Math.max(250, Math.min(Math.floor(staleMs / 3), 5_000));
  const timer = setInterval(() => {
    void (async () => {
      try {
        if (parseOwner(await fs.readFile(lockPath, 'utf8'))?.token !== token) return;
        const now = new Date();
        await fs.utimes(lockPath, now, now);
      } catch {
        // Gone or unreadable: `release` copes, and there is nothing to refresh.
      }
    })();
  }, every);
  // Optional call: a test environment that substitutes the global timers
  // (jsdom does) hands back a plain handle with no `unref`.
  timer.unref?.();
  return () => clearInterval(timer);
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
 * Remove a lock whose owner is gone.
 *
 * A lock written by a live process on this host is never broken, however old
 * it is. This used to be what the comment said and not what the code did: the
 * code broke on age alone, and the only exemption was our own pid. That was
 * reachable in ordinary use. `installPack` takes one lock for the whole
 * install, which on a three thousand term lexicon is around a minute, and the
 * cap is five thousand; a `lexicon add` arriving half a minute in broke the
 * live lock, wrote, and reported success, and the install then renamed its own
 * copy over the top. Both exited 0 and the term was gone. Age cannot tell a
 * long operation from debris. Liveness can, so for a lock this host wrote,
 * liveness is the whole rule.
 *
 * One whose pid has exited is broken at once (this is the Ctrl-C and crash
 * path). One we cannot attribute at all (another host, an unreadable or
 * nonsensical payload) still only expires by age, because there is nothing
 * else to go on; a live holder refreshes the mtime as it works, so age means
 * what it says.
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
  if (owner && owner.host === os.hostname()) {
    // Ours to judge: alive means held, whatever the clock says.
    if (pidAlive(owner.pid)) return false;
  } else if (Date.now() - mtimeMs < staleMs) {
    return false;
  }
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
    // Liveness is now the whole rule for a lock this host wrote, so a payload
    // that names this host with a pid no process can have must not count as
    // attributable: `pidAlive` answers true for one, and the file would never
    // be unwedged. Unattributable means it expires by age, which is right.
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
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
