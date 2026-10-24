/**
 * The notes the CLI, the MCP server and the local API add when a result
 * needs a word (an empty lexicon, an empty export, a skipped project file),
 * built here once so their wording cannot drift apart. Each builder defaults
 * to the CLI's next step (`lexicon setup`, `lexicon trust`, ...); the MCP
 * server passes its own, in tool terms (`setup_lexicon`, `add_term`).
 */
import { EXPORT_ALIAS_ROW_FORMATS, selectExportTerms } from './exporters/index.js';
import type { ExportFormat, ExportOptions, LoadedLexicon } from './types.js';

/** Who reviews a skipped project file and the command that trusts it. */
export interface TrustNoteVoice {
  /** Put before "review it": '' for the CLI, 'the user can ' for MCP. */
  who: string;
  /** The trust command as the note names it, e.g. '`lexicon trust`'. */
  trust: string;
}

const CLI_TRUST_VOICE: TrustNoteVoice = { who: '', trust: '`lexicon trust`' };

/**
 * Why a project .lexicon.yaml was not loaded (untrusted, or changed since it
 * was trusted) and the `lexicon trust` step, plus `consequence` (what the skip
 * means for this result) when given. Undefined when no project file was skipped.
 */
export function skippedProjectNote(
  loaded: Pick<LoadedLexicon, 'projectTrust' | 'skippedProject'>,
  consequence?: string,
  voice: TrustNoteVoice = CLI_TRUST_VOICE,
): string | undefined {
  if (!loaded.skippedProject) return undefined;
  const head =
    loaded.projectTrust === 'changed'
      ? `The project .lexicon.yaml changed since it was trusted and was not loaded; ${voice.who}review it and run ${voice.trust} again.`
      : `An untrusted project .lexicon.yaml exists and was not loaded; ${voice.who}review it and run ${voice.trust} to enable it.`;
  return consequence ? `${head} ${consequence}` : head;
}

/**
 * The note for a list of a lexicon with no terms (`lexicon list`, MCP
 * list_terms, `GET /lexicon`), ending in `step`.
 */
export function emptyLexiconNote(step = 'add one with: lexicon add "Ashlr.AI" Ashler, or run `lexicon setup`.'): string {
  return `The lexicon has no terms yet; ${step}`;
}

/**
 * The note for statistics of a lexicon with no terms (`lexicon stats`, MCP
 * lexicon_stats, `GET /stats`), ending in `step`. Undefined when there are
 * terms, and when a skipped project file holds them (skippedProjectNote names
 * `lexicon trust` then).
 */
export function emptyStatsNote(
  loaded: Pick<LoadedLexicon, 'merged' | 'skippedProject'>,
  step = 'run `lexicon setup`, or add one with: lexicon learn <heard> <meant>.',
): string | undefined {
  if (loaded.merged.terms.length > 0 || loaded.skippedProject) return undefined;
  return `The lexicon has no terms yet, so nothing is corrected or counted; ${step}`;
}

/**
 * Why an export holds no terms or no rows: `no-terms` (the lexicon has none),
 * `only-untrusted` (its only terms are in a skipped project file), `no-match`
 * (none matched `opts.categories`), `no-rows` (an alias-row format,
 * EXPORT_ALIAS_ROW_FORMATS, whose exported terms all lack an alias, also when
 * `opts.limit`, which counts only terms with one there, left none). Undefined
 * when the export holds something.
 */
export type EmptyExportReason = 'no-terms' | 'only-untrusted' | 'no-match' | 'no-rows';

export function emptyExportReason(
  loaded: Pick<LoadedLexicon, 'merged' | 'skippedProject'>,
  format: ExportFormat,
  opts: ExportOptions = {},
): EmptyExportReason | undefined {
  if (loaded.merged.terms.length === 0) return loaded.skippedProject ? 'only-untrusted' : 'no-terms';
  if (opts.categories !== undefined && opts.categories.length > 0 && selectExportTerms(loaded.merged, { categories: opts.categories }).length === 0) {
    return 'no-match';
  }
  if (EXPORT_ALIAS_ROW_FORMATS.includes(format) && !selectExportTerms(loaded.merged, opts, format).some((t) => t.aliases.some((a) => a.trim() !== ''))) {
    return 'no-rows';
  }
  return undefined;
}

/** The step each EmptyExportReason ends in. */
export type EmptyExportSteps = Record<EmptyExportReason, string>;

const CLI_EXPORT_STEPS: EmptyExportSteps = {
  'no-terms': 'run `lexicon setup`, or add one with: lexicon learn <heard> <meant>.',
  'only-untrusted': 'review it and run `lexicon trust`.',
  'no-match': "lexicon list shows each term's category.",
  'no-rows': 'add one with: lexicon add <canonical> <alias>.',
};

/**
 * The note for an EmptyExportReason. `filter` names the category filter as
 * the caller took it (`--category brand`, `?category=brand`); `steps`
 * replaces the CLI's next steps.
 */
export function emptyExportNote(
  reason: EmptyExportReason,
  context: { format: ExportFormat; filter: string; steps?: Partial<EmptyExportSteps> },
): string {
  const step = context.steps?.[reason] ?? CLI_EXPORT_STEPS[reason];
  switch (reason) {
    case 'no-terms':
      return `The lexicon has no terms yet, so the export is empty; ${step}`;
    case 'only-untrusted':
      return `The export is empty: the only terms are in the untrusted project lexicon, which was left out; ${step}`;
    case 'no-match':
      return `No term matched ${context.filter}, so the export is empty; ${step}`;
    case 'no-rows':
      return `No exported term has an alias, and ${context.format} writes one row per alias, so the export has no rows; ${step}`;
  }
}
