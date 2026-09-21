/**
 * `buildIndex`: everything that depends only on the lexicon, precomputed once
 * so `findReplacements` can run over a transcript without touching a term
 * list. Exact aliases go in a map keyed by the folded form; phonetic keys go
 * in a second map; the fuzzy pass gets a flat list to scan.
 */
import { doubleMetaphone } from 'double-metaphone';
import type { Lexicon, Term } from '../types.js';
import {
  DEFAULT_MIN_CONFIDENCE,
  DOMAIN_SUFFIX,
  MAX_PHONETIC_KEYS_PER_TERM,
  MAX_WINDOW,
  PHONETIC_MIN_KEY,
  isNonWordToken,
} from './tuning.js';
import { alphaOnly, collapse, foldLower, squash } from './text.js';

export interface AliasEntry {
  readonly termIndex: number;
  readonly term: Term;
  /** The alias exactly as given (or the implicit alias derived from the canonical). */
  readonly alias: string;
  /** Whitespace-squashed, case and diacritics preserved. */
  readonly norm: string;
  /** `norm` with diacritics folded and lowercased. */
  readonly normLower: string;
  /** Letters+digits only, case preserved / folded and lowercased. */
  readonly collapsedRaw: string;
  readonly collapsed: string;
  readonly tokenCount: number;
  /** True when listed by the user in term.aliases (as opposed to derived from the canonical). */
  readonly explicit: boolean;
}

export interface PhoneticEntry {
  readonly termIndex: number;
  readonly term: Term;
  readonly alias: string;
  /** Alpha-only, diacritics-folded, lowercase form the key was computed from. */
  readonly alpha: string;
  /** Length of `alpha`. */
  readonly length: number;
  /**
   * True when this alias has several tokens and its first (respectively last)
   * one carries no word sound of its own: "Claude 4", "Kubernetes 1". The
   * phonetic pass refuses a window with such an edge token unless the alias has
   * one in the same place, so "clawd 4" still reaches "Claude 4" while "cooper
   * netties 2" cannot reach plain "Kubernetes". See isNonWordToken.
   */
  readonly startsNonWord: boolean;
  readonly endsNonWord: boolean;
}

export interface MatcherIndex {
  readonly lexicon: Lexicon;
  readonly minConfidence: number;
  readonly phonetic: boolean;
  readonly fuzzy: boolean;
  readonly skipCode: boolean;
  /** settings.protectedWords, lowercased. Blocks every pass, including explicit aliases. */
  readonly protectedWords: ReadonlySet<string>;
  /** Largest token window worth examining (<= MAX_WINDOW). */
  readonly maxWindow: number;
  /** Largest token window for the fuzzy pass (max alias token count). */
  readonly maxFuzzyWindow: number;
  /** Shortest/longest alpha length among phonetic entries; used to prune windows cheaply. */
  readonly phoneticMinLen: number;
  readonly phoneticMaxLen: number;
  /** normLower (diacritics folded) -> entries */
  readonly exact: ReadonlyMap<string, readonly AliasEntry[]>;
  /** collapsed (diacritics folded) -> entries */
  readonly collapsed: ReadonlyMap<string, readonly AliasEntry[]>;
  /** phonetic key -> entries */
  readonly phoneticKeys: ReadonlyMap<string, readonly PhoneticEntry[]>;
  /** token count -> entries (fuzzy only compares windows of equal token count) */
  readonly fuzzyBuckets: ReadonlyMap<number, readonly AliasEntry[]>;
  /** term index -> lowercased never-words (plain and collapsed forms) */
  readonly never: ReadonlyArray<ReadonlySet<string>>;
  /** term index -> true when the user listed at least one alias */
  readonly hasExplicitAliases: ReadonlyArray<boolean>;
}

export function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** True when every token is one or two letters: an acronym spelled out letter by letter. */
export function isSpelledOut(norm: string): boolean {
  return norm.split(' ').every((t) => alphaOnly(t).length <= 2);
}

/** Implicit aliases every canonical gets: itself and, for domain-like names, the stem. */
export function implicitAliases(canonical: string): string[] {
  const out = [canonical];
  const m = DOMAIN_SUFFIX.exec(canonical);
  if (m) out.push(m[1]);
  return out;
}

