/** Doctor inspects declarations, not arbitrary files or execution readiness.
 * Configs over 1 MiB and file symlinks are deliberately left unconfirmed.
 * Finite regular-file reads bound allocation; they do not promise a wall-clock
 * bound for operating-system metadata or a slow regular filesystem. */
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { isEnoent } from '../util/errors.js';
import type { JsonFileRead } from '../util/json.js';
import { parseJsonc } from '../util/jsonc.js';

export const DOCTOR_CONFIG_MAX_BYTES = 1024 * 1024;
export type DoctorConfigRead = { status: 'read'; text: string }
  | { status: 'missing' }
  | { status: 'unconfirmed'; reason: 'nonregular' | 'too-large' | 'changed' | 'invalid-utf8' | 'unreadable' };
const same = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid
  && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Only an initial ENOENT is absence. Every later uncertainty is refused. */
export async function readDoctorConfigText(file: string): Promise<DoctorConfigRead> {
  let inspected = false;
  let handle: FileHandle | undefined;
  try {
    const before = await fs.lstat(file, { bigint: true });
    inspected = true;
    if (!before.isFile() || before.isSymbolicLink()) return { status: 'unconfirmed', reason: 'nonregular' };
    if (before.size > BigInt(DOCTOR_CONFIG_MAX_BYTES)) return { status: 'unconfirmed', reason: 'too-large' };
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
    handle = await fs.open(file, constants.O_RDONLY | noFollow | nonBlock);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !same(before, opened)) return { status: 'unconfirmed', reason: 'changed' };
      // One extra byte detects growth without ever allocating the grown size.
      const size = Number(opened.size);
      const bytes = Buffer.alloc(size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== size || !same(opened, await handle.stat({ bigint: true }))
        || !same(opened, await fs.lstat(file, { bigint: true }))) return { status: 'unconfirmed', reason: 'changed' };
      // Preserve readFile('utf8') text semantics, including its initial BOM.
      try { return { status: 'read', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)) }; }
      catch { return { status: 'unconfirmed', reason: 'invalid-utf8' }; }
    } finally {
      await handle.close();
      handle = undefined;
    }
  } catch (error) {
    // Fixed reasons never expose a credential, content fragment or home path.
    return !inspected && isEnoent(error) ? { status: 'missing' } : { status: 'unconfirmed', reason: 'unreadable' };
  }
}

/** Preserve the existing empty-JSON and absent-file interfaces for Doctor only. */
export async function readDoctorConfigJson(file: string): Promise<JsonFileRead> {
  const read = await readDoctorConfigText(file);
  if (read.status === 'missing') return { exists: false };
  if (read.status === 'unconfirmed') return { exists: true, error: read.reason };
  try { return { exists: true, value: read.text.trim() === '' ? {} : parseJsonc(read.text) }; }
  catch { return { exists: true, error: 'invalid-json' }; }
}
