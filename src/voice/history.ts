/**
 * `<dirname(globalPath)>/voice/history.jsonl`: one line per transcription,
 * `{ at, raw, output, model, ms }`. Raw-vs-output pairs are the raw material
 * for suggesting aliases later. Capped at HISTORY_MAX_LINES and
 * HISTORY_MAX_BYTES (oldest dropped), written under a file lock.
 * The file holds everything the user dictated, so it is written 0600 inside
 * the 0700 voice directory (see recorder.ts).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withFileLock } from '../util/atomic.js';
import { ensureVoiceDir, voiceDir, writePrivateFile } from './recorder.js';

export const HISTORY_MAX_LINES = 1000;

/**
 * Most bytes the history file keeps: 4 MiB. The line cap alone did not bound
 * it: one ten-minute dictation is a line of tens of kilobytes (raw and
 * output), so a thousand of them made a file of tens of megabytes that every
 * dictation read and rewrote whole. Past the cap the oldest lines go first;
 * the newest entry is always kept.
 */
export const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

/**
 * How long an append waits for another writer's lock on the history file
 * before giving up on the entry (history is best-effort). Two dictations
 * finishing together (a `--toggle` press and a foreground `lexicon voice` in
 * another terminal) each read the file, added their line and wrote it back,
 * so one of the two entries was lost.
 */
export const HISTORY_LOCK_TIMEOUT_MS = 2000;

/** A parsed history line, or undefined for one that is truncated, foreign or not an entry. */
function entryOf(line: string): HistoryEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const v = parsed as Record<string, unknown>;
  if (typeof v.raw !== 'string' || typeof v.output !== 'string') return undefined;
  return parsed as HistoryEntry;
}

export interface HistoryEntry {
  at: string;
  raw: string;
  output: string;
  model: string;
  ms: { record: number; transcribe: number; normalize: number };
}

export function historyPath(globalPath: string): string {
  return path.join(voiceDir(globalPath), 'history.jsonl');
}

/**
 * Append one entry under the file's lock, keeping at most `max` lines and
 * HISTORY_MAX_BYTES (oldest dropped first). Lines that do not parse as an
 * entry (a line cut short by a crash or a full disk, or text another program
 * wrote) are dropped rather than carried forward: readers skip them anyway,
 * and they took up room under the line cap. Never throws (history is
 * best-effort).
 */
export async function appendHistory(globalPath: string, entry: HistoryEntry, max: number = HISTORY_MAX_LINES): Promise<void> {
  const file = historyPath(globalPath);
  try {
    await ensureVoiceDir(globalPath);
    await withFileLock(
      file,
      async () => {
        // Only a missing file is an empty history. Any other read error (EIO,
        // EACCES, a directory in the way) was taken as empty too, and the
        // write below then replaced every earlier entry with this one. The
        // entry is dropped instead (history is best-effort); the file is kept.
        let existing = '';
        try {
          existing = await fs.readFile(file, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        const lines = existing.split('\n').filter((l) => l.length > 0 && entryOf(l) !== undefined);
        lines.push(JSON.stringify(entry));
        let kept = lines.length > max ? lines.slice(lines.length - max) : lines;
        let bytes = kept.reduce((n, l) => n + Buffer.byteLength(l, 'utf8') + 1, 0);
        let drop = 0;
        while (bytes > HISTORY_MAX_BYTES && drop < kept.length - 1) {
          bytes -= Buffer.byteLength(kept[drop], 'utf8') + 1;
          drop += 1;
        }
        if (drop > 0) kept = kept.slice(drop);
        await writePrivateFile(file, `${kept.join('\n')}\n`);
      },
      { timeoutMs: HISTORY_LOCK_TIMEOUT_MS },
    );
  } catch {
    // best-effort
  }
}

/** Read the history (most recent last); lines that are malformed or not an entry are skipped. */
export async function readHistory(globalPath: string): Promise<HistoryEntry[]> {
  try {
    const text = await fs.readFile(historyPath(globalPath), 'utf8');
    const out: HistoryEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      const entry = entryOf(line);
      if (entry) out.push(entry);
    }
    return out;
  } catch {
    return [];
  }
}
