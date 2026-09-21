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

/**
 * Markdown's other code block: a run of lines indented four columns past
 * whatever contains them. Nothing else here matches it, so a bug report that
 * pasted its repro as an indented block had the repro corrected out of
 * existence.
 *
 * Deliberately narrower than CommonMark, because the two ways of being wrong
 * are not equally bad. Skipping too little leaves a correction somewhere it was
 * not wanted, and you can see it. Skipping too much silently stops correcting
 * ordinary prose, and you cannot. So a run is a code block only when
 *   - a blank line comes directly above it, since four spaces in the middle of
 *     a paragraph is a wrapped line, not code;
 *   - a non-blank line comes above that one. Text that simply begins indented
 *     is prose. CommonMark would call the whole of it code, which is right for
 *     a document and wrong for what this actually reads: a clipboard paste, a
 *     dictated transcript, a prompt;
 *   - the run is indented four columns past its container, where the container
 *     is the block quote it sits in and the list item it hangs under. A list
 *     item's indented continuation and a nested bullet are list content and
 *     stay ordinary text, while the repro under "1. Run this:" or "> Run this:"
 *     is code, which is the shape a bug report's repro usually has;
 *   - at least one of its lines is not itself a list item or a table row, since
 *     a run of nothing but bullets is a list someone indented. The run decides
 *     this together: judging it by its opening line alone meant one
 *     bullet-looking first line (a pasted diff, a shell flag, numbered output)
 *     left every line under it exposed, and made the answer depend on the order
 *     the lines happened to be in.
 * It runs to the first non-blank line indented less than that; a blank line
 * inside it does not end it.
 *
 * Not covered, and still corrected: a run hanging under a table row, and one
 * whose quote depth differs from the line above it.
 */
const INDENT_UNIT = 4;
/** Leading `>` markers: everything after them is inside a block quote. */
const QUOTE_PREFIX_RE = /^ {0,3}(?:>[ \t]?)+/;
/**
 * A list item marker and the space after it. Bullets and numbers, plus the
 * lettered and roman markers an outline uses (`a)`, `i.`, `iv)`), because a
 * continuation indented under one of those is list content just as much as a
 * continuation under `1.` is.
 */
const LIST_MARKER_RE = /^(?:[-*+]|(?:\d{1,9}|[A-Za-z]|[ivxlcdm]{2,}|[IVXLCDM]{2,})[.)])(?:[ \t]+|$)/;

interface LineInfo {
  readonly start: number;
  readonly end: number;
  readonly blank: boolean;
  readonly quoteDepth: number;
  /** Columns of indent after the block quote prefix; a tab advances to the next multiple of four. */
  readonly indent: number;
  /** Columns this line's list marker indents its own content by, 0 when it opens no item. */
  readonly listWidth: number;
  readonly tableRow: boolean;
}

function indentWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (ch === ' ') w++;
    else if (ch === '\t') w += INDENT_UNIT - (w % INDENT_UNIT);
    else break;
  }
  return w;
}

function listMarkerWidth(content: string): number {
  const m = LIST_MARKER_RE.exec(content);
  if (!m) return 0;
  // A marker alone on its line ("-") still indents the item's content by one.
  return /[ \t]$/.test(m[0]) ? m[0].length : m[0].length + 1;
}

function scanLine(raw: string, start: number): LineInfo {
  const prefix = QUOTE_PREFIX_RE.exec(raw)?.[0] ?? '';
  const body = raw.slice(prefix.length);
  const content = body.replace(/^[ \t]+/, '');
  return {
    start,
    end: start + raw.length,
    blank: content.trim().length === 0,
    quoteDepth: prefix.split('>').length - 1,
    indent: indentWidth(body),
    listWidth: listMarkerWidth(content),
    tableRow: content.startsWith('|'),
  };
}

export function indentedCodeRanges(text: string): Range[] {
  const lines: LineInfo[] = [];
  let at = 0;
  for (const raw of text.split('\n')) {
    lines.push(scanLine(raw, at));
    at += raw.length + 1;
  }

  const out: Range[] = [];
  /** Nearest non-blank line above the one being looked at. */
  let above: LineInfo | undefined;
  let prevBlank = true;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.blank) {
      prevBlank = true;
      i++;
      continue;
    }
    // Columns the line above indents its content to; undefined when nothing
    // above it can hold a code block at all.
    const container =
      prevBlank && above !== undefined && above.quoteDepth === line.quoteDepth && !above.tableRow
        ? above.indent + above.listWidth
        : undefined;
    if (container === undefined || line.indent < container + INDENT_UNIT) {
      prevBlank = false;
      above = line;
      i++;
      continue;
    }

    const min = container + INDENT_UNIT;
    let last = i;
    let allList = true;
    for (let j = i; j < lines.length; j++) {
      const l = lines[j];
      if (l.blank) continue;
      if (l.quoteDepth !== line.quoteDepth || l.indent < min) break;
      if (l.listWidth === 0 && !l.tableRow) allList = false;
      last = j;
    }
    if (!allList) out.push({ start: lines[i].start, end: lines[last].end });
    above = lines[last];
    prevBlank = false;
    i = last + 1;
  }
  return out;
}

export function collectRanges(text: string): Range[] {
  const ranges: Range[] = indentedCodeRanges(text);
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
