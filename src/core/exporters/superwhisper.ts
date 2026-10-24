/**
 * Superwhisper replacements: JSON array of { original, replacement }.
 *
 * Two terms sharing an alias wrote two entries for one `original`, and
 * Superwhisper then replaces it with either. The term `uniqueTriggers` ranks
 * first keeps it (compared as written: whether Superwhisper ignores case is
 * not confirmed offline); the other is named in a note.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs, sharedTriggerNote, uniqueTriggers } from './shared.js';
import type { ExportSink } from './shared.js';

export function exportSuperwhisper(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const { kept, dropped } = uniqueTriggers(aliasPairs(lexicon));
  const shared = sharedTriggerNote(dropped, 'replacement');
  if (shared) sink?.notes.push(shared);
  const entries = kept.map(({ alias, canonical }) => ({
    original: alias,
    replacement: canonical,
  }));
  if (sink) sink.rows = entries.length;
  return JSON.stringify(entries, null, 2) + '\n';
}
