/** Opt-in, async whole-term matching. The synchronous transcript matcher never calls a model. */
import { buildIndex, collectRanges, DEFAULT_MIN_CONFIDENCE, findReplacements, foldLower as fold, similarity, STOPLIST } from '../core/index.js';
import type { Lexicon, MatchReason, NormalizeOptions } from '../core/index.js';
import { embeddingConfig, localEmbeddings, MAX_EMBEDDING_INPUTS } from './local-embeddings.js';
import type { LocalEmbeddingOptions } from './local-embeddings.js';

export interface SemanticMatchOptions extends NormalizeOptions {
  /** Omit this object, or leave enabled false, for zero model IO. */
  semantic?: LocalEmbeddingOptions & {
    enabled?: boolean;
    /** Cosine similarity, not a calibrated probability. Default 0.85; range 0.85..1. */
    minSimilarity?: number;
    /** Winner's cosine lead over the next canonical. Default 0.05; range 0.05..1. */
    minMargin?: number;
  };
  signal?: AbortSignal;
}

export interface TermMatch {
  canonical: string;
  reason: MatchReason | 'embedding';
  /** Existing matcher confidence, or cosine similarity for an embedding match. */
  confidence: number;
}

export interface TermMatchResult {
  match?: TermMatch;
  semantic: 'disabled' | 'not-needed' | 'no-match' | 'matched' | 'unavailable' | 'limited';
}

const collapse = (s: string): string => fold(s).replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Resolve one dictated name, not a sentence. Existing matches always win.
 * Models only break unresolved spelling ties; synonyms alone are not spelling evidence.
 * Pass a trusted/merged lexicon from loadLexicon, as with normalize(). No writes or caches.
 */
export async function matchTerm(
  heard: string, lexicon: Lexicon, options: SemanticMatchOptions = {},
): Promise<TermMatchResult> {
  const disabled = options.semantic?.enabled !== true;
  const noMatch = { semantic: disabled ? 'disabled' : 'no-match' } as const;
  // A whole-term API is deliberately bounded before building an index or scanning text.
  if (heard.length === 0 || heard.length > 80) return { semantic: disabled ? 'disabled' : 'limited' };
  const index = buildIndex(lexicon);
  const baseline = findReplacements(heard, index, options);
  const whole = baseline.find(r => r.start === 0 && r.end === heard.length);
  if (whole) return { match: { canonical: whole.canonical, reason: whole.reason, confidence: whole.confidence }, semantic: disabled ? 'disabled' : 'not-needed' };
  if (disabled) return noMatch;
  // Partial baseline hits and canonical no-op claims must never be swallowed by a model.
  if (baseline.length || index.aliasEntries.some(e => e.normLower === fold(heard))) return noMatch;
  const config = options.semantic!;
  embeddingConfig(config); // Configuration errors are actionable; model failures abstain below.
  const minSimilarity = config.minSimilarity ?? 0.85;
  const minMargin = config.minMargin ?? 0.05;
  const confidence = options.minConfidence ?? index.minConfidence;
  const minConfidence = Number.isNaN(confidence) ? DEFAULT_MIN_CONFIDENCE : Math.min(1, Math.max(0, confidence));
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0.85 || minSimilarity > 1 ||
      !Number.isFinite(minMargin) || minMargin < 0.05 || minMargin > 1) {
    throw new Error('Semantic minSimilarity must be 0.85..1 and minMargin must be 0.05..1.');
  }
  // Fallback has stricter safety gates than aliases: name fragments only, at most four words.
  // Punctuation, possessives, plural suffix handling and identifier boundaries stay with core.
  if (!/^\p{L}{3,}(?: \p{L}{3,}){0,3}$/u.test(heard) || collectRanges(heard).length) return noMatch;
  const words = fold(heard).split(' ');
  if (words.some(w => STOPLIST.has(w) || index.protectedWords.has(w))) return noMatch;
  if (options.shouldStop?.() || options.signal?.aborted) return { semantic: 'unavailable' };
  const normalized = fold(heard);
  const collapsed = collapse(heard);
  // Do not consume any part of an already canonical multiword name.
  if (lexicon.terms.some(t => fold(t.canonical).split(/[^\p{L}\p{N}]+/u).some(w => words.includes(w)))) return noMatch;

  // Embed all eligible spellings together, not just the nearest spelling. Runner-up scores
  // are aggregated per canonical, so two aliases of one name cannot create false ambiguity.
  const entries = index.aliasEntries.filter(e => !e.term.caseSensitive &&
    !index.never[e.termIndex].has(normalized) && !index.never[e.termIndex].has(collapsed) &&
    e.collapsed[0] === collapsed[0] && similarity(e.collapsed, collapsed) >= 0.5);
  const spellings = [...new Set(entries.map(e => e.alias))];
  if (!spellings.length) return noMatch;
  // Never silently truncate the field: that could hide the true runner-up.
  if (spellings.length + 1 > MAX_EMBEDDING_INPUTS || spellings.some(s => s.length > 80)) return { semantic: 'limited' };
  try {
    const vectors = await localEmbeddings([heard, ...spellings], config, options.signal);
    if (options.shouldStop?.()) return { semantic: 'unavailable' };
    const scores = new Map<string, number>();
    // Shared aliases can occur under many canonicals. Score each spelling once,
    // keeping vector work bounded by the batch size rather than lexicon size.
    const bySpelling = new Map(spellings.map((s, i) => [s, Math.max(-1, Math.min(1,
      vectors[0].reduce((sum, v, d) => sum + v * vectors[i + 1][d], 0),
    ))]));
    for (const entry of entries) {
      const score = bySpelling.get(entry.alias)!;
      scores.set(entry.term.canonical, Math.max(scores.get(entry.term.canonical) ?? -1, score));
    }
    const ranked = [...scores].sort((a, b) => b[1] - a[1]);
    const [canonical, score] = ranked[0];
    const margin = score - (ranked[1]?.[1] ?? -1);
    if (score < Math.max(minSimilarity, minConfidence) || margin < minMargin) return noMatch;
    return { match: { canonical, confidence: score, reason: 'embedding' }, semantic: 'matched' };
  } catch {
    // Refusal, timeout, malformed output or cancellation cannot erase a baseline result.
    // Do not log model responses or heard text: these can contain personal vocabulary.
    return { semantic: 'unavailable' };
  }
}
