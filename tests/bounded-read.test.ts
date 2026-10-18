import { execFileSync } from 'node:child_process';
import { promises as fs, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoundedReadError, isBoundedReadError, readBoundedRegularFile } from '../src/util/bounded-read.js';

// The reader behind the trust gate's reads of someone else's repo files: it
// must only ever read a regular file, never more than the cap, and never block.

let tmp: string;
const posix = process.platform !== 'win32';

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-bounded-')));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function write(name: string, content: string | Buffer): Promise<string> {
  const p = path.join(tmp, name);
  await fs.writeFile(p, content);
  return p;
}

describe('readBoundedRegularFile', () => {
  it('returns the bytes of a small file', async () => {
    const p = await write('a.yaml', 'version: 1\n');
    const r = await readBoundedRegularFile(p, 1024);
    expect(r.bytes.toString('utf8')).toBe('version: 1\n');
  });

  it('returns an empty buffer for an empty file', async () => {
    const r = await readBoundedRegularFile(await write('empty', ''), 1024);
    expect(r.bytes.length).toBe(0);
  });

  it('accepts a file of exactly maxBytes and refuses one byte more', async () => {
    const ok = await readBoundedRegularFile(await write('at', Buffer.alloc(100, 97)), 100);
    expect(ok.bytes.length).toBe(100);
    const err = await readBoundedRegularFile(await write('over', Buffer.alloc(101, 97)), 100).catch((e) => e);
    expect(isBoundedReadError(err)).toBe(true);
    expect(err.reason).toBe('too-large');
    expect(err.size).toBe(101);
  });

  it('reads a file larger than the 64 KiB read-ahead without truncating it', async () => {
    const big = Buffer.alloc(200 * 1024, 'x');
    const r = await readBoundedRegularFile(await write('big', big), 1024 * 1024);
    expect(r.bytes.equals(big)).toBe(true);
  });

  it('rejects a directory as not-regular', async () => {
    const err = await readBoundedRegularFile(tmp, 1024).catch((e) => e);
    expect(err).toBeInstanceOf(BoundedReadError);
    expect(err.reason).toBe('not-regular');
    expect(err.message).toContain('is not a regular file');
  });

  it('rejects a missing path with ENOENT, not a BoundedReadError', async () => {
    const err = await readBoundedRegularFile(path.join(tmp, 'nope'), 1024).catch((e) => e);
    expect(isBoundedReadError(err)).toBe(false);
    expect(err.code).toBe('ENOENT');
  });

  it.runIf(posix)('reports the permission bits', async () => {
    const p = await write('mode', 'x');
    await fs.chmod(p, 0o640);
    expect((await readBoundedRegularFile(p, 1024)).mode).toBe(0o640);
  });

  it.runIf(posix)('follows a symlink to a regular file', async () => {
    const target = await write('target', 'hello');
    const link = path.join(tmp, 'link');
    await fs.symlink(target, link);
    expect((await readBoundedRegularFile(link, 1024)).bytes.toString()).toBe('hello');
  });

  it.runIf(posix && existsDev('/dev/zero'))('refuses a symlink to /dev/zero without reading it', async () => {
    const link = path.join(tmp, 'zero');
    await fs.symlink('/dev/zero', link);
    const err = await readBoundedRegularFile(link, 1024).catch((e) => e);
    expect(isBoundedReadError(err)).toBe(true);
    expect(err.reason).toBe('not-regular');
  });

  it.runIf(posix)('refuses a FIFO without blocking', async () => {
    const fifo = path.join(tmp, 'fifo');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo on this system
    }
    const err = await readBoundedRegularFile(fifo, 1024).catch((e) => e);
    expect(isBoundedReadError(err)).toBe(true);
    expect(err.reason).toBe('not-regular');
  });
});

describe('isBoundedReadError', () => {
  it('is true for a BoundedReadError and false for anything else', () => {
    expect(isBoundedReadError(new BoundedReadError('/x', 'too-large', 5))).toBe(true);
    expect(isBoundedReadError(new Error('x'))).toBe(false);
    expect(isBoundedReadError('x')).toBe(false);
    expect(isBoundedReadError(undefined)).toBe(false);
  });
  it('words the two reasons differently', () => {
    expect(new BoundedReadError('/x', 'too-large', 5).message).toBe('/x is 5 bytes');
    expect(new BoundedReadError('/x', 'too-large').message).toBe('/x is more than the limit of bytes');
    expect(new BoundedReadError('/x', 'not-regular').message).toBe('/x is not a regular file');
  });
});

function existsDev(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
