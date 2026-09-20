/**
 * Atomic file writes: write a sibling temp file, then rename it over the
 * target. A reader either sees the old file or the new one, never a half
 * written one, and a crash mid-write leaves the original intact. Used for
 * every file this tool owns and rewrites in place (the lexicon YAML, the
 * trust registry, serve.json, the recorder state).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
}

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
  await fs.rename(tmp, target);
}
