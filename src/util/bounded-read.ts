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
