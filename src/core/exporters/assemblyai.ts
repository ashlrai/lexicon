/**
 * AssemblyAI custom vocabulary: `word_boost` list of canonicals with `boost_param`.
 *
 * AssemblyAI takes at most 1,000 `word_boost` entries; a longer list fails
 * the request rather than boosting the first thousand. The most important
 * canonicals (sortByImportance) are kept, so a large lexicon still exports a
 * list the API accepts.
 *
 * Each entry may hold at most 6 words (AssemblyAI's documented per-phrase
 * limit, as last read; not confirmed offline). A canonical with more is left
 * out rather than sent, since the API refuses or ignores it, and is named in
 * a note. Words are runs separated by whitespace.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { canonicalList, quotedNames, sortByImportance } from './shared.js';

export const ASSEMBLYAI_WORD_BOOST_MAX = 1000;
export const ASSEMBLYAI_PHRASE_MAX_WORDS = 6;

export function exportAssemblyai(lexicon: Lexicon, _opts: ExportOptions = {}, notes?: string[]): string {
  const tooLong: string[] = [];
  const overCap: string[] = [];
  const word_boost: string[] = [];
  for (const { canonical } of canonicalList(sortByImportance(lexicon.terms))) {
    if (canonical.trim().split(/\s+/u).length > ASSEMBLYAI_PHRASE_MAX_WORDS) tooLong.push(canonical);
    else if (word_boost.length >= ASSEMBLYAI_WORD_BOOST_MAX) overCap.push(canonical);
    else word_boost.push(canonical);
  }
  if (tooLong.length > 0) {
    notes?.push(`left out ${tooLong.length} phrase${tooLong.length === 1 ? '' : 's'} over AssemblyAI's ${ASSEMBLYAI_PHRASE_MAX_WORDS} words per phrase: ${quotedNames(tooLong)}`);
  }
  if (overCap.length > 0) {
    notes?.push(`left out ${overCap.length} phrase${overCap.length === 1 ? '' : 's'} past AssemblyAI's ${ASSEMBLYAI_WORD_BOOST_MAX} word_boost entries (the most used kept): ${quotedNames(overCap)}`);
  }
  return JSON.stringify({ word_boost, boost_param: 'high' }, null, 2) + '\n';
}
