/**
 * Helpers shared by the exporters: deterministic ordering, alias pair
 * expansion and escaping. Internal to exporters/; not re-exported from core.
 */
import { compareText } from '../collate.js';
import type { Lexicon, Term, TermCategory } from '../types.js';

/**
 * Where an exporter reports what the text does not say: `notes`, one
 * sentence per kind of entry it left out (naming them), and, for a format
 * that writes one row per alias, `rows`, the rows it wrote.
 */
export interface ExportSink {
  notes: string[];
  rows?: number;
}

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

/**
 * Canonical A to Z, the same on every machine: a fixed `en` collation, then
 * code units for the spellings it calls equal (`Café` precomposed and with a
 * combining accent). `localeCompare` without a locale follows the user's, so
 * under `LANG=sv_SE.UTF-8` `Äpple` sorted after `Zeta`: the same lexicon
 * exported in another order, and `--limit` kept other terms.
 */
export function compareCanonical(a: string, b: string): number {
  return compareText(a, b);
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

/**
 * One entry per (alias, canonical), both in NFC. Terms without aliases
 * contribute nothing. A file written with a decomposed accent (`Cafe` plus
 * U+0301, as text pasted from a macOS file name often is) exported that form
 * as the trigger, which typed and transcribed text (precomposed) never
 * matches; the store already treats both forms as one spelling, so one row is
 * written for them.
 */
export function aliasPairs(lexicon: Lexicon): AliasPair[] {
  const out: AliasPair[] = [];
  for (const term of lexicon.terms) {
    const canonical = term.canonical.normalize('NFC');
    const seen = new Set<string>();
    for (const alias of term.aliases) {
      const a = alias.trim().normalize('NFC');
      if (!a || seen.has(a)) continue;
      seen.add(a);
      out.push({ alias: a, canonical, term });
    }
  }
  return out;
}

/**
 * The canonicals of `terms` in order, in NFC, each spelling once: the list an
 * STT engine's boost or prompt field takes, where a name in two Unicode forms
 * was sent twice and in a form the engine's output (NFC) does not use.
 */
export function canonicalList(terms: readonly Term[]): { term: Term; canonical: string }[] {
  const seen = new Set<string>();
  const out: { term: Term; canonical: string }[] = [];
  for (const term of terms) {
    const canonical = term.canonical.normalize('NFC');
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push({ term, canonical });
  }
  return out;
}

/** RFC 4180-style quoting: wrap in quotes if the field has a comma, quote, or newline. */
export function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/**
 * A cell a spreadsheet would run as a formula when the CSV is opened in it
 * (Excel, LibreOffice Calc, Google Sheets): one starting with `=`, `+`, `-`
 * or `@`, or with a tab or carriage return, which some importers strip
 * before reading the rest (OWASP's CSV injection list). Spaces ahead of
 * `=`, `+`, `-` or `@` count too: a spreadsheet trims them on import and
 * runs ` =HYPERLINK(...)` as well, so only the first character was checked.
 */
export function isFormulaCell(value: string): boolean {
  return /^(?:[\t\r]|[ \t]*[=+\-@])/.test(value);
}

/**
 * `csvField`, with a formula cell (isFormulaCell) written as text: a leading
 * `'` and quoted, the escape spreadsheets document, so `=HYPERLINK(...)` is
 * shown rather than run. For a CSV meant for spreadsheets; a tool that reads
 * the cell itself keeps the `'`.
 */
export function csvTextField(value: string): string {
  return isFormulaCell(value) ? `"'${value.replace(/"/g, '""')}"` : csvField(value);
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

/**
 * `names` quoted for a note, at most `max` of them, then `and N more`:
 * `"A", "B" and 3 more`. Used in the notes an exporter writes about what it
 * left out (see `Exporter` in index.ts).
 */
export function quotedNames(names: readonly string[], max = 10): string {
  const shown = names.slice(0, max).map((n) => JSON.stringify(n));
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * `pairs` with each trigger once: when two terms share an alias (the same
 * `key(alias)`), the pair of the term `sortByImportance` puts first keeps it
 * (more hits, then brand/person/product, then canonical A to Z), so the
 * result does not depend on the file's order. The others come back in
 * `dropped`. Pairs keep their order.
 */
export function uniqueTriggers(
  pairs: readonly AliasPair[],
  key: (alias: string) => string = (a) => a,
): { kept: AliasPair[]; dropped: AliasPair[] } {
  const rank = new Map<Term, number>();
  sortByImportance([...new Set(pairs.map((p) => p.term))]).forEach((t, i) => rank.set(t, i));
  const winner = new Map<string, AliasPair>();
  for (const p of pairs) {
    const k = key(p.alias);
    const current = winner.get(k);
    if (!current || (rank.get(p.term) ?? 0) < (rank.get(current.term) ?? 0)) winner.set(k, p);
  }
  const kept: AliasPair[] = [];
  const dropped: AliasPair[] = [];
  for (const p of pairs) (winner.get(key(p.alias)) === p ? kept : dropped).push(p);
  return { kept, dropped };
}

/** The note for the pairs `uniqueTriggers` dropped, or undefined when there are none. */
export function sharedTriggerNote(dropped: readonly AliasPair[], what: string): string | undefined {
  if (dropped.length === 0) return undefined;
  return `left out ${dropped.length} ${what}${dropped.length === 1 ? '' : 's'} another term already uses (the more used term keeps it): ${quotedNames(dropped.map((p) => `${p.alias} -> ${p.canonical}`))}`;
}
