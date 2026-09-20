/**
 * Matching core. Pure functions, no IO.
 *
 * buildIndex() (./matcher/build.ts) precomputes everything that depends only
 * on the lexicon; findReplacements() tokenizes the input once and slides token
 * windows over it, trying three passes per window in priority order (exact
 * alias, phonetic, fuzzy), then resolves overlaps: exact alias hits first, then
 * inexact hits that do not overlap them (longest span wins, earlier start on
 * ties).
 *
 * The pieces live next door and are re-exported here, because `./matcher.js`
 * is the import path core/index.ts and the tests use:
 *   ./matcher/tuning.ts    every threshold and weight (what the bench measures)
 *   ./matcher/text.ts      folding, phonetic keys, edit distance
 *   ./matcher/tokenize.ts  tokens and the ranges to skip
 *   ./matcher/build.ts     buildIndex and the index shape
 */
import { doubleMetaphone } from 'double-metaphone';
import { distance } from 'fastest-levenshtein';
import type { MatchReason, NormalizeOptions, Replacement } from './types.js';
import {
  ALIASED_PLAIN_WORD_MIN,
  DEFAULT_MIN_CONFIDENCE,
  FUNCTION_WORDS,
  PHONETIC_BASE,
  PHONETIC_LENGTH_WEIGHT,
  PHONETIC_LONE_TOKEN_MIN_SIM,
  PHONETIC_MIN_KEY,
  PHONETIC_MIN_WINDOW,
  VOWEL_RE,
  loneTokenMinSim,
} from './matcher/tuning.js';
import { alphaOnly, similarity } from './matcher/text.js';
import { STOPLIST } from './stoplist.js';
import { tokenize } from './matcher/tokenize.js';
import type { Token } from './matcher/tokenize.js';
import type { AliasEntry, MatcherIndex, PhoneticEntry } from './matcher/build.js';

export { DEFAULT_MIN_CONFIDENCE } from './matcher/tuning.js';
export { phoneticKey, similarity } from './matcher/text.js';
export { buildIndex } from './matcher/build.js';
export type { AliasEntry, MatcherIndex, PhoneticEntry } from './matcher/build.js';
/** Re-exported from stoplist.ts: core/index.ts has always surfaced it through here. */
export { STOPLIST } from './stoplist.js';

interface WindowView {
  readonly start: number;
  readonly end: number;
  readonly original: string;
  /** `original` without a trailing possessive ('s / ’s); same as original when none. */
  readonly stem: string;
  readonly norm: string;
  readonly normLower: string;
  readonly collapsedRaw: string;
  readonly collapsed: string;
  readonly tokenCount: number;
  /** Every token is a stoplist/protected word. */
  readonly allStop: boolean;
  /**
   * Every token is a stoplist word, a protected word, or a 1-2 character abbreviation, with at
   * least one real stoplist word. Blocks phonetic/fuzzy only: "ms window" must never become a
   * person's name, but the implicit alias "open ai" -> OpenAI still matches exactly.
   */
  readonly mostlyStop: boolean;
  /** Some token is a protected word (settings.protectedWords). */
  readonly anyProtected: boolean;
  /** Multi-token window whose first or last token is a function word (see FUNCTION_WORDS). */
  readonly edgeFunctionWord: boolean;
  /** Single-token window (any case): held to ALIASED_PLAIN_WORD_MIN in the phonetic pass against terms with explicit aliases. */
  readonly loneToken: boolean;
  /** Single all-lowercase alphabetic token: held to ALIASED_PLAIN_WORD_MIN in the fuzzy pass as well. */
  readonly plainWord: boolean;
  readonly digitsOnly: boolean;
}

interface Candidate extends Replacement {
  readonly termIndex: number;
  /**
   * A claim: the span already reads as the canonical, so nothing is rewritten,
   * but the span still takes part in overlap resolution so no other term can
   * grab a token inside it ("Tadeusz" in "Tadeusz Wróblewski" is not TTS).
   * Claims are dropped from the result.
   */
  readonly noop: boolean;
}

const REASON_RANK: Record<MatchReason, number> = { alias: 0, phonetic: 1, fuzzy: 2 };

