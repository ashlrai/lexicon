/**
 * Numbers and name lists the CLI help text and MCP tool schemas need before
 * any command or tool runs. This file imports nothing: loading it must not
 * pull zod, yaml, the matcher, or the exporters. The modules that own the
 * behavior re-export these so `src/core/index.ts` stays the public path.
 */
import type { ExportFormat } from './types.js';

/** Max characters in a canonical or alias, notes, alias list, file, and protected words. */
export const LIMITS = {
  /** Max characters in a canonical or alias. */
  word: 80,
  /** Max characters in notes / phonetic. */
  text: 200,
  /** Max aliases (and `never` words) per term. */
  aliases: 64,
  /** Max terms per file. */
  terms: 5000,
  /** Max protectedWords in settings. */
  protectedWords: 1000,
} as const;

/** The most candidates `harvestRepo` callers may ask for. */
export const HARVEST_MAX_LIMIT = 1000;

/**
 * The largest `limit` export callers take: a global and a project file of the
 * schema's 5000 terms each, so any merged lexicon fits under it.
 */
export const EXPORT_MAX_LIMIT = 10000;

export const SUGGEST_DEFAULT_LIMIT = 20;
/** The most suggestions `lexicon suggest --limit` and MCP `suggest_terms` take. */
export const SUGGEST_MAX_LIMIT = 500;
/** `--yes` and MCP auto-apply use this: suggestions at or above it are safe to apply unattended. */
export const AUTO_APPLY_CONFIDENCE = 0.8;

/** Longest string accepted on either side of a correction. */
export const MAX_CORRECTION_LENGTH = 60;

/** Top terms by hits returned in lexicon stats. */
export const TOP_TERMS = 10;
/** Canonicals with zero hits listed in lexicon stats. */
export const NEVER_HIT_CAP = 20;

/** Default fuzzy/phonetic confidence when a lexicon sets none. */
export const DEFAULT_MIN_CONFIDENCE = 0.82;
/**
 * Score of an exact match that invents a word break ("open ai" for OpenAI).
 * Above every inexact pass, below a real exact match.
 */
export const INVENTED_BOUNDARY_CONFIDENCE = 0.95;

/**
 * Other names people type for a format. Accepted wherever a format is parsed
 * from text. `EXPORT_FORMATS` in types.ts stays the canonical list.
 */
export const EXPORT_FORMAT_ALIASES: Readonly<Record<string, ExportFormat>> = {
  'wispr-flow': 'wispr',
  wisprflow: 'wispr',
  'wispr-flow-csv': 'wispr',
};

/** Project lexicon file name, at a git root or the working directory. */
export const PROJECT_FILE_NAME = '.lexicon.yaml';

/**
 * Formats that write one row per alias, so a term without an alias contributes
 * nothing. Kept here so MCP tool text can name them without loading exporters.
 */
export const EXPORT_ALIAS_ROW_FORMATS: readonly ExportFormat[] = ['csv', 'wispr', 'superwhisper', 'macos', 'espanso'];

/** Vocabulary sources the guided import can harvest today. */
export const IMPLEMENTED_IMPORT_SOURCES = ['contacts', 'calendar', 'github'] as const;

/** Formats `lexicon import` accepts, `auto` first. */
export const IMPORT_FORMATS = [
  'auto',
  'wispr',
  'superwhisper',
  'macos',
  'espanso',
  'markdown',
  'text',
  'csv',
  'json',
] as const;
