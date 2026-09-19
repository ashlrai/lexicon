/**
 * Google Cloud Speech-to-Text model adaptation: one phrase set, boost 20 for
 * brand/person/product (what STT gets wrong most), 10 for everything else.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { isProperNounCategory, sortByImportance } from './shared.js';

export function exportGoogle(lexicon: Lexicon, _opts: ExportOptions = {}): string {
  const phrases = sortByImportance(lexicon.terms).map((t) => ({
    value: t.canonical,
    boost: isProperNounCategory(t.category) ? 20 : 10,
  }));
  return JSON.stringify({ adaptation: { phraseSets: [{ phrases }] } }, null, 2) + '\n';
}
