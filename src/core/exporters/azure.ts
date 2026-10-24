/**
 * Azure Speech PhraseListGrammar: `phraseList` of canonicals.
 *
 * Azure documents a phrase list of up to 500 phrases (as last read, not
 * confirmed offline); past that the list may be refused or ignored. The list
 * stops at AZURE_PHRASES_MAX, most important first, with a note naming the
 * phrases left out.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { canonicalList, quotedNames, sortByImportance } from './shared.js';
import type { ExportSink } from './shared.js';

export const AZURE_PHRASES_MAX = 500;

export function exportAzure(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const all = canonicalList(sortByImportance(lexicon.terms)).map((c) => c.canonical);
  const phraseList = all.slice(0, AZURE_PHRASES_MAX);
  const dropped = all.slice(AZURE_PHRASES_MAX);
  if (dropped.length > 0) {
    sink?.notes.push(`left out ${dropped.length} phrase${dropped.length === 1 ? '' : 's'} past the ${AZURE_PHRASES_MAX} kept (the most used; the phrase list size Azure documents): ${quotedNames(dropped)}`);
  }
  return JSON.stringify({ phraseList }, null, 2) + '\n';
}
