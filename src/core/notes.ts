/**
 * The notes the CLI, the MCP server and the local API add when a result
 * needs a word (an empty lexicon, an empty export, a skipped project file),
 * built here once so their wording cannot drift apart. Each builder defaults
 * to the CLI's next step (`lexicon setup`, `lexicon trust`, ...); the MCP
 * server passes its own, in tool terms (`setup_lexicon`, `add_term`).
 */
import { EXPORT_ALIAS_ROW_FORMATS, selectExportTerms } from './exporters/index.js';
import type { ExportFormat, ExportOptions, LoadedLexicon } from './types.js';

/**
 * The opening every note on a lexicon with no terms shares: `The lexicon has
 * no terms yet`, then `, so <so>` when given. `lower` starts it with a small
 * letter, for a note that follows a prefix (`no changes (...)`, `Note: `).
 */
export function noTermsYet(opts: { so?: string; lower?: boolean } = {}): string {
  return `${opts.lower ? 'the' : 'The'} lexicon has no terms yet${opts.so ? `, so ${opts.so}` : ''}`;
}

/** The CLI step that gets a lexicon its first term (no closing period). */
export const FIRST_TERM_STEP = 'run `lexicon setup`, or add one with: lexicon learn <heard> <meant>';

/**
 * The opening of a note when the only terms are in a skipped (untrusted)
 * project file: `the only terms are in the untrusted project lexicon, which
 * <fate>` (`was not loaded`, `was left out`).
 */
export function onlyUntrustedTerms(fate: string): string {
  return `the only terms are in the untrusted project lexicon, which ${fate}`;
}

/** The CLI step for a skipped project file (no closing period). */
export const TRUST_STEP = 'review it and run `lexicon trust`';

/**
 * Why nothing can be corrected (`POST /normalize`'s `hint`, MCP
 * normalize_transcript has its own): how to get terms, or the `lexicon trust`
 * step when only a skipped project file holds them.
 */
export function emptyNormalizeHint(loaded: Pick<LoadedLexicon, 'skippedProject'>): string {
  return loaded.skippedProject
    ? `Nothing can be corrected: ${onlyUntrustedTerms('was not loaded')}; ${TRUST_STEP}.`
    : `${noTermsYet({ so: 'nothing can be corrected' })}; ${FIRST_TERM_STEP}.`;
}

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
  return `${noTermsYet()}; ${step}`;
}

/** The tool that lists terms, as a no-match note names it: `lexicon list` shows, MCP `list_terms` returns. */
export interface TermLister {
  name: string;
  verb: string;
}

const CLI_TERM_LISTER: TermLister = { name: 'lexicon list', verb: 'shows' };

/**
 * The note for a term list whose filter matched none of the lexicon's terms
 * (`lexicon list --category/--query`, MCP list_terms `category`/`query`):
 * `filter` names the filter as the caller took it, `filters` how many were
 * given (`it` or `them`), `total` the terms there are.
 */
export function noTermMatchesNote(context: { filter: string; filters: number; total: number; lister?: TermLister }): string {
  const lister = context.lister ?? CLI_TERM_LISTER;
  const terms = `${context.total} term${context.total === 1 ? '' : 's'}`;
  return `No term matches ${context.filter}; the lexicon has ${terms} in all, which ${lister.name} without ${context.filters === 1 ? 'it' : 'them'} ${lister.verb}.`;
}

/**
 * The note for statistics of a lexicon with no terms (`lexicon stats`, MCP
 * lexicon_stats, `GET /stats`), ending in `step`. Undefined when there are
 * terms, and when a skipped project file holds them (skippedProjectNote names
 * `lexicon trust` then).
 */
export function emptyStatsNote(
  loaded: Pick<LoadedLexicon, 'merged' | 'skippedProject'>,
  step = `${FIRST_TERM_STEP}.`,
): string | undefined {
  if (loaded.merged.terms.length > 0 || loaded.skippedProject) return undefined;
  return `${noTermsYet({ so: 'nothing is corrected or counted' })}; ${step}`;
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
  'no-terms': `${FIRST_TERM_STEP}.`,
  'only-untrusted': `${TRUST_STEP}.`,
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
      return `${noTermsYet({ so: 'the export is empty' })}; ${step}`;
    case 'only-untrusted':
      return `The export is empty: ${onlyUntrustedTerms('was left out')}; ${step}`;
    case 'no-match':
      return `No term matched ${context.filter}, so the export is empty; ${step}`;
    case 'no-rows':
      return `No exported term has an alias, and ${context.format} writes one row per alias, so the export has no rows; ${step}`;
  }
}
