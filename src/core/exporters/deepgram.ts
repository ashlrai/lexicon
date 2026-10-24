/**
 * Deepgram: `{ "keyterm": [...], "keywords": ["term:boost", ...] }`, one
 * list per model family, canonicals only (both bias recognition toward the
 * correct spelling).
 *
 * `keyterm` is the default to use: Nova-3, Deepgram's current model, takes
 * only Keyterm Prompting (`keyterm=` once per entry) and refuses or ignores
 * `keywords`. It holds the canonicals as written (a colon is fine there), at
 * most DEEPGRAM_KEYTERM_MAX, most important first: Deepgram documents a cap
 * on keyterms per request (as last read, not confirmed offline), so the
 * conservative 100 is used and the rest are named in a note.
 *
 * `keywords` is for Nova-2 and older models (`keywords=term:boost`);
 * brand/person/product get boost 2, everything else 1. The format has no
 * escape for a colon, which separates a keyword from its boost, so a
 * canonical holding one (`Win:2`) would read as another keyword and boost. A
 * colon is never spoken, so it becomes a space (`Win 2:1`), whitespace
 * collapsed; a canonical with nothing else in it is left out, with a note, and one that
 * then reads as a keyword already listed (`Win:2` next to `Win 2`) is written
 * once, for the more important term, with a note.
 */
import type { ExportOptions, Lexicon } from '../types.js';
import { canonicalList, isProperNounCategory, quotedNames, sortByImportance } from './shared.js';
import type { ExportSink } from './shared.js';

export const DEEPGRAM_KEYTERM_MAX = 100;

export function exportDeepgram(lexicon: Lexicon, _opts: ExportOptions = {}, sink?: ExportSink): string {
  const ordered = canonicalList(sortByImportance(lexicon.terms));
  // Whitespace collapsed, then each keyterm once: two canonicals that differ
  // only in whitespace (`Ashlr  AI`, `Ashlr AI`, a no-break space) were each
  // sent, as the same keyterm, and took a place under the cap.
  const keyterm: string[] = [];
  const keytermSeen = new Set<string>();
  const keytermRepeats: string[] = [];
  const overCap: string[] = [];
  for (const { canonical } of ordered) {
    const k = canonical.replace(/\s+/g, ' ').trim();
    if (!k) continue;
    if (keytermSeen.has(k)) {
      keytermRepeats.push(canonical);
      continue;
    }
    keytermSeen.add(k);
    if (keyterm.length < DEEPGRAM_KEYTERM_MAX) keyterm.push(k);
    else overCap.push(canonical);
  }
  const keywords: string[] = [];
  const seen = new Set<string>();
  const collided: string[] = [];
  const onlyColons: string[] = [];
  for (const { term, canonical } of ordered) {
    const keyword = canonical.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
    if (!keyword) {
      onlyColons.push(canonical);
      continue;
    }
    if (seen.has(keyword)) {
      collided.push(canonical);
      continue;
    }
    seen.add(keyword);
    keywords.push(`${keyword}:${isProperNounCategory(term.category) ? 2 : 1}`);
  }
  if (overCap.length > 0) {
    sink?.notes.push(`left out ${overCap.length} name${overCap.length === 1 ? '' : 's'} from keyterm past the ${DEEPGRAM_KEYTERM_MAX} kept (the most used; a conservative cap for Nova-3 keyterms): ${quotedNames(overCap)}`);
  }
  if (keytermRepeats.length > 0) {
    sink?.notes.push(`left out ${keytermRepeats.length} name${keytermRepeats.length === 1 ? '' : 's'} from keyterm that read as one already listed once whitespace is collapsed: ${quotedNames(keytermRepeats)}`);
  }
  if (onlyColons.length > 0) {
    sink?.notes.push(`left out ${onlyColons.length} name${onlyColons.length === 1 ? '' : 's'} from keywords that hold nothing but colons and whitespace (a colon becomes a space there): ${quotedNames(onlyColons)}`);
  }
  if (collided.length > 0) {
    sink?.notes.push(`left out ${collided.length} name${collided.length === 1 ? '' : 's'} from keywords that read as one already listed once its colon is a space: ${quotedNames(collided)}`);
  }
  return JSON.stringify({ keyterm, keywords }, null, 2) + '\n';
}
