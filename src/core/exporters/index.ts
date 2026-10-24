/**
 * Export the lexicon to the formats other tools understand (Wispr Flow,
 * Superwhisper, Whisper prompt, macOS text replacement, CLAUDE.md, ...).
 */
import { EXPORT_FORMATS } from '../types.js';
/** Declared in core/types.ts (next to the ExportFormat union it derives); re-exported here, where callers look for it. */
export { EXPORT_FORMATS } from '../types.js';
import type { ExportFormat, ExportOptions, Lexicon, Term } from '../types.js';
import { exportAssemblyai } from './assemblyai.js';
import { exportAzure } from './azure.js';
import { exportClaudeMd } from './claudeMd.js';
import { exportCsv } from './csv.js';
import { exportDeepgram } from './deepgram.js';
import { exportEspanso } from './espanso.js';
import { exportGoogle } from './google.js';
import { exportJson } from './json.js';
import { exportMacos } from './macos.js';
import { exportMarkdown } from './markdown.js';
import { exportOpenai } from './openai.js';
import { sortByImportance } from './shared.js';
import { exportSuperwhisper } from './superwhisper.js';
import { exportText } from './text.js';
import { exportWhisperPrompt } from './whisperPrompt.js';
import { exportWispr } from './wispr.js';

export {
  exportAssemblyai,
  exportAzure,
  exportClaudeMd,
  exportCsv,
  exportDeepgram,
  exportEspanso,
  exportGoogle,
  exportJson,
  exportMacos,
  exportMarkdown,
  exportOpenai,
  exportSuperwhisper,
  exportText,
  exportWhisperPrompt,
  exportWispr,
};

export const EXPORT_FORMAT_INFO: Record<ExportFormat, { description: string; ext: string }> = {
  'wispr': { description: 'Wispr Flow dictionary CSV', ext: 'csv' },
  'superwhisper': { description: 'Superwhisper replacements JSON', ext: 'json' },
  'whisper-prompt': { description: 'Whisper initial_prompt line', ext: 'txt' },
  'macos': { description: 'macOS Text Replacement plist', ext: 'plist' },
  'claude-md': { description: 'Markdown snippet for CLAUDE.md / system prompt', ext: 'md' },
  'csv': { description: 'Generic canonical,alias CSV', ext: 'csv' },
  'json': { description: 'Raw lexicon JSON', ext: 'json' },
  'deepgram': { description: 'Deepgram keywords with boost', ext: 'json' },
  'espanso': { description: 'espanso match YAML', ext: 'yml' },
  'assemblyai': { description: 'AssemblyAI word_boost JSON', ext: 'json' },
  'azure': { description: 'Azure Speech phraseList JSON', ext: 'json' },
  'google': { description: 'Google Speech-to-Text adaptation phraseSets JSON', ext: 'json' },
  'openai': { description: 'OpenAI transcription `prompt` field (one line, <= 100 terms)', ext: 'txt' },
  'text': { description: 'Plain text, one "Canonical: alias1, alias2" per line (round-trips with `lexicon import`)', ext: 'txt' },
  'markdown': { description: 'Markdown bullet list for READMEs and wikis', ext: 'md' },
};

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * Other names people type for a format: the product is "Wispr Flow", so
 * `export wispr-flow` is the first thing tried. Accepted wherever a format is
 * parsed from text (CLI, HTTP API, the MCP export_lexicon tool);
 * `EXPORT_FORMATS` stays the canonical list.
 */
export const EXPORT_FORMAT_ALIASES: Readonly<Record<string, ExportFormat>> = {
  'wispr-flow': 'wispr',
  'wisprflow': 'wispr',
  'wispr-flow-csv': 'wispr',
};

/** The format `value` names (case-insensitive, aliases included), or undefined. */
export function resolveExportFormat(value: string): ExportFormat | undefined {
  const lower = value.trim().toLowerCase();
  if (isExportFormat(lower)) return lower;
  return Object.hasOwn(EXPORT_FORMAT_ALIASES, lower) ? EXPORT_FORMAT_ALIASES[lower] : undefined;
}

const EXPORTERS: Record<ExportFormat, (lexicon: Lexicon, opts: ExportOptions) => string> = {
  'wispr': exportWispr,
  'superwhisper': exportSuperwhisper,
  'whisper-prompt': exportWhisperPrompt,
  'macos': exportMacos,
  'claude-md': exportClaudeMd,
  'csv': exportCsv,
  'json': exportJson,
  'deepgram': exportDeepgram,
  'espanso': exportEspanso,
  'assemblyai': exportAssemblyai,
  'azure': exportAzure,
  'google': exportGoogle,
  'openai': exportOpenai,
  'text': exportText,
  'markdown': exportMarkdown,
};

/**
 * The formats that write one row per alias (`canonical,alias`, a replacement
 * pair, a trigger), so a term without an alias contributes nothing to them.
 */
export const EXPORT_ALIAS_ROW_FORMATS: readonly ExportFormat[] = ['csv', 'wispr', 'superwhisper', 'macos', 'espanso'];

/** Whether a term has an alias an alias-row format can write a row for. */
function hasAliasRow(term: Term): boolean {
  return term.aliases.some((a) => a.trim() !== '');
}

export function exportLexicon(lexicon: Lexicon, format: ExportFormat, opts: ExportOptions = {}): string {
  const exporter = EXPORTERS[format];
  if (!exporter) {
    throw new Error(`Unknown export format "${format}". Known: ${EXPORT_FORMATS.join(', ')}`);
  }
  return exporter(applyOptions(lexicon, opts, format), opts);
}

/**
 * The terms `exportLexicon(lexicon, format, opts)` hands the exporter: those
 * in `opts.categories` (all when none are given), capped at `opts.limit`. A
 * format with its own cap (`whisper-prompt`) may write fewer. Without
 * `format` the cap counts every term, as for a format that is not an
 * alias-row one.
 */
export function selectExportTerms(lexicon: Lexicon, opts: ExportOptions = {}, format?: ExportFormat): Term[] {
  return applyOptions(lexicon, opts, format).terms;
}

/**
 * Apply the category filter and term cap before dispatching. The cap keeps
 * the most-used terms: hits, highest first; at equal hits brand, person and
 * product terms first; then canonical A to Z (sortByImportance). For an
 * alias-row format only terms with an alias are counted, since one without
 * writes no row: `limit: 1` on a lexicon whose first term had no alias wrote
 * a CSV with only its header. The lexicon's own term order is kept afterwards
 * so per-format sorting is unaffected.
 */
function applyOptions(lexicon: Lexicon, opts: ExportOptions, format?: ExportFormat): Lexicon {
  let terms: Term[] = lexicon.terms;
  if (opts.categories && opts.categories.length > 0) {
    const allowed = new Set(opts.categories);
    terms = terms.filter((t) => t.category !== undefined && allowed.has(t.category));
  }
  if (opts.limit !== undefined) {
    const candidates = format !== undefined && EXPORT_ALIAS_ROW_FORMATS.includes(format) ? terms.filter(hasAliasRow) : terms;
    if (candidates.length > opts.limit || candidates.length < terms.length) {
      const keep = new Set(sortByImportance(candidates).slice(0, Math.max(0, opts.limit)));
      terms = terms.filter((t) => keep.has(t));
    }
  }
  if (terms === lexicon.terms) return lexicon;
  return { ...lexicon, terms };
}
