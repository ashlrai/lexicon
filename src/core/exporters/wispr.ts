/** Wispr Flow dictionary import: CSV `word,replacement`, one row per alias. */
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs, csvField } from './shared.js';

export function exportWispr(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const lines = ['word,replacement'];
  for (const { alias, canonical } of aliasPairs(lexicon)) {
    lines.push(`${csvField(alias)},${csvField(canonical)}`);
  }
  return lines.join('\n') + '\n';
}
