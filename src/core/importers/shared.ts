/**
 * Helpers shared by the importers. Internal to importers/; not re-exported
 * from core.
 */
import type { Term, TermCategory } from '../types.js';

/** One parsed row before merging: a partial term plus where it came from. */
export interface ImportRow {
  /** 1-based line number (or 1-based entry index for JSON/YAML inputs). */
  line: number;
  term: Term;
}

export interface ImportSkip {
  line: number;
  reason: string;
}

export interface RawImport {
  rows: ImportRow[];
  skipped: ImportSkip[];
}

const CATEGORIES: readonly TermCategory[] = [
  'brand',
  'person',
  'product',
  'acronym',
  'identifier',
  'place',
  'other',
];

export function isTermCategory(value: unknown): value is TermCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

/** Normalize a free-text category cell: trimmed, lower-cased, else undefined. */
export function parseCategoryCell(value: string | undefined): TermCategory | undefined {
  if (value === undefined) return undefined;
  const lower = value.trim().toLowerCase();
  return isTermCategory(lower) ? lower : undefined;
}

/** Build a row from a canonical + aliases, or a skip when the canonical is blank. */
export function rowFor(
  line: number,
  canonical: string,
  aliases: readonly string[],
  extra: Partial<Pick<Term, 'category' | 'phonetic' | 'notes'>> = {},
): { row?: ImportRow; skip?: ImportSkip } {
  const c = canonical.trim();
  if (!c) return { skip: { line, reason: 'empty canonical' } };
  const term: Term = { canonical: c, aliases: aliases.map((a) => a.trim()).filter(Boolean) };
  if (extra.category) term.category = extra.category;
  if (extra.phonetic?.trim()) term.phonetic = extra.phonetic.trim();
  if (extra.notes?.trim()) term.notes = extra.notes.trim();
  return { row: { line, term } };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Count newlines before `offset` to turn a string index into a 1-based line. */
export function lineAt(content: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, content.length);
  for (let i = 0; i < end; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}
