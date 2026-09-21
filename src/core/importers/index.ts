/**
 * Import an existing dictionary (Wispr Flow, Superwhisper, macOS Text
 * Replacement, espanso, plain text, CSV, or our own lexicon file) into Term
 * objects. Pure: no IO. The CLI (`lexicon import`) reads the file and writes
 * the terms with addTerm.
 */
import type { Term, TermSource } from '../types.js';
import { REPLACEMENT_CHAR } from './encoding.js';
import { parseCsvImport, isLexiconCsvHeader } from './csv.js';
import { parseCsv } from './csv-parse.js';
import { looksLikeEspanso, parseEspansoImport } from './espanso.js';
import { looksLikeLexiconJson, parseJsonImport } from './json.js';
import { looksLikePlist, parseMacosImport } from './macos.js';
import type { ImportRow, ImportSkip, RawImport } from './shared.js';
import { looksLikeSuperwhisper, parseSuperwhisperImport } from './superwhisper.js';
import { parseTextImport } from './text.js';
import { isWisprHeader, parseWisprImport } from './wispr.js';

export {
  parseCsvImport,
  parseEspansoImport,
  parseJsonImport,
  parseMacosImport,
  parseSuperwhisperImport,
  parseTextImport,
  parseWisprImport,
};
export {
  REPLACEMENT_CHAR,
  decodeImportBytes,
  detectImportEncoding,
  importEncodingError,
} from './encoding.js';
export type { DecodedImport, ImportEncoding, ImportSource, UnsupportedImportEncoding } from './encoding.js';
export type { ImportRow, ImportSkip, RawImport };

export type ImportFormat = 'wispr' | 'superwhisper' | 'macos' | 'csv' | 'espanso' | 'text' | 'json' | 'auto';

export type ConcreteImportFormat = Exclude<ImportFormat, 'auto'>;

export const IMPORT_FORMATS: readonly ImportFormat[] = [
  'auto',
  'wispr',
  'superwhisper',
  'macos',
  'espanso',
  'text',
  'csv',
  'json',
];

export const IMPORT_FORMAT_INFO: Record<ImportFormat, { description: string }> = {
  'auto': { description: 'Detect the format from the content (default)' },
  'wispr': { description: 'Wispr Flow dictionary CSV (word,replacement)' },
  'superwhisper': { description: 'Superwhisper replacements JSON [{ original, replacement }]' },
  'macos': { description: 'macOS Text Replacement plist (phrase = canonical, shortcut = alias)' },
  'espanso': { description: 'espanso match YAML (trigger = alias, replace = canonical)' },
  'text': { description: 'Plain text, one term per line: "Canonical: alias1, alias2" or "Canonical = alias1 | alias2"' },
  'csv': { description: 'Generic CSV with a canonical,alias,category,phonetic header' },
  'json': { description: 'A lexicon JSON/YAML file (what `lexicon export json` writes)' },
};

export function isImportFormat(value: string): value is ImportFormat {
  return (IMPORT_FORMATS as readonly string[]).includes(value);
}

export interface ImportResult {
  terms: Term[];
  /** The format actually used (resolved when `auto` was requested). */
  format: ConcreteImportFormat;
  /** Rows that produced no term, with a 1-based line (or entry index) and why. */
  skipped: { line: number; reason: string }[];
}

export interface ImportOptions {
  /** `source` stamped on every imported term. Default 'import'. */
  source?: TermSource;
  /** Original file name; its extension breaks ties during auto-detection. */
  filename?: string;
}

const PARSERS: Record<ConcreteImportFormat, (content: string) => RawImport> = {
  wispr: parseWisprImport,
  superwhisper: parseSuperwhisperImport,
  macos: parseMacosImport,
  csv: parseCsvImport,
  espanso: parseEspansoImport,
  text: parseTextImport,
  json: parseJsonImport,
};

/**
 * Guess the format from the content. Order matters: structured formats with
 * unambiguous markers first, plain text last.
 */
