/**
 * `<dirname(globalPath)>/voice/history.jsonl`: one line per transcription,
 * `{ at, raw, output, model, ms }`. Raw-vs-output pairs are the raw material
 * for suggesting aliases later. Capped at HISTORY_MAX_LINES (oldest dropped).
 * The file holds everything the user dictated, so it is written 0600 inside
 * the 0700 voice directory (see recorder.ts).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureVoiceDir, voiceDir, writePrivateFile } from './recorder.js';

export const HISTORY_MAX_LINES = 1000;

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

/** Append one entry, truncating the oldest lines past `max`. Never throws (history is best-effort). */
export async function appendHistory(globalPath: string, entry: HistoryEntry, max: number = HISTORY_MAX_LINES): Promise<void> {
  const file = historyPath(globalPath);
  try {
    await ensureVoiceDir(globalPath);
    let existing = '';
    try {
      existing = await fs.readFile(file, 'utf8');
    } catch {
      existing = '';
    }
    const lines = existing.split('\n').filter((l) => l.length > 0);
    lines.push(JSON.stringify(entry));
    const kept = lines.length > max ? lines.slice(lines.length - max) : lines;
    await writePrivateFile(file, `${kept.join('\n')}\n`);
  } catch {
    // best-effort
  }
}

/** Read the history (most recent last); malformed lines are skipped. */
export async function readHistory(globalPath: string): Promise<HistoryEntry[]> {
  try {
    const text = await fs.readFile(historyPath(globalPath), 'utf8');
    const out: HistoryEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as HistoryEntry);
      } catch {
        // skip
      }
    }
    return out;
  } catch {
    return [];
  }
}
