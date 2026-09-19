/**
 * Usage statistics over a loaded lexicon: how many terms/aliases exist, which
 * ones actually fire (hits are recorded by normalize_transcript / the hook)
 * and which never do, plus a per-file breakdown. Pure; no IO.
 */
import type { LoadedLexicon, TermScope } from './types.js';

export interface LexiconStats {
  termCount: number;
  aliasCount: number;
  totalHits: number;
  /** Top TOP_TERMS terms by hits, descending; terms with no hits are excluded. */
  topTerms: { canonical: string; hits: number }[];
  /** Canonicals with zero/undefined hits, in lexicon order, capped at NEVER_HIT_CAP. */
  neverHit: string[];
  /** Term count per category ("uncategorized" when unset). */
  byCategory: Record<string, number>;
  /** Term count per source ("unknown" when unset). */
  bySource: Record<string, number>;
  files: { path: string; scope: TermScope; terms: number }[];
}

export const TOP_TERMS = 10;
export const NEVER_HIT_CAP = 20;

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

export function computeStats(loaded: LoadedLexicon): LexiconStats {
  const terms = loaded.merged.terms;
  const byCategory: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  let aliasCount = 0;
  let totalHits = 0;
  const neverHit: string[] = [];

  for (const term of terms) {
    aliasCount += term.aliases.length;
    const hits = term.hits ?? 0;
    totalHits += hits;
    if (hits <= 0 && neverHit.length < NEVER_HIT_CAP) neverHit.push(term.canonical);
    bump(byCategory, term.category ?? 'uncategorized');
    bump(bySource, term.source ?? 'unknown');
  }

  const topTerms = terms
    .filter((t) => (t.hits ?? 0) > 0)
    .map((t) => ({ canonical: t.canonical, hits: t.hits ?? 0 }))
    .sort((a, b) => b.hits - a.hits || a.canonical.localeCompare(b.canonical))
    .slice(0, TOP_TERMS);

  const files: LexiconStats['files'] = [
    { path: loaded.global.path, scope: 'global', terms: loaded.global.lexicon.terms.length },
  ];
  if (loaded.project) {
    files.push({ path: loaded.project.path, scope: 'project', terms: loaded.project.lexicon.terms.length });
  }

  return { termCount: terms.length, aliasCount, totalHits, topTerms, neverHit, byCategory, bySource, files };
}
