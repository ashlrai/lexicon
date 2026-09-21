/**
 * Shared types for the lexicon. Every module in src/ codes against these.
 * Keep this file dependency-free (zod schemas live in schema.ts).
 */

/*
 * The four closed vocabularies below are declared once, as `as const` tuples,
 * and their union types are derived from them. Everything that needs the values
 * at runtime -- the zod schemas in schema.ts, the MCP tool enums, the CLI's
 * `--category` parsing, the importers -- reads these tuples, so adding a member
 * is a one-line change and nothing can drift out of step with the type.
 */

export const TERM_CATEGORIES = ['brand', 'person', 'product', 'acronym', 'identifier', 'place', 'other'] as const;
export type TermCategory = (typeof TERM_CATEGORIES)[number];

export const TERM_SCOPES = ['global', 'project'] as const;
export type TermScope = (typeof TERM_SCOPES)[number];

export const TERM_SOURCES = [
  'user',
  'harvest:repo',
  'harvest:git',
  'harvest:package',
  'import',
  'learned',
  'pack',
] as const;
export type TermSource = (typeof TERM_SOURCES)[number];

/** True when `value` is one of the seven term categories. */
export function isTermCategory(value: unknown): value is TermCategory {
  return typeof value === 'string' && (TERM_CATEGORIES as readonly string[]).includes(value);
}

export interface Term {
  /** The correct spelling the user wants to see. e.g. "Ashlr.AI" */
  canonical: string;
  /**
   * Spellings STT engines actually produce. Single or multi word, case-insensitive
   * unless caseSensitive is set. e.g. ["Ashler", "Ashlar", "Ashler AI", "Ashley our AI"]
   */
  aliases: string[];
  /** Human pronunciation hint, e.g. "ASH-ler". Used by exporters and the agent prompt. */
  phonetic?: string;
  category?: TermCategory;
  /** Match aliases case-sensitively. Default false. */
  caseSensitive?: boolean;
  scope?: TermScope;
  source?: TermSource;
  /** Free text shown to the agent, e.g. "my company; never write Ashlar". */
  notes?: string;
  /** ISO timestamp. */
  createdAt?: string;
  /** Times normalize_transcript replaced something with this term. */
  hits?: number;
  /**
   * Common English words that should NEVER be rewritten to this canonical even if
   * phonetically similar (guards against false positives like "sauce" -> "SaaS").
   * Per-term override of settings.protectedWords.
   */
  never?: string[];
}

export interface LexiconSettings {
  /**
   * Minimum confidence (0..1) a fuzzy/phonetic candidate needs before it is applied.
   * Exact alias matches always have confidence 1. Default 0.82.
   */
  minConfidence?: number;
  /** Enable phonetic (double metaphone) matching. Default true. */
  phonetic?: boolean;
  /** Enable edit-distance fuzzy matching. Default true. */
  fuzzy?: boolean;
  /** Words that must never be replaced by any term. Merged with a built-in stoplist. */
  protectedWords?: string[];
  /** Skip text inside `code spans`, ```fences```, URLs and emails. Default true. */
  skipCode?: boolean;
  /**
   * Names of the starter packs installed into this file (`lexicon pack add`).
   * Maintained by core/packs.ts; `installedPacks()` reads it.
   */
  packs?: string[];
}

export interface Lexicon {
  version: 1;
  terms: Term[];
  settings?: LexiconSettings;
}

/** A lexicon plus where it came from. */
export interface LexiconFile {
  path: string;
  scope: TermScope;
  lexicon: Lexicon;
  exists: boolean;
}

/** Global + project lexicons merged. Project terms win on canonical collision. */
export interface LoadedLexicon {
  merged: Lexicon;
  global: LexiconFile;
  /** The project file, present only when it exists AND was merged (trusted, or includeUntrusted). */
  project?: LexiconFile;
  /**
   * Trust status of the project file found for this cwd (see core/trust.ts).
   * Absent when no project file exists.
   */
  projectTrust?: 'trusted' | 'untrusted' | 'changed';
  /**
   * A project file that exists but was NOT merged because it is untrusted or
   * changed since it was trusted. Callers may surface its path; never inject
   * its contents into model context.
   */
  skippedProject?: LexiconFile;
}

export type MatchReason = 'alias' | 'phonetic' | 'fuzzy';

export interface Replacement {
  /** Character offsets into the ORIGINAL input. */
  start: number;
  end: number;
  original: string;
  replacement: string;
  canonical: string;
  reason: MatchReason;
  /** 0..1. Exact alias = 1. */
  confidence: number;
}

export interface NormalizeResult {
  input: string;
  output: string;
  replacements: Replacement[];
  /** True if output !== input. */
  changed: boolean;
}

export interface NormalizeOptions {
  minConfidence?: number;
  phonetic?: boolean;
  fuzzy?: boolean;
  skipCode?: boolean;
  /** Return candidates without applying them (output === input). */
  dryRun?: boolean;
}

/** A term proposed by a harvester, before the user accepts it. */
export interface HarvestCandidate {
  canonical: string;
  category: TermCategory;
  source: TermSource;
  /** Where it was seen: file path, "git log", "package.json#name" ... */
  evidence: string[];
  /** Occurrence count across the scan. */
  count: number;
  /**
   * Auto-generated likely misspellings. Often empty on purpose: an identifier
   * never gets one, and a canonical with no separator of its own keeps only
   * the single-word suggestions, because a guessed word boundary rewrites
   * ordinary prose. See harvestAliases() in harvest.ts.
   */
  suggestedAliases: string[];
}

export interface HarvestOptions {
  /** Max candidates returned. Default 50. */
  limit?: number;
  /** Minimum occurrences to be reported. Default 2. */
  minCount?: number;
  /** Include git log author names. Default true. */
  git?: boolean;
  /** Include package/module names from manifests. Default true. */
  packages?: boolean;
  /** Scan source for PascalCase identifiers at all (they corroborate names found elsewhere). Default true. */
  identifiers?: boolean;
  /**
   * Also propose names seen *only* as a PascalCase symbol in source. Default
   * false: a symbol nothing outside the code mentions is something you type,
   * not something you say, and proposing those by frequency is what fills the
   * list with `TextDiff` and `DispatchQueue`. Turn it on to review them.
   */
  symbols?: boolean;
  /** Extra glob-ish ignore patterns (dir names). node_modules, dist, .git always ignored. */
  ignore?: string[];
}

/**
 * Export targets, in the order `lexicon export --list` prints them. One
 * sentence of prose per format lives in `EXPORT_FORMAT_INFO`
 * (core/exporters/index.ts), which is keyed by this type.
 */
export const EXPORT_FORMATS = [
  'wispr',
  'superwhisper',
  'whisper-prompt',
  'macos',
  'claude-md',
  'csv',
  'json',
  'deepgram',
  'espanso',
  'assemblyai',
  'azure',
  'google',
  'openai',
  'text',
  'markdown',
] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  /** Only include these categories. */
  categories?: TermCategory[];
  /** Cap term count (whisper-prompt enforces ~100). */
  limit?: number;
}
