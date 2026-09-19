/** Raw lexicon as pretty-printed JSON. */
import type { ExportOptions, Lexicon } from '../types.js';

export function exportJson(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  return JSON.stringify(lexicon, null, 2) + '\n';
}
