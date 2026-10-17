/**
 * Plain text, one term per line. Three shapes, `#` full-line comments:
 *
 *   Canonical
 *   Canonical: alias1, alias2
 *   Canonical = alias1 | alias2
 *   Canonical =                 (no aliases, canonical with a colon)
 *
 * The `=` form (space-padded) is checked first so canonicals containing a
 * colon (`Ashlr:AI = ...`) and aliases containing commas survive round trips.
 * The colon of `scheme://` never separates, so a URL line stays one canonical.
 * A canonical that starts with `#` is written `\#...`, so it is not read as a comment.
 * Inside a line a backslash escapes the characters that separate fields:
 * `\=`, `\|`, `\,`, `\:` and `\\` read as `=`, `|`, `,`, `:` and `\`, and
 * an escaped one never separates (`A \= B` is the canonical "A = B"). A
 * backslash before any other character is kept as written.
 * `lexicon export text` writes this format.
 */
import { rowFor } from './shared.js';
import type { RawImport } from './shared.js';

/** A leading `#` escaped with a backslash (or more): see parseTextLine. */
const ESCAPED_HASH = /^\\+#/;
/** Characters a backslash escapes inside a line (exportText escapes them where they would separate). */
const TEXT_ESCAPABLE = '\\|,:=';

/** One character of a line, and whether it was backslash-escaped (an escaped one never separates). */
interface LineChar {
  c: string;
  escaped: boolean;
}

function lexLine(text: string): LineChar[] {
  const out: LineChar[] = [];
  for (let i = 0; i < text.length; i++) {
    const next = text[i + 1];
    if (text[i] === '\\' && next !== undefined && TEXT_ESCAPABLE.includes(next)) {
      out.push({ c: next, escaped: true });
      i++;
    } else {
      out.push({ c: text[i] as string, escaped: false });
    }
  }
  return out;
}

const isSpace = (ch: LineChar | undefined): boolean => ch !== undefined && !ch.escaped && /\s/.test(ch.c);
const isBare = (ch: LineChar | undefined, c: string): boolean => ch !== undefined && !ch.escaped && ch.c === c;
const joined = (chars: readonly LineChar[]): string => chars.map((ch) => ch.c).join('');

/** Split on every unescaped `sep`, trimming each part and dropping empty ones. */
function splitAliases(chars: readonly LineChar[], sep: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i <= chars.length; i++) {
    if (i === chars.length || isBare(chars[i], sep)) {
      parts.push(joined(chars.slice(from, i)).trim());
      from = i + 1;
    }
  }
  return parts.filter(Boolean);
}

export function parseTextLine(raw: string): { canonical: string; aliases: string[] } | undefined {
  let text = raw.trim();
  if (!text) return undefined;
  // `\#hashtag` is the canonical "#hashtag", escaped so it is not a comment;
  // one backslash comes off a leading run of them before `#`, so `\\#x` reads `\#x`.
  if (ESCAPED_HASH.test(text)) text = text.slice(1);
  else if (text.startsWith('#')) return undefined;
  if (text === '=') return { canonical: '', aliases: [] };
  const chars = lexLine(text);
  // The `=` form: the first unescaped `=` with whitespace before it (and text
  // before that) and whitespace or the end of the line after it. Checked
  // first, so canonicals with a colon and aliases with a comma survive.
  for (let k = 2; k < chars.length; k++) {
    if (!isBare(chars[k], '=') || !isSpace(chars[k - 1])) continue;
    if (k === chars.length - 1) return { canonical: joined(chars.slice(0, k)).trim(), aliases: [] };
    if (isSpace(chars[k + 1])) {
      return { canonical: joined(chars.slice(0, k)).trim(), aliases: splitAliases(chars.slice(k + 1), '|') };
    }
  }
  // The separator is the first unescaped colon that does not open
  // `scheme://`: a line that is a URL (`https://example.com`) is a canonical,
  // not "https" with the alias "//example.com".
  const colon = chars.findIndex((ch, i) => isBare(ch, ':') && !(isBare(chars[i + 1], '/') && isBare(chars[i + 2], '/')));
  if (colon >= 0) {
    return { canonical: joined(chars.slice(0, colon)).trim(), aliases: splitAliases(chars.slice(colon + 1), ',') };
  }
  return { canonical: joined(chars).trim(), aliases: [] };
}

export function parseTextImport(content: string): RawImport {
  const out: RawImport = { rows: [], skipped: [] };
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const parsed = parseTextLine(raw);
    if (!parsed) return;
    const { row, skip } = rowFor(i + 1, parsed.canonical, parsed.aliases);
    if (row) out.rows.push(row);
    if (skip) out.skipped.push(skip);
  });
  return out;
}
