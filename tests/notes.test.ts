import { describe, expect, it } from 'vitest';
import { emptyExportNote, emptyExportReason, emptyLexiconNote, emptyStatsNote, skippedProjectNote } from '../src/core/notes.js';
import { skippedProjectJson } from '../src/cli/io.js';
import { exportNote, lexiconNote, statsNote } from '../src/serve/server.js';
import type { Lexicon, LoadedLexicon } from '../src/core/types.js';

function loadedOf(terms: Lexicon['terms'], skipped?: 'untrusted' | 'changed'): Pick<LoadedLexicon, 'merged' | 'projectTrust' | 'skippedProject'> {
  return {
    merged: { version: 1, terms },
    ...(skipped ? { projectTrust: skipped, skippedProject: { path: '/repo/.lexicon.yaml' } as LoadedLexicon['skippedProject'] } : {}),
  };
}

const bare = [{ canonical: 'Quokka', aliases: [], category: 'product' as const }];
const aliased = [{ canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand' as const }];

// The CLI, the MCP server and the local API built these notes from copies of
// one another's wording, so a change to one surface left the others behind
// (`lexicon export csv --limit 5` lost its "no rows" note that way).
describe('core notes', () => {
  it('emptyExportReason names why an export is empty, the same for every surface', () => {
    expect(emptyExportReason(loadedOf([]), 'csv')).toBe('no-terms');
    expect(emptyExportReason(loadedOf([], 'untrusted'), 'csv')).toBe('only-untrusted');
    expect(emptyExportReason(loadedOf(aliased), 'csv', { categories: ['person'] })).toBe('no-match');
    expect(emptyExportReason(loadedOf(bare), 'csv')).toBe('no-rows');
    // --limit counts only terms with an alias for an alias-row format, so none is exported.
    expect(emptyExportReason(loadedOf(bare), 'csv', { limit: 5 })).toBe('no-rows');
    expect(emptyExportReason(loadedOf(bare), 'json', { limit: 5 })).toBeUndefined();
    expect(emptyExportReason(loadedOf(aliased), 'csv', { categories: ['brand'], limit: 1 })).toBeUndefined();
  });

  it('keeps the wording each surface printed before the builders were shared', () => {
    expect(emptyExportNote('no-terms', { format: 'csv', filter: '' })).toBe(
      'The lexicon has no terms yet, so the export is empty; run `lexicon setup`, or add one with: lexicon learn <heard> <meant>.',
    );
    expect(emptyExportNote('only-untrusted', { format: 'csv', filter: '' })).toBe(
      'The export is empty: the only terms are in the untrusted project lexicon, which was left out; review it and run `lexicon trust`.',
    );
    expect(emptyExportNote('no-match', { format: 'csv', filter: '--category person' })).toBe(
      "No term matched --category person, so the export is empty; lexicon list shows each term's category.",
    );
    expect(emptyExportNote('no-rows', { format: 'wispr', filter: '', steps: { 'no-rows': 'add_term with aliases adds some.' } })).toBe(
      'No exported term has an alias, and wispr writes one row per alias, so the export has no rows; add_term with aliases adds some.',
    );
    expect(emptyLexiconNote()).toBe('The lexicon has no terms yet; add one with: lexicon add "Ashlr.AI" Ashler, or run `lexicon setup`.');
    expect(emptyStatsNote(loadedOf([]))).toBe(
      'The lexicon has no terms yet, so nothing is corrected or counted; run `lexicon setup`, or add one with: lexicon learn <heard> <meant>.',
    );
    expect(emptyStatsNote(loadedOf([], 'untrusted'))).toBeUndefined();
    expect(skippedProjectNote(loadedOf(aliased, 'changed'), 'Its terms are not in the counts.')).toBe(
      'The project .lexicon.yaml changed since it was trusted and was not loaded; review it and run `lexicon trust` again. Its terms are not in the counts.',
    );
    expect(skippedProjectNote(loadedOf(aliased, 'untrusted'), undefined, { who: 'the user can ', trust: '`lexicon trust`' })).toBe(
      'An untrusted project .lexicon.yaml exists and was not loaded; the user can review it and run `lexicon trust` to enable it.',
    );
    expect(skippedProjectNote(loadedOf(aliased))).toBeUndefined();
  });

  it('the CLI and the local API give the same sentences', () => {
    const skipped = loadedOf(aliased, 'untrusted');
    expect(lexiconNote(skipped)).toBe(skippedProjectJson(skipped).note);
    expect(statsNote(skipped)).toBe(skippedProjectJson(skipped, 'Its terms are not in the counts.').note);
    expect(lexiconNote(loadedOf([]))).toBe(emptyLexiconNote());
    expect(statsNote(loadedOf([]))).toBe(emptyStatsNote(loadedOf([])));
    expect(exportNote(loadedOf(bare), 'csv', { limit: 5 })).toBe(emptyExportNote('no-rows', { format: 'csv', filter: '' }));
    expect(exportNote(loadedOf(aliased), 'csv', { categories: ['person'] })).toBe(
      "No term matched ?category=person, so the export is empty; lexicon list shows each term's category.",
    );
  });
});
