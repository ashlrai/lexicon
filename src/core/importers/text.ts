/**
 * Plain text, one term per line. Three shapes, `#` full-line comments:
 *
 *   Canonical
 *   Canonical: alias1, alias2
 *   Canonical = alias1 | alias2
 *
 * The `=` form (space-padded) is checked first so canonicals containing a
 * colon (`Ashlr:AI = ...`) and aliases containing commas survive round trips.
 * `lexicon export text` writes this format.
 */
import { rowFor } from './shared.js';
import type { RawImport } from './shared.js';

const EQUALS_FORM = /^(.+?)\s+=\s+(.*)$/;

export function parseTextLine(raw: string): { canonical: string; aliases: string[] } | undefined {
  const text = raw.trim();
  if (!text || text.startsWith('#')) return undefined;
  const eq = EQUALS_FORM.exec(text);
  if (eq) {
    return { canonical: eq[1].trim(), aliases: eq[2].split('|').map((a) => a.trim()).filter(Boolean) };
  }
  if (text === '=') return { canonical: '', aliases: [] };
  const colon = text.indexOf(':');
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
