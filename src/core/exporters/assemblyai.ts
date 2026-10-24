/** AssemblyAI custom vocabulary: `word_boost` list of canonicals with `boost_param`. */
import type { ExportOptions, Lexicon } from '../types.js';
import { canonicalList, sortByImportance } from './shared.js';

export function exportAssemblyai(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const word_boost = canonicalList(sortByImportance(lexicon.terms)).map((c) => c.canonical);
  return JSON.stringify({ word_boost, boost_param: 'high' }, null, 2) + '\n';
}
