/** Generic CSV: canonical,alias,category,phonetic — one row per alias. */
import type { ExportOptions, Lexicon } from '../types.js';
import { aliasPairs, csvField } from './shared.js';

export function exportCsv(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const lines = ['canonical,alias,category,phonetic'];
  for (const { alias, canonical, term } of aliasPairs(lexicon)) {
    lines.push(
      [canonical, alias, term.category ?? '', term.phonetic ?? ''].map(csvField).join(','),
    );
  }
  return lines.join('\n') + '\n';
}
