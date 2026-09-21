/**
 * The write primitive and the cross-process lock under every file this tool
 * owns.
 *
 * These were the defects an audit executed against v0.5.3 with real
 * subprocesses, and every test here was watched failing against that code
 * before the fix went in. Each one says which defect it catches, because the
 * failures they cover all looked like success at the time: a term written and
 * gone, a lexicon that quietly went world-readable, a symlink replaced by a
 * regular file, a good copy destroyed by the next hit counter.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_ROTATE_MS,
  BACKUP_SUFFIX,
  DEFAULT_LOCK_STALE_MS,
  LOCK_SUFFIX,
  OLDER_BACKUP_SUFFIX,
  isFileLockError,
  withFileLock,
  writeFileAtomic,
} from '../src/util/atomic.js';

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function scratch(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-atomic-'));
  dirs.push(dir);
  return dir;
}

/**
 * A real, live process on this host that is not us. `process.pid` would be
 * exempted by name; the rule under test is about someone else's live pid.
 */
function livePid(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 120000)'], { stdio: 'ignore' });
  children.push(child);
  return child.pid as number;
}

function lockPayload(pid: number, token = 'not-ours'): string {
  return JSON.stringify({ pid, host: os.hostname(), token, at: new Date().toISOString() });
}

/** Siblings of `target` that look like an abandoned temp file. */
async function leftoverTemps(target: string): Promise<string[]> {
  const base = path.basename(target);
  const entries = await fs.readdir(path.dirname(target));
  return entries.filter((e) => e.startsWith(base) && e.endsWith('.tmp')).sort();
}

describe('a lock held by a live process is never broken by age', () => {
  /**
   * Catches: the stale rule breaking on age alone. The doc comment promised
   * a lock written by a live process on this host is never broken however old
   * it is; the code broke at `staleMs` and exempted only our own pid.
   *
   * It became reachable when `installPack` went from seventy short locks to
   * one long one: measured at 62s on a three thousand term lexicon against a
   * 30s staleness rule and a five thousand term cap. End to end, a `lexicon
   * add` arriving half a minute into a `lexicon pack install` broke the live
   * lock, wrote, and reported success; the install then renamed its own copy
   * over the top. Both exited 0 and the term was gone.
   *
   * An mtime in the distant past stands in for the long hold, so the test
   * costs nothing in wall clock. The pid is a real child process, because
   * that is the whole of the rule being pinned.
   */
  it('refuses a lock whose owner is alive, however old the lock file is', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'lexicon.yaml');
    const lockPath = `${target}${LOCK_SUFFIX}`;
    await fs.writeFile(target, 'version: 1\nterms: []\n');
    await fs.writeFile(lockPath, lockPayload(livePid()));
    // Far past any staleness rule this codebase uses.
    const ancient = new Date(Date.now() - DEFAULT_LOCK_STALE_MS * 20);
    await fs.utimes(lockPath, ancient, ancient);

    let caught: unknown;
    let entered = false;
    await withFileLock(
      target,
      async () => {
        entered = true;
      },
      { timeoutMs: 300, staleMs: 50 },
    ).catch((err: unknown) => {
      caught = err;
    });

    expect(entered).toBe(false);
    expect(isFileLockError(caught)).toBe(true);
    // And the live owner's lock is still there, not quietly removed.
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain('not-ours');
  });

  /**
   * Catches: dropping the heartbeat. A lock this host cannot attribute (a
   * different hostname, an unreadable payload) has nothing but its age to go
   * on, so a holder that works for longer than `staleMs` has to keep saying
   * it is there. Without the refresh the mtime never moves.
   */
  it('refreshes its own lock file while a long operation runs', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'lexicon.yaml');
    const lockPath = `${target}${LOCK_SUFFIX}`;

    const { before, after } = await withFileLock(
      target,
      async () => {
        const first = (await fs.stat(lockPath)).mtimeMs;
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return { before: first, after: (await fs.stat(lockPath)).mtimeMs };
      },
      { staleMs: 900 },
    );

    expect(after).toBeGreaterThan(before);
  });

  /**
   * Catches: treating a payload that names this host but carries an
   * impossible pid as attributable. Liveness is now the whole rule for a
   * local lock, and `pidAlive` answers true for a pid no process can have, so
   * without this such a file would wedge the lexicon forever.
   */
  it('still expires a lock whose payload names no real process', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'lexicon.yaml');
    const lockPath = `${target}${LOCK_SUFFIX}`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify({ pid: 0, host: os.hostname(), token: 'nonsense', at: 'then' }));
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, old, old);

    let entered = false;
    await withFileLock(
      target,
      async () => {
        entered = true;
      },
      { timeoutMs: 2_000, staleMs: 100 },
    );
    expect(entered).toBe(true);
  });
});

