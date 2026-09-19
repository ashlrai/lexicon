/** Superwhisper replacements: JSON array of { original, replacement }. */
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs } from './shared.js';

export function exportSuperwhisper(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const entries = aliasPairs(lexicon).map(({ alias, canonical }) => ({
    original: alias,
    replacement: canonical,
  }));
  return JSON.stringify(entries, null, 2) + '\n';
}
