/** Superwhisper replacements: JSON array of { original, replacement }. */
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs } from './shared.js';
import type { ExportSink } from './shared.js';

export function exportSuperwhisper(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const entries = aliasPairs(lexicon).map(({ alias, canonical }) => ({
    original: alias,
    replacement: canonical,
  }));
  if (sink) sink.rows = entries.length;
  return JSON.stringify(entries, null, 2) + '\n';
}