export function detectImportFormat(content: string, filename?: string): ConcreteImportFormat {
  const text = content.replace(/^﻿/, '');
  const trimmed = text.trimStart();
  if (looksLikePlist(trimmed)) return 'macos';

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined) {
      if (looksLikeSuperwhisper(parsed)) return 'superwhisper';
      if (looksLikeLexiconJson(parsed)) return 'json';
      throw new Error(
        'could not detect the import format: JSON is neither a Superwhisper replacements list nor a lexicon file (use --format)',
      );
    }
  }

  if (looksLikeEspanso(text)) return 'espanso';
  if (/^(version|terms)\s*:/m.test(text) && /^terms\s*:/m.test(text)) return 'json';

  const firstLine = parseCsv(text)[0]?.fields;
  if (firstLine) {
    if (isWisprHeader(firstLine)) return 'wispr';
    if (isLexiconCsvHeader(firstLine)) return 'csv';
  }

  const ext = filename ? filename.toLowerCase().replace(/^.*\./, '') : '';
  if (ext === 'plist') return 'macos';
  if (ext === 'csv') return 'wispr';
  if (ext === 'yml' || ext === 'yaml') return 'espanso';
  return 'text';
}

export function importLexicon(content: string, format: ImportFormat, opts: ImportOptions = {}): ImportResult {
  if (!isImportFormat(format)) {
    throw new Error(`Unknown import format "${String(format)}". Known: ${IMPORT_FORMATS.join(', ')}`);
  }
  const resolved: ConcreteImportFormat = format === 'auto' ? detectImportFormat(content, opts.filename) : format;
  const raw = PARSERS[resolved](content);
  const { terms, skipped } = mergeRows(raw.rows, opts.source);
  assertNoLostCharacters(terms, opts.filename);
  return { terms, format: resolved, skipped: [...raw.skipped, ...skipped].sort((a, b) => a.line - b.line) };
}

/**
 * The backstop for callers that hand us a string instead of bytes (the MCP
 * `import_dictionary` tool with `content`, an embedder with its own reader):
 * `decodeImportBytes` cannot run for them, and a term carrying U+FFFD means
 * the original spelling was already lost upstream. Refusing is the only
 * honest option left. Storing it would make the lexicon assert, permanently,
 * that a name is spelled with a replacement character.
 */
function assertNoLostCharacters(terms: readonly Term[], filename?: string): void {
  for (const term of terms) {
    const lost = [term.canonical, ...term.aliases].find((s) => s.includes(REPLACEMENT_CHAR));
    if (lost === undefined) continue;
    const where = filename ? `the imported file ${filename}` : 'the imported text';
    throw new Error(
      `${where} was not UTF-8: "${lost}" contains the replacement character "${REPLACEMENT_CHAR}", ` +
        'so the original spelling is already lost and importing it would record the wrong spelling. ' +
        'Save the source as UTF-8 and import it again.',
    );
  }
}

/**
 * Collapse rows into one Term per canonical (case-insensitive; the first
 * spelling seen wins). Aliases are unioned, deduped case-insensitively, and
 * an alias equal to the canonical is dropped. Optional fields keep the first
 * non-empty value.
 */
export function mergeRows(rows: readonly ImportRow[], source?: TermSource): { terms: Term[]; skipped: ImportSkip[] } {
  const byKey = new Map<string, Term>();
  const skipped: ImportSkip[] = [];
  for (const { line, term } of rows) {
    const canonical = term.canonical.trim();
    if (!canonical) {
      skipped.push({ line, reason: 'empty canonical' });
      continue;
    }
    const key = canonical.toLowerCase();
    let target = byKey.get(key);
    if (!target) {
      target = { canonical, aliases: [], source: source ?? term.source ?? 'import' };
      byKey.set(key, target);
    }
    const seen = new Set(target.aliases.map((a) => a.toLowerCase()));
    for (const alias of term.aliases) {
      const a = alias.trim();
      const k = a.toLowerCase();
      if (!a || k === key || seen.has(k)) continue;
      seen.add(k);
      target.aliases.push(a);
    }
    if (term.phonetic && !target.phonetic) target.phonetic = term.phonetic;
    if (term.category && !target.category) target.category = term.category;
    if (term.notes && !target.notes) target.notes = term.notes;
    if (term.caseSensitive !== undefined && target.caseSensitive === undefined) target.caseSensitive = term.caseSensitive;
    if (term.never?.length) {
      const have = new Set((target.never ?? []).map((n) => n.toLowerCase()));
      target.never = [...(target.never ?? []), ...term.never.filter((n) => !have.has(n.toLowerCase()))];
    }
  }
  return { terms: [...byKey.values()], skipped };
}