/**
 * Identifier glue. A window whose first token is directly preceded (no
 * whitespace) by one of GLUE_BEFORE, or whose end is directly followed by one
 * of GLUE_AFTER, is part of a typed identifier, never a dictated garble:
 * `@ashlr/lexicon`, `ashlrai/lexicon`, `ashlr_core`, `#ashlr`, `~/ashlr`,
 * `C:\ashlr`, `-ashlr`. No pass considers it, the exact alias pass included
 * (the implicit stem alias of Ashlr.AI turned `@ashlr/lexicon` into
 * `@Ashlr.AI/lexicon` in production). Only the characters outside the window
 * are examined, so an alias that itself carries a hyphen ("ashler-ai") still
 * matches as one window. A hyphen after the window is not glue (`ashler- it`
 * keeps matching; a glued `ashler-core` is one token and matches nothing), and
 * neither is a possessive `'s` or sentence punctuation, so "ashler's team" and
 * "ashler." are rewritten as before.
 * Skipped ranges (code spans, URLs, paths) are handled by the tokenizer; this
 * is the complement for glue the range regexes cannot see.
 */
const GLUE_BEFORE: ReadonlySet<string> = new Set(['@', '/', '#', ':', '\\', '~', '_', '-']);
const GLUE_AFTER: ReadonlySet<string> = new Set(['/', '\\', '_']);

/** True when the character right after `end` glues the window to an identifier (see GLUE_AFTER). */
function gluedAfter(text: string, end: number): boolean {
  return GLUE_AFTER.has(text.charAt(end));
}

function isBetter(a: Candidate, b: Candidate | undefined): boolean {
  if (!b) return true;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence;
  if (REASON_RANK[a.reason] !== REASON_RANK[b.reason]) return REASON_RANK[a.reason] < REASON_RANK[b.reason];
  return a.termIndex < b.termIndex;
}

function makeView(
  text: string,
  tokens: readonly Token[],
  from: number,
  to: number,
  possessiveBase: boolean,
  protectedWords: ReadonlySet<string>,
): WindowView {
  const first = tokens[from];
  const last = tokens[to];
  const end = possessiveBase ? last.baseEnd : last.end;
  const parts: string[] = [];
  const lowerParts: string[] = [];
  let allStop = true;
  let anyProtected = false;
  let stopCount = 0;
  let mostlyStop = true;
  for (let i = from; i <= to; i++) {
    const t = tokens[i];
    const useBase = i === to && possessiveBase;
    parts.push(useBase ? t.base : t.text);
    lowerParts.push(useBase ? t.baseLower : t.textLower);
    const lower = t.baseLower;
    const isProtected = protectedWords.has(lower);
    if (isProtected) anyProtected = true;
    const isStop = STOPLIST.has(lower);
    if (isStop) stopCount++;
    if (!isProtected && !isStop) allStop = false;
    if (!isProtected && !isStop && lower.length > 2) mostlyStop = false;
  }
  if (stopCount === 0) mostlyStop = false;
  const norm = parts.join(' ');
  const normLower = lowerParts.join(' ');
  const collapsedRaw = norm.replace(/[^\p{L}\p{N}]+/gu, '');
  return {
    start: first.start,
    end,
    original: text.slice(first.start, end),
    stem: text.slice(first.start, last.baseEnd),
    norm,
    normLower,
    collapsedRaw,
    collapsed: normLower.replace(/[^\p{L}\p{N}]+/gu, ''),
    tokenCount: to - from + 1,
    allStop,
    mostlyStop,
    anyProtected,
    edgeFunctionWord: to > from && (FUNCTION_WORDS.has(first.baseLower) || FUNCTION_WORDS.has(last.baseLower)),
    loneToken: from === to,
    plainWord: from === to && /^\p{Ll}+$/u.test(norm),
    digitsOnly: /^\p{N}+$/u.test(collapsedRaw),
  };
}

