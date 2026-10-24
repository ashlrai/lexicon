/** Azure Speech PhraseListGrammar: `phraseList` of canonicals. */
import type { ExportOptions, Lexicon } from '../types.js';
import { canonicalList, sortByImportance } from './shared.js';

export function exportAzure(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const phraseList = canonicalList(sortByImportance(lexicon.terms)).map((c) => c.canonical);
  return JSON.stringify({ phraseList }, null, 2) + '\n';
}