describe('the in-process queue is bounded', () => {
  /**
   * Catches: an unbounded wait for this process's own turn. `timeoutMs`
   * bounds acquisition only, so two chains taking two of these files in
   * opposite orders waited on each other with nothing to end it. Against the
   * unbounded code this test does not fail with a message, it hangs until
   * vitest kills it, which is the point: a lock ordering mistake should be
   * something someone can read.
   *
   * Nothing takes locks in opposite orders today (`util/atomic.ts` states the
   * order the codebase keeps), so this guards the next change rather than the
   * current one.
   */
  it('fails loudly instead of hanging when two chains take two locks in opposite orders', async () => {
    const dir = await scratch();
    const p = path.join(dir, 'p.yaml');
    const q = path.join(dir, 'q.yaml');
    const opts = { queueTimeoutMs: 1_000 };
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    const a = withFileLock(p, async () => {
      await sleep(50);
      return withFileLock(q, async () => 'a', opts);
    }, opts);
    const b = withFileLock(q, async () => {
      await sleep(50);
      return withFileLock(p, async () => 'b', opts);
    }, opts);

    const settled = await Promise.allSettled([a, b]);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
    for (const outcome of settled) {
      expect(isFileLockError((outcome as PromiseRejectedResult).reason)).toBe(true);
    }
  });

  it('still lets a queued caller through when the holder finishes', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'lexicon.yaml');
    const order: string[] = [];
    await Promise.all([
      withFileLock(target, async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        order.push('first');
      }),
      withFileLock(target, async () => {
        order.push('second');
      }),
    ]);
    expect(order).toEqual(['first', 'second']);
  });
});

