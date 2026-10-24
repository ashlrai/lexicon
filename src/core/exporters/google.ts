/**
 * Google Cloud Speech-to-Text model adaptation: one phrase set, boost 20 for
 * brand/person/product (what STT gets wrong most), 10 for everything else.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { canonicalList, isProperNounCategory, sortByImportance } from './shared.js';

export function exportGoogle(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const phrases = canonicalList(sortByImportance(lexicon.terms)).map(({ term, canonical }) => ({
    value: canonical,
    boost: isProperNounCategory(term.category) ? 20 : 10,
  }));
  return JSON.stringify({ adaptation: { phraseSets: [{ phrases }] } }, null, 2) + '\n';
}