function findBest(view: WindowView, index: MatcherIndex, opts: Required<Omit<NormalizeOptions, 'dryRun'>>): Candidate | undefined {
  // Held in an object read through a getter: TS does not invalidate narrowing of
  // a local across the closure calls below, so a plain `let best` narrows to never.
  const state: { best: Candidate | undefined } = { best: undefined };
  const current = (): Candidate | undefined => state.best;

  // Already canonical (possibly with a possessive: "Ashlr.AI's" stays as is).
  const alreadyCanonical = (entry: AliasEntry | PhoneticEntry): boolean =>
    view.original === entry.term.canonical || view.stem === entry.term.canonical;

  const blocked = (entry: AliasEntry | PhoneticEntry): boolean => {
    if (alreadyCanonical(entry)) return true;
    const never = index.never[entry.termIndex];
    return never.has(view.normLower) || never.has(view.collapsed);
  };

  const consider = (entry: AliasEntry | PhoneticEntry, reason: MatchReason, confidence: number): void => {
    const cand: Candidate = {
      start: view.start,
      end: view.end,
      original: view.original,
      replacement: entry.term.canonical,
      canonical: entry.term.canonical,
      reason,
      confidence,
      termIndex: entry.termIndex,
      noop: view.original === entry.term.canonical,
    };
    if (isBetter(cand, state.best)) state.best = cand;
  };

  // --- pass a: exact alias (plain, then punctuation-stripped) ---------------
  const tryExact = (entries: readonly AliasEntry[] | undefined, viaCollapsed: boolean): void => {
    if (!entries) return;
    for (const e of entries) {
      if (e.term.caseSensitive) {
        if (viaCollapsed ? e.collapsedRaw !== view.collapsedRaw : e.norm !== view.norm) continue;
      }
      if (view.anyProtected) continue;
      if (!e.explicit && view.allStop) continue;
      if (alreadyCanonical(e)) {
        // Claim the span (see Candidate.noop); the possessive-base view is the
        // one that equals the canonical when the text reads "Wispr Flow's".
        if (view.original === e.term.canonical) consider(e, 'alias', 1);
        continue;
      }
      if (blocked(e)) continue;
      consider(e, 'alias', 1);
    }
  };
  tryExact(index.exact.get(view.normLower), false);
  if (!current()) tryExact(index.collapsed.get(view.collapsed), true);
  const exactHit = current();
  if (exactHit) return exactHit;

  // Shared guards for the inexact passes.
  if (view.allStop || view.mostlyStop || view.anyProtected || view.digitsOnly || view.edgeFunctionWord) return undefined;
  const barFor = (termIndex: number, lone: boolean): number =>
    lone && index.hasExplicitAliases[termIndex] ? Math.max(opts.minConfidence, ALIASED_PLAIN_WORD_MIN) : opts.minConfidence;

  // --- pass b: phonetic -----------------------------------------------------
  if (opts.phonetic && index.phoneticKeys.size > 0) {
    const alpha = alphaOnly(view.collapsed);
    if (
      alpha.length >= 3 &&
      alpha.length * 2 >= index.phoneticMinLen &&
      alpha.length <= index.phoneticMaxLen * 2
    ) {
      const key = doubleMetaphone(alpha)[0];
      const entries = key.length >= PHONETIC_MIN_KEY ? index.phoneticKeys.get(key) : undefined;
      if (entries) {
        for (const e of entries) {
          // Phonetic keys cannot honour case; case-sensitive terms are exact/fuzzy only.
          if (e.term.caseSensitive) continue;
          if (alpha.length < Math.min(PHONETIC_MIN_WINDOW, e.length)) continue;
          const max = Math.max(alpha.length, e.length);
          const diffRatio = Math.abs(alpha.length - e.length) / max;
          const confidence = PHONETIC_BASE * (1 - diffRatio * PHONETIC_LENGTH_WEIGHT);
          if (confidence < barFor(e.termIndex, view.loneToken)) continue;
          if (view.loneToken) {
            const sim = similarity(alpha, e.alpha);
            // A short key is weak evidence; the spelling has to agree too
            // ("lacks" / "locus" share LKS at similarity 0.6).
            if (sim < loneTokenMinSim(key.length)) continue;
            // A lone token that keys alike only because metaphone dropped its
            // initial vowel ("inter" / "entire") is a different word, not a garble.
            if (
              alpha.charCodeAt(0) !== e.alpha.charCodeAt(0) &&
              (VOWEL_RE.test(alpha) || VOWEL_RE.test(e.alpha)) &&
              sim < PHONETIC_LONE_TOKEN_MIN_SIM
            ) {
              continue;
            }
          }
          if (blocked(e)) continue;
          consider(e, 'phonetic', confidence);
        }
      }
    }
  }

  // --- pass c: fuzzy --------------------------------------------------------
  if (opts.fuzzy && view.normLower.length >= 4 && view.tokenCount <= index.maxFuzzyWindow) {
    const bucket = index.fuzzyBuckets.get(view.tokenCount);
    if (bucket) {
      const wlen = view.normLower.length;
      for (const e of bucket) {
        const max = Math.max(wlen, e.normLower.length);
        // similarity <= 1 - |lenDiff| / max, so prune before running any edit distance.
        if (Math.abs(wlen - e.normLower.length) > (1 - opts.minConfidence) * max) continue;
        const bar = barFor(e.termIndex, view.plainWord);
        const a = e.term.caseSensitive ? view.norm : view.normLower;
        const b = e.term.caseSensitive ? e.norm : e.normLower;
        // A swap saves at most one edit over plain Levenshtein, so the
        // transposition-aware distance is at least half of it: bound with the
        // bit-parallel distance first and only run the O(n*m) OSA on near misses.
        if (1 - Math.ceil(distance(a, b) / 2) / max < bar) continue;
        const sim = similarity(a, b);
        if (sim < bar) continue;
        const soFar = current();
        if (soFar && sim <= soFar.confidence) continue;
        if (blocked(e)) continue;
        consider(e, 'fuzzy', sim);
      }
    }
  }

  return current();
}

