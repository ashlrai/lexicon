/**
 * Deepgram keyword boosting: { "keywords": ["term:boost", ...] }.
 * Only canonicals are listed (keywords bias recognition toward the correct
 * spelling); brand/person/product get boost 2, everything else 1.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { isProperNounCategory, sortByImportance } from './shared.js';

export function exportDeepgram(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const keywords = sortByImportance(lexicon.terms).map(
    (t) => `${t.canonical}:${isProperNounCategory(t.category) ? 2 : 1}`,
  );
  return JSON.stringify({ keywords }, null, 2) + '\n';
}
