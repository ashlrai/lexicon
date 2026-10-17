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
 * `lexicon export text` writes this format.
 */
import { rowFor } from './shared.js';
import type { RawImport } from './shared.js';

const EQUALS_FORM = /^(.+?)\s+=\s+(.*)$/;
/** `Canonical =` with nothing after it: how `lexicon export text` writes a canonical with a colon and no aliases. */
const BARE_EQUALS_FORM = /^(.+?)\s+=$/;
/** A leading `#` escaped with a backslash (or more): see parseTextLine. */
const ESCAPED_HASH = /^\\+#/;
/** A colon that separates canonical from aliases: any colon except the one in `scheme://`. */
const SEPARATOR_COLON = /:(?!\/\/)/;

export function parseTextLine(raw: string): { canonical: string; aliases: string[] } | undefined {
  let text = raw.trim();
  if (!text) return undefined;
  // `\#hashtag` is the canonical "#hashtag", escaped so it is not a comment;
  // one backslash comes off a leading run of them before `#`, so `\\#x` reads `\#x`.
  if (ESCAPED_HASH.test(text)) text = text.slice(1);
  else if (text.startsWith('#')) return undefined;
  const eq = EQUALS_FORM.exec(text);
  if (eq) {
    return { canonical: eq[1].trim(), aliases: eq[2].split('|').map((a) => a.trim()).filter(Boolean) };
  }
  const bare = BARE_EQUALS_FORM.exec(text);
  if (bare) return { canonical: bare[1].trim(), aliases: [] };
  if (text === '=') return { canonical: '', aliases: [] };
  // The separator is the first colon that does not open `scheme://`: a line
  // that is a URL (`https://example.com`) is a canonical, not "https" with the
  // alias "//example.com".
  const colon = text.search(SEPARATOR_COLON);
  if (colon >= 0) {
    return {
      canonical: text.slice(0, colon).trim(),
      aliases: text.slice(colon + 1).split(',').map((a) => a.trim()).filter(Boolean),
    };
  }
  return { canonical: text, aliases: [] };
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
