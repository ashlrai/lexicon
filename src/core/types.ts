/**
 * Shared types for the lexicon. Every module in src/ codes against these.
 * Keep this file dependency-free (zod schemas live in schema.ts).
 */

export type TermCategory =
  | 'brand'
  | 'person'
  | 'product'
  | 'acronym'
  | 'identifier'
  | 'place'
  | 'other';

export type TermScope = 'global' | 'project';

export type TermSource =
  | 'user'
  | 'harvest:repo'
  | 'harvest:git'
  | 'harvest:package'
  | 'import'
  | 'learned';

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
  /** Auto-generated likely misspellings (may be empty). */
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
  /** Include identifiers from source (PascalCase classes, etc). Default true. */
  identifiers?: boolean;
  /** Extra glob-ish ignore patterns (dir names). node_modules, dist, .git always ignored. */
  ignore?: string[];
}

export type ExportFormat =
  | 'wispr'          // CSV: word,replacement  (Wispr Flow dictionary import)
  | 'superwhisper'   // JSON replacements list
  | 'whisper-prompt' // single line for Whisper initial_prompt (<= ~100 terms)
  | 'macos'          // macOS Text Replacement plist
  | 'claude-md'      // markdown snippet for CLAUDE.md / system prompt
  | 'csv'            // generic canonical,alias
  | 'json'           // raw lexicon JSON
  | 'deepgram'       // JSON keywords array with boost
  | 'espanso'        // espanso YAML matches
  | 'assemblyai'     // JSON word_boost list
  | 'azure'          // JSON phraseList (Azure Speech PhraseListGrammar)
  | 'google'         // JSON adaptation phraseSets with boost
  | 'openai'         // OpenAI transcription `prompt` line (same as whisper-prompt)
  | 'text'           // plain "Canonical: alias1, alias2" lines (round-trips with the text importer)
  | 'markdown';      // markdown bullet list for READMEs / wikis

export interface ExportOptions {
  /** Only include these categories. */
  categories?: TermCategory[];
  /** Cap term count (whisper-prompt enforces ~100). */
  limit?: number;
}
