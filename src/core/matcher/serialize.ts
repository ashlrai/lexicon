/**
 * A `MatcherIndex` as plain JSON, and back.
 *
 * `buildIndex` folds, collapses and metaphone-keys every alias of every term:
 * for a 2000-term lexicon that was about 55 ms of the prompt hook, paid again
 * on every prompt because each prompt is a fresh process. The hook keeps the
 * result on disk (see `loadMatcherIndex` in store.ts) and this module is the
 * pure half of that: what goes into the file and how it comes back.
 *
 * Correctness rests on two things.
 *
 * - `indexKey(lexicon)` is the whole of what `buildIndex` reads from a
 *   lexicon: every term's canonical, aliases, never-words and caseSensitive
 *   flag, in order, plus the settings it consults. A cached index is used only
 *   when its stored key equals the key of the lexicon in hand, character for
 *   character, so it is the index `buildIndex` would have produced for exactly
 *   these inputs. Fields the matcher never reads (hits, notes, category, ...)
 *   are left out on purpose: `hits` changes after almost every corrected
 *   prompt and must not throw the cache away.
 * - `INDEX_FORMAT_VERSION` names the code that built the index. Any change to
 *   buildIndex, its helpers or the constants it uses must bump it; a test
 *   (tests/index-cache.test.ts) fingerprints those source files and fails
 *   until the version is bumped, so a stale index from an older build is
 *   never read as current.
 *
 * `deserializeIndex` checks the type of everything it rebuilds and returns
 * `undefined` on the first thing that is off, so a truncated or hand-edited
 * file costs a rebuild, never a wrong match or a crash.
 */
import type { Lexicon, Term } from '../types.js';
import type { AliasEntry, MatcherIndex, PhoneticEntry } from './build.js';
import { push, sortFuzzyBuckets } from './build.js';

/** Bump whenever buildIndex (or anything it calls) could produce a different index for the same lexicon. */
export const INDEX_FORMAT_VERSION = 1;

/**
 * Exactly what buildIndex reads from `lexicon`, as one string. Two lexicons
 * with the same key build the same index.
 */
export function indexKey(lexicon: Lexicon): string {
  const s = lexicon.settings ?? {};
  return JSON.stringify([
    INDEX_FORMAT_VERSION,
    s.minConfidence ?? null,
    s.phonetic ?? null,
    s.fuzzy ?? null,
    s.skipCode ?? null,
    s.protectedWords ?? null,
    lexicon.terms.map((t) => [t.canonical, t.aliases, t.never ?? null, t.caseSensitive === true]),
  ]);
}

/**
 * Alias entry tuple: termIndex, alias, norm, normLower, collapsedRaw,
 * collapsed, separators, explicit (0/1), tokenCount. A string field that
 * repeats the one it is derived from is stored as 0 (norm from alias,
 * normLower from norm, collapsedRaw from norm, collapsed from normLower).
 */
type AliasTuple = [number, string, string | 0, string | 0, string | 0, string | 0, number[], 0 | 1, number];
/** Phonetic entry tuple: termIndex, alias, alpha, key, flags (1 = startsNonWord, 2 = endsNonWord). */
type PhoneticTuple = [number, string, string, string, number];

export interface SerializedIndex {
  readonly v: number;
  readonly minConfidence: number;
  readonly phonetic: boolean;
  readonly fuzzy: boolean;
  readonly skipCode: boolean;
  readonly protectedWords: string[];
  readonly maxWindow: number;
  readonly maxFuzzyWindow: number;
  readonly phoneticMinLen: number;
  readonly phoneticMaxLen: number;
  readonly aliases: AliasTuple[];
  readonly phonetics: PhoneticTuple[];
  readonly never: string[][];
  readonly hasExplicitAliases: (0 | 1)[];
}

