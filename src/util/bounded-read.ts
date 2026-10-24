/**
 * Read a file that someone else may have put there, without letting it decide
 * how much we read or whether the read ever finishes.
 *
 * A project `.lexicon.yaml` comes from whatever repository the user cloned,
 * and git stores symlinks. `fs.stat` follows one, so a link to `/dev/zero` or
 * `/dev/urandom` reports size 0, passes a size check, and `fs.readFile` then
 * reads until Node gives up on the string length: seconds of CPU and the best
 * part of a gigabyte on every prompt. A link to `/dev/stdin` is worse in the
 * MCP server, whose stdin is the protocol stream: the read swallows the
 * client's requests and never returns. A FIFO blocks `open(2)` itself.
 *
 * So: only a regular file is read (checked before the open, and again on the
 * open descriptor so a swap in between cannot slip a device in), the open is
 * non-blocking where the platform has the flag, and at most `maxBytes + 1`
 * bytes are read whatever the file claims its size is.
 */
import { constants, promises as fs } from 'node:fs';

/** Why `readBoundedRegularFile` refused a path that exists. */
export class BoundedReadError extends Error {
  readonly path: string;
  readonly reason: 'not-regular' | 'too-large';
  /** Bytes the file holds (or at least holds, for one that grew past the cap while being read). */
  readonly size?: number;

  constructor(filePath: string, reason: 'not-regular' | 'too-large', size?: number) {
    super(
      reason === 'not-regular'
        ? `${filePath} is not a regular file`
        : `${filePath} is ${size ?? 'more than the limit of'} bytes`,
    );
    this.name = 'BoundedReadError';
    this.path = filePath;
    this.reason = reason;
    if (size !== undefined) this.size = size;
  }
}

/** True for a `BoundedReadError` (duck-typed by name, like the other error guards). */
export function isBoundedReadError(err: unknown): err is BoundedReadError {
  return err instanceof Error && err.name === 'BoundedReadError';
}

// O_NONBLOCK keeps a FIFO that was swapped in after the stat from blocking the
// open. Windows has no such flag (and no FIFOs to worry about).
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * The bytes and permission bits of the regular file at `filePath`, following
 * symlinks. Rejects with ENOENT when nothing is there (callers already handle
 * that), and with a `BoundedReadError` when the target is not a regular file
 * or holds more than `maxBytes` bytes.
 */
export async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<{ bytes: Buffer; mode: number }> {
  const before = await fs.stat(filePath);
  if (!before.isFile()) throw new BoundedReadError(filePath, 'not-regular');
  if (before.size > maxBytes) throw new BoundedReadError(filePath, 'too-large', before.size);
  const handle = await fs.open(filePath, OPEN_FLAGS);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new BoundedReadError(filePath, 'not-regular');
    if (st.size > maxBytes) throw new BoundedReadError(filePath, 'too-large', st.size);
    // One byte past the cap tells a file that grew since the fstat from one
    // that is exactly at it.
    const buf = Buffer.alloc(Math.min(maxBytes + 1, Math.max(st.size, 0) + 64 * 1024));
    let total = 0;
    let chunk = buf;
    for (;;) {
      if (total === chunk.length) {
        if (chunk.length > maxBytes) break;
        const bigger = Buffer.alloc(Math.min(maxBytes + 1, chunk.length * 2));
        chunk.copy(bigger, 0, 0, total);
        chunk = bigger;
      }
      const { bytesRead } = await handle.read(chunk, total, chunk.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new BoundedReadError(filePath, 'too-large', total);
    return { bytes: chunk.subarray(0, total), mode: st.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

/**
 * The last `maxBytes` of the regular file at `filePath` as text, from the
 * first line that starts inside them (a line the bound cuts is dropped), or
 * undefined when nothing is there. Bounded so a file grown past what its
 * writer keeps is never loaded whole. Anything other than a regular file
 * (checked before a non-blocking open, so a FIFO cannot block it, and again
 * on the descriptor) rejects with an `EINVAL` error, and any other read error
 * rejects as it is. The voice history writer (src/voice/history.ts) and its
 * reader in `lexicon suggest` (src/core/suggestTerms.ts) share it, with one
 * bound, so both see the same newest entries.
 */
export async function readRegularFileTail(filePath: string, maxBytes: number): Promise<string | undefined> {
  let handle: fs.FileHandle;
  try {
    if (!(await fs.stat(filePath)).isFile()) throw notRegular(filePath);
    handle = await fs.open(filePath, OPEN_FLAGS);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw notRegular(filePath);
    const length = Math.min(st.size, maxBytes);
    const start = st.size - length;
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await handle.read(buf, got, length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    let bytes = buf.subarray(0, got);
    if (start > 0) {
      const nl = bytes.indexOf(0x0a);
      bytes = nl === -1 ? Buffer.alloc(0) : bytes.subarray(nl + 1);
    }
    return bytes.toString('utf8');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function notRegular(filePath: string): Error {
  return Object.assign(new Error(`${filePath} is not a regular file`), { code: 'EINVAL' });
}
