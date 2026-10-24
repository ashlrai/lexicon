/**
 * Deepgram keyword boosting: { "keywords": ["term:boost", ...] }.
 * Only canonicals are listed (keywords bias recognition toward the correct
 * spelling); brand/person/product get boost 2, everything else 1.
 *
 * The format has no escape for a colon, which separates a keyword from its
 * boost, so a canonical holding one (`Win:2`) would read as another keyword
 * and boost. A colon is never spoken, so it becomes a space (`Win 2:1`),
 * whitespace collapsed; a canonical with nothing else in it is left out.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { isProperNounCategory, sortByImportance } from './shared.js';

export function exportDeepgram(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const keywords: string[] = [];
  for (const t of sortByImportance(lexicon.terms)) {
    const keyword = t.canonical.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
    if (keyword) keywords.push(`${keyword}:${isProperNounCategory(t.category) ? 2 : 1}`);
  }
  return JSON.stringify({ keywords }, null, 2) + '\n';
}
