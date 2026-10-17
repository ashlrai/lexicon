/**
 * Superwhisper replacements: JSON array of `{ original, replacement }`, or an
 * object wrapping that array under `replacements`. `original` is what STT
 * wrote (the alias), `replacement` what the user wants (the canonical).
 */
import { isRecord, rowFor } from './shared.js';
import type { RawImport } from './shared.js';

export function looksLikeSuperwhisper(value: unknown): boolean {
  const list = Array.isArray(value) ? value : isRecord(value) ? value.replacements : undefined;
  return (
    Array.isArray(list) &&
    (list.length === 0 || list.some((e) => isRecord(e) && 'original' in e && 'replacement' in e))
  );
}

export function parseSuperwhisperImport(content: string): RawImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`superwhisper: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.replacements : undefined;
  if (!Array.isArray(list)) {
    throw new Error('superwhisper: expected a JSON array of { original, replacement } (or { replacements: [...] })');
  }
  const out: RawImport = { rows: [], skipped: [] };
  list.forEach((entry: unknown, i) => {
    const line = i + 1;
    if (!isRecord(entry)) {
      out.skipped.push({ line, reason: 'entry is not an object' });
      return;
    }
    const replacement = typeof entry.replacement === 'string' ? entry.replacement : '';
    if (!replacement.trim()) {
      out.skipped.push({ line, reason: 'empty canonical' });
      return;
    }
    // Without a usable `original` the entry maps nothing: importing the
    // replacement alone would add a term the file never asked for.
    if (typeof entry.original !== 'string' || !entry.original.trim()) {
      out.skipped.push({ line, reason: typeof entry.original === 'string' ? 'empty `original`' : 'entry has no string `original`' });
      return;
    }
    const { row, skip } = rowFor(line, replacement, [entry.original]);
    if (row) out.rows.push(row);
    if (skip) out.skipped.push(skip);
  });
  return out;
}
