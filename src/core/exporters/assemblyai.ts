/**
 * AssemblyAI custom vocabulary: `word_boost` list of canonicals with `boost_param`.
 *
 * AssemblyAI takes at most 1,000 `word_boost` entries; a longer list fails
 * the request rather than boosting the first thousand. The most important
 * canonicals (sortByImportance) are kept, so a large lexicon still exports a
 * list the API accepts.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { canonicalList, sortByImportance } from './shared.js';

export const ASSEMBLYAI_WORD_BOOST_MAX = 1000;

export function exportAssemblyai(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const word_boost = canonicalList(sortByImportance(lexicon.terms))
    .slice(0, ASSEMBLYAI_WORD_BOOST_MAX)
    .map((c) => c.canonical);
  return JSON.stringify({ word_boost, boost_param: 'high' }, null, 2) + '\n';
}