describe('writeFileAtomic keeps the file it is replacing', () => {
  /**
   * Catches: calling `writeFileAtomic` with no mode and letting the rename
   * carry a fresh temp file's `0666 & ~umask` onto the target. A lexicon the
   * user had chmod'd to 0600 came back 0644 on the next write, and it holds
   * their names. `serve.json` passes an explicit mode and was always right,
   * which is what made this one easy to miss.
   */
  it('leaves an existing file the mode it already had', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'lexicon.yaml');
    await fs.writeFile(target, 'one\n');
    await fs.chmod(target, 0o600);

    await writeFileAtomic(target, 'two\n');

    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(target, 'utf8')).toBe('two\n');
  });

  it('still honours an explicit mode', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'serve.json');
    await fs.writeFile(target, '{}');
    await fs.chmod(target, 0o644);

    await writeFileAtomic(target, '{"token":"x"}', { mode: 0o600 });

    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  /**
   * Catches: writing beside the symlink rather than through it. Reads follow
   * the link, so the first write severed it and the real file never saw the
   * term again with nothing looking broken. A dotfiles repository or a
   * cloud-synced folder is the documented way to carry a lexicon between
   * machines, which is exactly this shape.
   */
  it('writes through a symlinked path and leaves the link a link', async () => {
    const dir = await scratch();
    const real = path.join(dir, 'real', 'lexicon.yaml');
    await fs.mkdir(path.dirname(real), { recursive: true });
    await fs.writeFile(real, 'before\n');
    const link = path.join(dir, 'lexicon.yaml');
    await fs.symlink(real, link);

    await writeFileAtomic(link, 'after\n');

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, 'utf8')).toBe('after\n');
    // The backup belongs beside the real file, not beside the link.
    await expect(fs.stat(`${link}${BACKUP_SUFFIX}`)).rejects.toThrow();
  });

  /**
   * Catches: the shared `<target>.tmp` name. Two writers inside the critical
   * section together (a lock that was broken, or a file that had none) wrote
   * the same temp path, so the failure could be a corrupt rename rather than
   * only a lost update. A directory sitting on the old name is the
   * deterministic way to say the name is no longer used.
   */
  it('does not write to the temp name two writers would share', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'lexicon.yaml');
    await fs.mkdir(`${target}.tmp`, { recursive: true });

    await writeFileAtomic(target, 'written\n');

    expect(await fs.readFile(target, 'utf8')).toBe('written\n');
    expect(await leftoverTemps(target)).toEqual(['lexicon.yaml.tmp']); // the directory we planted
  });

  it('cleans its own temp file up when the write fails', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'sub', 'lexicon.yaml');
    await fs.mkdir(path.dirname(target), { recursive: true });
    // A directory where the file should go: the rename is what fails, after
    // the temp exists.
    await fs.mkdir(target, { recursive: true });

    await expect(writeFileAtomic(target, 'x')).rejects.toThrow();
    expect(await leftoverTemps(target)).toEqual([]);
  });
});

describe('backup: true survives the writes that come after it', () => {
  /**
   * Catches: a backup one generation deep. `.bak` is replaced by the very
   * next write, and for the lexicon the next write is a hit counter from the
   * prompt hook seconds later, so the copy that mattered was gone before
   * anyone could look at it. The older copy is written from the target
   * directly and only once it has aged out, so ordinary churn cannot reach
   * it.
   */
  it('keeps a copy from before the damage after twenty more writes', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'lexicon.yaml');

    await writeFileAtomic(target, 'good\n', { backup: true });
    await writeFileAtomic(target, 'still good\n', { backup: true });
    await writeFileAtomic(target, 'WIPED\n', { backup: true });
    for (let i = 0; i < 20; i++) await writeFileAtomic(target, `hit ${i}\n`, { backup: true });

    // The recent copy is the write before this one, as it has always been.
    expect(await fs.readFile(`${target}${BACKUP_SUFFIX}`, 'utf8')).toBe('hit 18\n');
    // And a good file from before the damage is still there.
    expect(await fs.readFile(`${target}${OLDER_BACKUP_SUFFIX}`, 'utf8')).toBe('good\n');
  });

  it('refreshes the older copy once it has aged out', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'lexicon.yaml');
    const older = `${target}${OLDER_BACKUP_SUFFIX}`;

    await writeFileAtomic(target, 'one\n', { backup: true });
    await writeFileAtomic(target, 'two\n', { backup: true });
    expect(await fs.readFile(older, 'utf8')).toBe('one\n');

    const aged = new Date(Date.now() - BACKUP_ROTATE_MS - 1_000);
    await fs.utimes(older, aged, aged);
    await writeFileAtomic(target, 'three\n', { backup: true });

    expect(await fs.readFile(older, 'utf8')).toBe('two\n');
  });

  it('has nothing to back up on the first write', async () => {
    const dir = await scratch();
    const target = path.join(dir, 'lexicon.yaml');
    await writeFileAtomic(target, 'first\n', { backup: true });
    await expect(fs.stat(`${target}${BACKUP_SUFFIX}`)).rejects.toThrow();
    await expect(fs.stat(`${target}${OLDER_BACKUP_SUFFIX}`)).rejects.toThrow();
    expect(await leftoverTemps(target)).toEqual([]);
  });
});
