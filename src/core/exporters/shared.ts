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

/** hits desc, then brand/person/product before the rest, then alphabetical. */
export function sortByImportance(terms: readonly Term[]): Term[] {
  return [...terms].sort(
    (a, b) =>
      (b.hits ?? 0) - (a.hits ?? 0) ||
      Number(isProperNounCategory(b.category)) - Number(isProperNounCategory(a.category)) ||
      a.canonical.localeCompare(b.canonical),
  );
}

/** category rank, then alphabetical by canonical. */
export function sortByCategory(terms: readonly Term[]): Term[] {
  return [...terms].sort(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) || a.canonical.localeCompare(b.canonical),
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
 * Escape a table cell so pipes and line breaks cannot break the markdown table.
 * Schema validation already rejects line breaks; this also covers a Lexicon
 * built in memory, and treats U+2028/U+2029/NEL as the newlines they render as.
 */
export function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r\n|[\n\r\u0085\u2028\u2029]/g, ' ');
}