export function buildIndex(lexicon: Lexicon): MatcherIndex {
  const settings = lexicon.settings ?? {};
  const exact = new Map<string, AliasEntry[]>();
  const collapsed = new Map<string, AliasEntry[]>();
  const phoneticKeys = new Map<string, PhoneticEntry[]>();
  const fuzzyBuckets = new Map<number, AliasEntry[]>();
  const never: Set<string>[] = [];
  const hasExplicitAliases: boolean[] = [];
  let maxWindow = 1;
  let maxFuzzyWindow = 1;
  let phoneticMinLen = Number.POSITIVE_INFINITY;
  let phoneticMaxLen = 0;

  lexicon.terms.forEach((term, termIndex) => {
    const neverSet = new Set<string>();
    for (const w of term.never ?? []) {
      const n = foldLower(squash(w));
      if (!n) continue;
      neverSet.add(n);
      neverSet.add(collapse(n));
    }
    never.push(neverSet);
    hasExplicitAliases.push(term.aliases.some((a) => squash(a).length > 0));

    const seen = new Set<string>();
    const termKeys = new Set<string>();
    const candidates: Array<{ alias: string; explicit: boolean }> = [
      ...implicitAliases(term.canonical).map((alias) => ({ alias, explicit: false })),
      ...term.aliases.map((alias) => ({ alias, explicit: true })),
    ];

    for (const { alias, explicit } of candidates) {
      const norm = squash(alias);
      if (!norm) continue;
      const normLower = foldLower(norm);
      const collapsedRaw = norm.replace(/[^\p{L}\p{N}]+/gu, '');
      const collapsedLower = collapse(norm);
      if (!collapsedLower) continue;
      // Explicit wins over implicit when the user lists the canonical itself.
      const dedupeKey = `${normLower}\u0000${explicit ? 1 : 0}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const aliasTokens = normLower.split(' ');
      const tokenCount = aliasTokens.length;
      const startsNonWord = tokenCount > 1 && isNonWordToken(aliasTokens[0]);
      const endsNonWord = tokenCount > 1 && isNonWordToken(aliasTokens[tokenCount - 1]);
      const entry: AliasEntry = {
        termIndex,
        term,
        alias,
        norm,
        normLower,
        collapsedRaw,
        collapsed: collapsedLower,
        tokenCount,
        explicit,
      };
      push(exact, normLower, entry);
      push(collapsed, collapsedLower, entry);
      push(fuzzyBuckets, tokenCount, entry);
      maxWindow = Math.max(maxWindow, tokenCount);
      maxFuzzyWindow = Math.max(maxFuzzyWindow, tokenCount);

      // Phonetic key, capped per term. Spelled-out letters ("j w t", "ay ar ar")
      // exist for the exact pass only: their keys are one or two consonants
      // that every second English word shares.
      const alpha = alphaOnly(norm);
      if (alpha.length >= 3 && !isSpelledOut(norm) && termKeys.size < MAX_PHONETIC_KEYS_PER_TERM) {
        const key = doubleMetaphone(alpha)[0];
        if (key.length >= PHONETIC_MIN_KEY) {
          const dedupePhonetic = `${key}\u0000${alpha.length}`;
          if (!termKeys.has(dedupePhonetic)) {
            termKeys.add(dedupePhonetic);
            push(phoneticKeys, key, { termIndex, term, alias, alpha, length: alpha.length, startsNonWord, endsNonWord });
            phoneticMinLen = Math.min(phoneticMinLen, alpha.length);
            phoneticMaxLen = Math.max(phoneticMaxLen, alpha.length);
            // STT tends to split one long word into several ("pie dentic"), so
            // allow windows wide enough to reassemble it. The alias's own
            // no-sound tokens are counted on top: `alpha` drops them, so
            // "Postgres 16" budgets two tokens for a garble that needs three
            // ("post gres 16") and the 16 was left stranded beside the rewrite.
            const noSound = aliasTokens.filter((t) => isNonWordToken(t)).length;
            maxWindow = Math.max(maxWindow, Math.ceil(alpha.length / 4) + noSound);
          }
        }
      }
    }
  });

  if (!Number.isFinite(phoneticMinLen)) phoneticMinLen = 0;

  const protectedWords = new Set<string>();
  for (const w of settings.protectedWords ?? []) {
    const n = foldLower(squash(w));
    if (n) protectedWords.add(n);
  }

  return {
    lexicon,
    hasExplicitAliases,
    minConfidence: settings.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    phonetic: settings.phonetic ?? true,
    fuzzy: settings.fuzzy ?? true,
    skipCode: settings.skipCode ?? true,
    protectedWords,
    maxWindow: Math.min(MAX_WINDOW, maxWindow),
    maxFuzzyWindow: Math.min(MAX_WINDOW, maxFuzzyWindow),
    phoneticMinLen,
    phoneticMaxLen,
    exact,
    collapsed,
    phoneticKeys,
    fuzzyBuckets,
    never,
  };
}
