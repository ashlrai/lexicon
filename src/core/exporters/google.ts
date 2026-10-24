/**
 * Google Cloud Speech-to-Text model adaptation: one phrase set, boost 20 for
 * brand/person/product (what STT gets wrong most), 10 for everything else.
 *
 * Google's content limits for adaptation, as last read (not confirmed
 * offline, so the caps below are conservative): at most 100 characters per
 * phrase and a few thousand phrases per request. A request over a limit is
 * refused whole, so a phrase longer than GOOGLE_PHRASE_MAX_CHARS is left out
 * and the list stops at GOOGLE_PHRASES_MAX, most important first, each with a
 * note naming what was dropped.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { canonicalList, isProperNounCategory, quotedNames, sortByImportance } from './shared.js';
import type { ExportSink } from './shared.js';

/** Characters a phrase may hold (Google documents 100). Counted in code points. */
export const GOOGLE_PHRASE_MAX_CHARS = 100;
/** Phrases written in the phrase set: below the per-request phrase limit Google documents (5,000 as last read). */
export const GOOGLE_PHRASES_MAX = 1000;

export function exportGoogle(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const tooLong: string[] = [];
  const overCap: string[] = [];
  const phrases: { value: string; boost: number }[] = [];
  for (const { term, canonical } of canonicalList(sortByImportance(lexicon.terms))) {
    if ([...canonical].length > GOOGLE_PHRASE_MAX_CHARS) {
      tooLong.push(canonical);
      continue;
    }
    if (phrases.length >= GOOGLE_PHRASES_MAX) {
      overCap.push(canonical);
      continue;
    }
    phrases.push({ value: canonical, boost: isProperNounCategory(term.category) ? 20 : 10 });
  }
  if (tooLong.length > 0) {
    sink?.notes.push(`left out ${tooLong.length} phrase${tooLong.length === 1 ? '' : 's'} over Google's ${GOOGLE_PHRASE_MAX_CHARS} characters per phrase: ${quotedNames(tooLong)}`);
  }
  if (overCap.length > 0) {
    sink?.notes.push(`left out ${overCap.length} phrase${overCap.length === 1 ? '' : 's'} past the ${GOOGLE_PHRASES_MAX} kept (the most used; a conservative cap under Google's phrase limit): ${quotedNames(overCap)}`);
  }
  return JSON.stringify({ adaptation: { phraseSets: [{ phrases }] } }, null, 2) + '\n';
}