/**
 * Find every replacement the lexicon implies for `text`. Result is sorted by
 * start offset and non-overlapping; longest span wins, earlier start on ties.
 */
export function findReplacements(text: string, index: MatcherIndex, opts: NormalizeOptions = {}): Replacement[] {
  if (text.length === 0 || index.lexicon.terms.length === 0) return [];
  const resolved = {
    minConfidence: clamp01(opts.minConfidence ?? index.minConfidence),
    phonetic: opts.phonetic ?? index.phonetic,
    fuzzy: opts.fuzzy ?? index.fuzzy,
    skipCode: opts.skipCode ?? index.skipCode,
  };

  const tokens = tokenize(text, resolved.skipCode);
  const candidates: Candidate[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].skipped) continue;
    // Every window starting here shares this left edge, so one check covers them all.
    if (GLUE_BEFORE.has(text.charAt(tokens[i].start - 1))) continue;
    for (let n = 1; n <= index.maxWindow; n++) {
      const j = i + n - 1;
      if (j >= tokens.length) break;
      const last = tokens[j];
      if (last.skipped) break;
      if (n > 1 && !tokens[j - 1].joinsNext) break;

      const full = makeView(text, tokens, i, j, false, index.protectedWords);
      let best = gluedAfter(text, full.end) ? undefined : findBest(full, index, resolved);

      // A trailing possessive ("ashler ai's") is almost never part of the
      // term: when the view without it matches the same term, or matches at
      // least as confidently, keep the 's in the text and replace only the base.
      if (last.baseEnd < last.end) {
        const alt = makeView(text, tokens, i, j, true, index.protectedWords);
        const bestAlt = gluedAfter(text, alt.end) ? undefined : findBest(alt, index, resolved);
        if (bestAlt && (!best || bestAlt.termIndex === best.termIndex || bestAlt.confidence >= best.confidence)) best = bestAlt;
      }
      if (best) candidates.push(best);
    }
  }

  // Resolve overlaps. Exact alias hits are claimed first (longest span, then
  // earliest start); inexact candidates only get what is left, so a phonetic
  // window that merely swallows a neighbouring word can never beat the exact
  // hit it contains.
  candidates.sort((a, b) => {
    const ta = a.reason === 'alias' ? 0 : 1;
    const tb = b.reason === 'alias' ? 0 : 1;
    if (ta !== tb) return ta - tb;
    const la = a.end - a.start;
    const lb = b.end - b.start;
    if (la !== lb) return lb - la;
    if (a.start !== b.start) return a.start - b.start;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return REASON_RANK[a.reason] - REASON_RANK[b.reason];
  });

  const accepted: Candidate[] = [];
  for (const c of candidates) {
    let overlaps = false;
    for (const a of accepted) {
      if (c.start < a.end && a.start < c.end) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) accepted.push(c);
  }
  accepted.sort((a, b) => a.start - b.start);

  return accepted.filter((c) => !c.noop).map(({ termIndex: _termIndex, noop: _noop, ...rest }) => rest);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return DEFAULT_MIN_CONFIDENCE;
  return Math.min(1, Math.max(0, n));
}
