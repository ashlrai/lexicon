/** Azure Speech PhraseListGrammar: `phraseList` of canonicals. */
import type { ExportOptions, Lexicon } from '../types.js';
import { sortByImportance } from './shared.js';

export function exportAzure(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const phraseList = sortByImportance(lexicon.terms).map((t) => t.canonical);
  return JSON.stringify({ phraseList }, null, 2) + '\n';
}