export function serializeIndex(index: MatcherIndex): SerializedIndex {
  return {
    v: INDEX_FORMAT_VERSION,
    minConfidence: index.minConfidence,
    phonetic: index.phonetic,
    fuzzy: index.fuzzy,
    skipCode: index.skipCode,
    protectedWords: [...index.protectedWords],
    maxWindow: index.maxWindow,
    maxFuzzyWindow: index.maxFuzzyWindow,
    phoneticMinLen: index.phoneticMinLen,
    phoneticMaxLen: index.phoneticMaxLen,
    aliases: index.aliasEntries.map((e) => [
      e.termIndex,
      e.alias,
      e.norm === e.alias ? 0 : e.norm,
      e.normLower === e.norm ? 0 : e.normLower,
      e.collapsedRaw === e.norm ? 0 : e.collapsedRaw,
      e.collapsed === e.normLower ? 0 : e.collapsed,
      [...e.separators],
      e.explicit ? 1 : 0,
      e.tokenCount,
    ]),
    phonetics: index.phoneticEntries.map((e) => [e.termIndex, e.alias, e.alpha, e.key, (e.startsNonWord ? 1 : 0) | (e.endsNonWord ? 2 : 0)]),
    never: index.never.map((s) => [...s]),
    hasExplicitAliases: index.hasExplicitAliases.map((b) => (b ? 1 : 0)),
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isArr = Array.isArray;

/**
 * Rebuild the index serializeIndex wrote, bound to `lexicon` (whose key the
 * caller has already matched). `undefined` when anything in `data` is not the
 * shape serializeIndex writes.
 */
export function deserializeIndex(data: unknown, lexicon: Lexicon): MatcherIndex | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const d = data as Record<string, unknown>;
  if (d.v !== INDEX_FORMAT_VERSION) return undefined;
  if (!isNum(d.minConfidence) || !isBool(d.phonetic) || !isBool(d.fuzzy) || !isBool(d.skipCode)) return undefined;
  if (!isInt(d.maxWindow) || !isInt(d.maxFuzzyWindow) || !isNum(d.phoneticMinLen) || !isNum(d.phoneticMaxLen)) return undefined;
  if (!isArr(d.protectedWords) || !d.protectedWords.every(isStr)) return undefined;
  if (!isArr(d.aliases) || !isArr(d.phonetics) || !isArr(d.never) || !isArr(d.hasExplicitAliases)) return undefined;
  const terms: readonly Term[] = lexicon.terms;
  const n = terms.length;
  if (d.never.length !== n || d.hasExplicitAliases.length !== n) return undefined;

  const aliasEntries: AliasEntry[] = [];
  const phoneticEntries: PhoneticEntry[] = [];
  const exact = new Map<string, AliasEntry[]>();
  const collapsed = new Map<string, AliasEntry[]>();
  const fuzzyBuckets = new Map<number, AliasEntry[]>();
  // Indexed loops and no destructuring: this runs once per hook process, in
  // V8's interpreter, where an array destructure walks the iterator protocol.
  const aliases = d.aliases as unknown[];
  for (let i = 0; i < aliases.length; i++) {
    const t = aliases[i];
    if (!isArr(t) || t.length !== 9) return undefined;
    const termIndex = t[0] as unknown;
    const alias = t[1] as unknown;
    const normRaw = t[2] as unknown;
    const normLowerRaw = t[3] as unknown;
    const collapsedRawRaw = t[4] as unknown;
    const collapsedLowerRaw = t[5] as unknown;
    const seps = t[6] as unknown;
    const explicit = t[7] as unknown;
    const tokenCount = t[8] as unknown;
    if (!isInt(termIndex) || termIndex >= n || typeof alias !== 'string') return undefined;
    if (!(normRaw === 0 || typeof normRaw === 'string') || !(normLowerRaw === 0 || typeof normLowerRaw === 'string')) return undefined;
    if (!(collapsedRawRaw === 0 || typeof collapsedRawRaw === 'string') || !(collapsedLowerRaw === 0 || typeof collapsedLowerRaw === 'string')) return undefined;
    if (!isArr(seps) || (explicit !== 0 && explicit !== 1) || !isInt(tokenCount) || tokenCount < 1) return undefined;
    for (let k = 0; k < seps.length; k++) if (!isInt(seps[k])) return undefined;
    const norm = normRaw === 0 ? alias : normRaw;
    const normLower = normLowerRaw === 0 ? norm : normLowerRaw;
    const collapsedLower = collapsedLowerRaw === 0 ? normLower : collapsedLowerRaw;
    const entry: AliasEntry = {
      termIndex,
      term: terms[termIndex],
      alias,
      norm,
      normLower,
      collapsedRaw: collapsedRawRaw === 0 ? norm : collapsedRawRaw,
      collapsed: collapsedLower,
      tokenCount,
      separators: new Set(seps as number[]),
      explicit: explicit === 1,
    };
    aliasEntries.push(entry);
    push(exact, normLower, entry);
    push(collapsed, collapsedLower, entry);
    push(fuzzyBuckets, tokenCount, entry);
  }

  sortFuzzyBuckets(fuzzyBuckets);

  const phoneticKeys = new Map<string, PhoneticEntry[]>();
  const phonetics = d.phonetics as unknown[];
  for (let i = 0; i < phonetics.length; i++) {
    const t = phonetics[i];
    if (!isArr(t) || t.length !== 5) return undefined;
    const termIndex = t[0] as unknown;
    const alias = t[1] as unknown;
    const alpha = t[2] as unknown;
    const key = t[3] as unknown;
    const flags = t[4] as unknown;
    if (!isInt(termIndex) || termIndex >= n || typeof alias !== 'string' || typeof alpha !== 'string') return undefined;
    if (typeof key !== 'string' || key === '' || !isInt(flags)) return undefined;
    const entry: PhoneticEntry = {
      termIndex,
      term: terms[termIndex],
      alias,
      alpha,
      length: alpha.length,
      key,
      startsNonWord: (flags & 1) !== 0,
      endsNonWord: (flags & 2) !== 0,
    };
    phoneticEntries.push(entry);
    push(phoneticKeys, key, entry);
  }

  const never: Set<string>[] = [];
  for (const words of d.never as unknown[]) {
    if (!isArr(words) || !words.every(isStr)) return undefined;
    never.push(new Set(words));
  }
  const hasExplicitAliases: boolean[] = [];
  for (const b of d.hasExplicitAliases as unknown[]) {
    if (b !== 0 && b !== 1) return undefined;
    hasExplicitAliases.push(b === 1);
  }

  return {
    lexicon,
    hasExplicitAliases,
    minConfidence: d.minConfidence,
    phonetic: d.phonetic,
    fuzzy: d.fuzzy,
    skipCode: d.skipCode,
    protectedWords: new Set(d.protectedWords as string[]),
    maxWindow: d.maxWindow,
    maxFuzzyWindow: d.maxFuzzyWindow,
    phoneticMinLen: d.phoneticMinLen,
    phoneticMaxLen: d.phoneticMaxLen,
    exact,
    collapsed,
    phoneticKeys,
    fuzzyBuckets,
    never,
    aliasEntries,
    phoneticEntries,
  };
}
