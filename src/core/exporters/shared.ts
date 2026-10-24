/**
 * Helpers shared by the exporters: deterministic ordering, alias pair
 * expansion and escaping. Internal to exporters/; not re-exported from core.
 */
import type { Lexicon, Term, TermCategory } from '../types.js';

const CATEGORY_ORDER: Record<TermCategory, number> = {
  brand: 0,
  person: 1,
  product: 2,
  acronym: 3,
  identifier: 4,
  place: 5,
  other: 6,
};

export function categoryRank(category: TermCategory | undefined): number {
  return category ? CATEGORY_ORDER[category] : CATEGORY_ORDER.other;
}

/** True for the categories STT engines get wrong most often. */
export function isProperNounCategory(category: TermCategory | undefined): boolean {
  return category === 'brand' || category === 'person' || category === 'product';
}

let collator: Intl.Collator | undefined;

/**
 * Canonical A to Z, the same on every machine: a fixed `en` collation, then
 * code units for the spellings it calls equal (`Café` precomposed and with a
 * combining accent). `localeCompare` without a locale follows the user's, so
 * under `LANG=sv_SE.UTF-8` `Äpple` sorted after `Zeta`: the same lexicon
 * exported in another order, and `--limit` kept other terms.
 */
export function compareCanonical(a: string, b: string): number {
  collator ??= new Intl.Collator('en');
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** hits desc, then brand/person/product before the rest, then alphabetical (compareCanonical). */
export function sortByImportance(terms: readonly Term[]): Term[] {
  return [...terms].sort(
    (a, b) =>
      (b.hits ?? 0) - (a.hits ?? 0) ||
      Number(isProperNounCategory(b.category)) - Number(isProperNounCategory(a.category)) ||
      compareCanonical(a.canonical, b.canonical),
  );
}

/** category rank, then alphabetical by canonical (compareCanonical). */
export function sortByCategory(terms: readonly Term[]): Term[] {
  return [...terms].sort(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) || compareCanonical(a.canonical, b.canonical),
  );
}

export interface AliasPair {
  alias: string;
  canonical: string;
  term: Term;
}

/** One entry per (alias, canonical). Terms without aliases contribute nothing. */
export function aliasPairs(lexicon: Lexicon): AliasPair[] {
  const out: AliasPair[] = [];
  for (const term of lexicon.terms) {
    for (const alias of term.aliases) {
      const a = alias.trim();
      if (!a) continue;
      out.push({ alias: a, canonical: term.canonical, term });
    }
  }
  return out;
}

/** RFC 4180-style quoting: wrap in quotes if the field has a comma, quote, or newline. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Join aliases into a `, `-separated list that the markdown importer can split
 * back. An alias holding a comma (or starting with a double quote) is wrapped
 * in double quotes with inner quotes doubled, CSV style; every other alias is
 * written as is, so lists without such aliases are unchanged.
 */
export function joinAliasList(aliases: readonly string[]): string {
  return aliases
    .map((a) => (a.includes(',') || a.trim().startsWith('"') ? `"${a.replace(/"/g, '""')}"` : a))
    .join(', ');
}

/**
 * Escape a table cell so pipes and line breaks cannot break the markdown table.
 * Schema validation already rejects line breaks; this also covers a Lexicon
 * built in memory, and treats U+2028/U+2029/NEL as the newlines they render as.
 *
 * A pipe becomes `\|`. A pipe right after a backslash (`a\|b`) cannot be
 * written that way: GFM reads `a\\|b` as an escaped backslash and then a cell
 * boundary, and the markdown importer reads only `\|` as an escape, so the
 * GFM spelling of a backslash (`\\`) would come back doubled. A zero-width
 * space (U+200B) goes between them instead: GFM keeps one cell (a backslash
 * escapes only ASCII punctuation), and the schema strips it on the way back in
 * (`stripInvisible`), so the import stores `a\|b`.
 */
export function mdCell(value: string): string {
  return value
    .replace(/\|/g, (_pipe, at: number) => (at > 0 && value[at - 1] === '\\' ? '\u200B\\|' : '\\|'))
    .replace(/\r\n|[\n\r\u0085\u2028\u2029]/g, ' ');
}
