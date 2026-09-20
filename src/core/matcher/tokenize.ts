/**
 * Splitting input into the tokens the matcher slides its windows over, and
 * working out which character ranges to leave alone: code fences, inline
 * code, URLs, emails and file paths are never rewritten.
 */
import { foldLower } from './text.js';

export interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Token with a trailing possessive ('s / ’s) removed. Same as text when none. */
  readonly base: string;
  readonly baseEnd: number;
  /** `text` / `base` with diacritics folded and lowercased. */
  readonly textLower: string;
  readonly baseLower: string;
  /** True when this token sits inside a code span / URL / email / path. */
  readonly skipped: boolean;
  /** True when the gap between this token and the next is whitespace only. */
  readonly joinsNext: boolean;
}

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu;
const TRAILING_PUNCT_RE = /[.'’\-]+$/u;
const POSSESSIVE_RE = /['’][sS]$/u;

export interface Range {
  readonly start: number;
  readonly end: number;
}

const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const URL_RE = /\b(?:https?|ftp):\/\/\S+/gi;
const WWW_RE = /\bwww\.\S+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/**
 * A file path or a `scope/name` slug: a token containing `/` with no spaces,
 * starting at a word boundary (`src/core/matcher.ts`, `~/ashlr`, `@ashlr/lexicon`,
 * `ashlrai/lexicon`, `github.com/ashlrai/lexicon`). No file extension is
 * required: a repo or package slug is a typed identifier just as a path is.
 * `and/or` also qualifies, harmlessly; a slash with spaces around it does not.
 */
const PATH_RE = /(?:^|(?<=\s|[("'\[]))(?:~|\.{1,2}|@)?[\w.~-]*(?:\/[\w.\-]+)+/g;

export function collectRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const re of [FENCE_RE, INLINE_CODE_RE, URL_RE, WWW_RE, EMAIL_RE, PATH_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      ranges.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

export function tokenize(text: string, skipCode: boolean): Token[] {
  const ranges = skipCode ? collectRanges(text) : [];
  const tokens: Token[] = [];
  const draft: Array<Omit<Token, 'joinsNext'>> = [];
  let rangeIdx = 0;

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    let raw = m[0];
    const start = m.index;
    const trimmed = raw.replace(TRAILING_PUNCT_RE, '');
    if (trimmed.length === 0) continue;
    raw = trimmed;
    const end = start + raw.length;

    // Advance past ranges that end before this token, then test intersection.
    while (rangeIdx < ranges.length && ranges[rangeIdx].end <= start) rangeIdx++;
    let skipped = false;
    for (let i = rangeIdx; i < ranges.length && ranges[i].start < end; i++) {
      if (ranges[i].end > start) {
        skipped = true;
        break;
      }
    }

    let base = raw;
    if (POSSESSIVE_RE.test(raw) && raw.length > 2) {
      base = raw.slice(0, -2);
    }
    draft.push({
      text: raw,
      start,
      end,
      base,
      baseEnd: start + base.length,
      textLower: foldLower(raw),
      baseLower: foldLower(base),
      skipped,
    });
  }

  for (let i = 0; i < draft.length; i++) {
    const t = draft[i];
    const next = draft[i + 1];
    const joinsNext = next !== undefined && /^\s+$/.test(text.slice(t.end, next.start));
    tokens.push({ ...t, joinsNext });
  }
  return tokens;
}
