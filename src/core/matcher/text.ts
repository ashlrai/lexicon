/**
 * String shaping for the matcher: folding a word down to something two
 * spellings of the same name agree on, its double-metaphone key, and the
 * bounded edit distance the fuzzy pass scores with. Pure, no lexicon
 * knowledge, no IO.
 */
import { doubleMetaphone } from 'double-metaphone';
import { distance } from 'fastest-levenshtein';

/**
 * Letters with no NFD decomposition that STT still writes as plain ASCII.
 * Everything else (ó, ü, ñ, ...) is handled by stripping combining marks.
 */
const ASCII_FOLD: Readonly<Record<string, string>> = {
  ø: 'o', Ø: 'O', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th',
  ß: 'ss', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ı: 'i',
};
const ASCII_FOLD_RE = /[øØłŁđĐðÐþÞßæÆœŒı]/g;
const NON_ASCII_RE = /[^\x00-\x7f]/;

/** Diacritics stripped (NFD, combining marks removed, plus ASCII_FOLD): "Bjørn" -> "Bjorn", "Wróblewski" -> "Wroblewski". */
export function foldDiacritics(s: string): string {
  if (!NON_ASCII_RE.test(s)) return s;
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(ASCII_FOLD_RE, (c) => ASCII_FOLD[c] ?? c);
}

/** Diacritics folded and lowercased: the case-insensitive comparison form of the exact and fuzzy passes. */
export function foldLower(s: string): string {
  return foldDiacritics(s).toLowerCase();
}

/** Letters only (diacritics folded), lowercase. */
export function alphaOnly(s: string): string {
  return foldDiacritics(s).replace(/[^\p{L}]+/gu, '').toLowerCase();
}

/** Letters and digits only, diacritics folded, lowercase. Used for "punctuation stripped" comparisons. */
export function collapse(s: string): string {
  return foldLower(s).replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Whitespace collapsed to single spaces, trimmed. */
export function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Double-metaphone primary key of the alpha-only form of `s`. '' when nothing is left. */
export function phoneticKey(s: string): string {
  const alpha = alphaOnly(s);
  if (alpha.length === 0) return '';
  return doubleMetaphone(alpha)[0];
}

/** Longest string for which similarity() uses the transposition-aware distance. */
const OSA_MAX_LENGTH = 40;

/**
 * Optimal string alignment (restricted Damerau-Levenshtein) distance: edits are
 * insert, delete, substitute and swap of two adjacent characters. A typo such
 * as "levenshtien" is one edit away from "levenshtein" here, two under plain
 * Levenshtein. Three rolling rows, O(|a|*|b|).
 */
const OSA_ROWS = [new Int32Array(OSA_MAX_LENGTH + 1), new Int32Array(OSA_MAX_LENGTH + 1), new Int32Array(OSA_MAX_LENGTH + 1)];

export function osaDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev2 = OSA_ROWS[0];
  let prev = OSA_ROWS[1];
  let cur = OSA_ROWS[2];
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const bj = b.charCodeAt(j - 1);
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ai === bj ? 0 : 1));
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur[j] = d;
    }
    const spare = prev2;
    prev2 = prev;
    prev = cur;
    cur = spare;
  }
  return prev[m];
}

/**
 * Normalized edit similarity in 0..1 (1 = identical). Transposition-aware
 * (optimal string alignment) up to OSA_MAX_LENGTH characters, plain
 * Levenshtein via fastest-levenshtein beyond that.
 */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  const d = max <= OSA_MAX_LENGTH ? osaDistance(a, b) : distance(a, b);
  return 1 - d / max;
}
