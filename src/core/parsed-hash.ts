/**
 * The sha256 of the exact bytes a project `LexiconFile` was parsed from (or
 * last written as), kept beside the object rather than on it.
 *
 * The trust gate compares a project file with the hash pinned in
 * `trust.json`. It used to hash the file with a second read, after the parse,
 * so what was merged and what was checked were two different reads: a file
 * rewritten in between (a `git checkout`, a sync client, or anyone else who
 * can write it, such as another account on a shared machine) was merged with
 * contents nobody approved, because the bytes that were hashed were the
 * approved ones. Hashing the parsed bytes closes that window, and the trust
 * commands pin the very bytes their preview showed.
 *
 * A WeakMap rather than a field: `LexiconFile` objects are compared, spread
 * and serialized all over the codebase, and a copy simply has no entry, which
 * falls back to hashing the file on disk (the old behaviour). Internal to
 * core: `parsedContentHash` in trust.ts is the public reader.
 */
import type { LexiconFile } from './types.js';

/** The bytes, until someone asks for their hash; then the hash. */
const entries = new WeakMap<LexiconFile, { bytes?: Uint8Array | string; sha256?: string }>();

/** Hex sha256 of `bytes`. node:crypto is loaded on first use (see trust.ts hashFile). */
export async function sha256OfBytes(bytes: Uint8Array | string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Remember the bytes `file` was parsed from (or written as). Hashed only when
 * asked: the prompt hook reads an untrusted project file on every prompt and
 * never needs its hash, and loading node:crypto costs it several ms.
 */
export function rememberParsedBytes(file: LexiconFile, bytes: Uint8Array | string): void {
  entries.set(file, { bytes });
}

/**
 * Remember `sha256` as the hash of the bytes `file` was parsed from, when the
 * caller already holds it for exactly those bytes (the project parse cache in
 * store.ts, whose entry is reused only for byte-identical content).
 */
export function rememberParsedHash(file: LexiconFile, sha256: string): void {
  entries.set(file, { sha256 });
}

export async function recalledParsedHash(file: LexiconFile): Promise<string | undefined> {
  const entry = entries.get(file);
  if (!entry) return undefined;
  if (entry.sha256 === undefined && entry.bytes !== undefined) {
    entry.sha256 = await sha256OfBytes(entry.bytes);
    delete entry.bytes;
  }
  return entry.sha256;
}
