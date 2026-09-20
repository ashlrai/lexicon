/**
 * Matching core. Pure functions, no IO.
 *
 * buildIndex() precomputes everything that depends only on the lexicon;
 * findReplacements() tokenizes the input once and slides token windows over it,
 * trying three passes per window in priority order (exact alias, phonetic,
 * fuzzy), then resolves overlaps: exact alias hits first, then inexact hits
 * that do not overlap them (longest span wins, earlier start on ties).
 */
import { doubleMetaphone } from 'double-metaphone';
import { distance } from 'fastest-levenshtein';
import { STOPLIST } from './stoplist.js';
import type { Lexicon, MatchReason, NormalizeOptions, Replacement, Term } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MIN_CONFIDENCE = 0.82;
/** Longest token window we ever consider. */
const MAX_WINDOW = 5;
/** Base confidence of a phonetic hit before the length penalty. */
const PHONETIC_BASE = 0.9;
/**
 * How strongly a length mismatch reduces phonetic confidence. Double-metaphone
 * keys ignore vowels, so identical keys with a moderate length difference are
 * still the same word said differently ("coopernetties" vs "kubernetes",
 * 13 vs 10 chars). A full-strength penalty (weight 1) would push every real
 * STT mangling below the default threshold; 0.25 lets a ~35% length gap pass.
 */
const PHONETIC_LENGTH_WEIGHT = 0.25;
/** Upper bound on distinct phonetic keys indexed per term. */
const MAX_PHONETIC_KEYS_PER_TERM = 24;
/**
 * Shortest double-metaphone key the phonetic pass will match on. One- and
 * two-consonant keys (Zod/ST, Neon/NN, SSO/S, Vite/FT, KPI/KP) collide with
 * dozens of everyday words; on the benchmark corpus they were wrong 22 of 26 times.
 */
const PHONETIC_MIN_KEY = 3;
/** A window shorter than this (letters only) is not phonetic-matched unless the alias is just as short. */
const PHONETIC_MIN_WINDOW = 4;
/**
 * When the user listed explicit aliases for a term, the inexact passes are a
 * fallback and a lone token (single-token window) needs to clear a higher bar
 * than minConfidence: "prism" -> Prisma at 0.86 is wrong far more often than
 * "prizma" -> Prisma, and the latter is what the aliases are for.
 *
 * In the phonetic pass the bar applies regardless of case: phonetic confidence
 * is a length formula with no spelling evidence in it, and a capital at the
 * start of a sentence or on a proper noun is no evidence of a garble ("Inter",
 * the font, became Entire.io at 0.86). In the fuzzy pass only an all-lowercase
 * token is held to it: fuzzy confidence is an edit similarity, so a capitalised
 * token one edit from a listed alias ("Ashlet" / "Ashler", 0.83) is what the
 * alias was listed for. Multi-token windows keep the normal bar; STT rarely
 * splits an ordinary word into several.
 */
const ALIASED_PLAIN_WORD_MIN = 0.88;
/**
 * Double metaphone folds every initial vowel to "A", so "inter" and "entire"
 * share ANTR while agreeing on nothing else (similarity 0.5). A lone phonetic
 * candidate whose window or alias starts with a vowel (a e i o u y) must start
 * with the same letter (diacritics folded) or reach this edit similarity.
 * Two different initial consonants ("coopernetties" / "kubernetes") already
 * agreed on the key's first consonant and are exempt; "ashlur"/"ashlr" and
 * "hetsner"/"hetzner" start alike and never reach the check.
 */
const PHONETIC_LONE_TOKEN_MIN_SIM = 0.6;
const VOWEL_RE = /^[aeiouy]/;
/**
 * A lone token's metaphone key is all the phonetic evidence there is, and a
 * short key is shared by dozens of everyday words: LKS is "lacks", "locks",
 * "likes", "leaks" and "Locus"; TKR is "docker", "decor", "tucker", "taker".
 * So a single-token phonetic candidate must also look like the alias in
 * spelling, and the shorter the key the more it must: edit similarity >= 0.8
 * on a 3-consonant key ("lokus"/"locus" 0.8, "doker"/"docker" 0.83 pass;
 * "lacks"/"locus" 0.6, "tucker"/"docker" 0.67 fail) and >= 0.65 on a 4-consonant
 * key ("playwrite"/"playwright" 0.7 passes; "inter"/"entire" 0.5 fails). Five
 * or more consonants agreeing in order is spelling evidence in itself, so
 * longer keys keep only the initial-vowel guard above ("coopernetties" /
 * "kubernetes", KPRNTS, similarity 0.46, still matches). A flat key >= 4 rule
 * was measured instead and lost two headline positives ("doker" -> Docker,
 * "olama" -> Ollama, both alias-less); the tiers keep them. Multi-token windows
 * are exempt: STT rarely splits an ordinary word into several.
 */
const PHONETIC_LONE_KEY3_MIN_SIM = 0.8;
const PHONETIC_LONE_KEY4_MIN_SIM = 0.65;

/** Edit similarity a single-token phonetic candidate must reach for a key of the given length. */
function loneTokenMinSim(keyLength: number): number {
  if (keyLength <= 3) return PHONETIC_LONE_KEY3_MIN_SIM;
  if (keyLength === 4) return PHONETIC_LONE_KEY4_MIN_SIM;
  return 0;
}
/** Domain-style suffixes stripped to derive an implicit short alias ("Ashlr.AI" -> "Ashlr"). */
const DOMAIN_SUFFIX = /^(.{2,}?)\.(ai|io|com|dev|app|co|net|org|sh|xyz|me|so|gg)$/i;

/**
 * Built-in stoplist (src/core/stoplist.ts): common English words plus
 * everyday tech vocabulary that the phonetic/fuzzy passes must never rewrite.
 * Exact aliases the user listed explicitly still fire on these words (user
 * intent wins). Re-exported here so `STOPLIST` keeps its import path.
 */
export { STOPLIST };

/**
 * Function words: articles, prepositions, conjunctions, pronouns, auxiliaries,
 * wh-words. STT garbles a proper noun into sound-alike syllables; a bare
 * "to" / "is" / "a" next to it belongs to the sentence, so an inexact
 * multi-token window never starts or ends on one ("normalizeTranscript to",
 * "said to", "a grey"). Explicit aliases are unaffected. "her" is deliberately
 * absent: "-er" is the commonest word-final syllable and STT splits it off
 * ("dock her" -> Docker).
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set<string>(
  `
a an the
and or but nor so yet if then than because although while whether unless
at by for from in into of off on onto to with without about over under up down out through across between among
after before during until since around near above below behind beside upon toward towards via per
i me my mine you your yours he him his she hers it its we us our ours they them their theirs
this that these those who whom whose which what
am is are was were be been being do does did done have has had having
can could may might must shall should will would
not no yes there here now when where why how
`
    .split(/\s+/)
    .filter((w) => w.length > 0),
);

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Letters with no NFD decomposition that STT still writes as plain ASCII.
 * Everything else (ó, ü, ñ, ...) is handled by stripping combining marks.
 */
const ASCII_FOLD: Readonly<Record<string, string>> = {
  ø: 'o', Ø: 'O', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'Th',
  ß: 'ss', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ı: 'i',
};
const ASCII_FOLD_RE = /[øØłŁđĐðÐþÞßæÆœŒı]/g;
const NON_ASCII_RE = /[^\x00-\x7f]/;

/** Diacritics stripped (NFD, combining marks removed, plus ASCII_FOLD): "Bjørn" -> "Bjorn", "Wróblewski" -> "Wroblewski". */
function foldDiacritics(s: string): string {
  if (!NON_ASCII_RE.test(s)) return s;
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(ASCII_FOLD_RE, (c) => ASCII_FOLD[c] ?? c);
}

/** Diacritics folded and lowercased: the case-insensitive comparison form of the exact and fuzzy passes. */
function foldLower(s: string): string {
  return foldDiacritics(s).toLowerCase();
}

/** Letters only (diacritics folded), lowercase. */
function alphaOnly(s: string): string {
  return foldDiacritics(s).replace(/[^\p{L}]+/gu, '').toLowerCase();
}

/** Letters and digits only, diacritics folded, lowercase. Used for "punctuation stripped" comparisons. */
function collapse(s: string): string {
  return foldLower(s).replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Whitespace collapsed to single spaces, trimmed. */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Double-metaphone primary key of the alpha-only form of `s`. '' when nothing is left. */
export function phoneticKey(s: string): string {
  const alpha = alphaOnly(s);
  if (alpha.length === 0) return '';
  return doubleMetaphone(alpha)[0];
}

/** Longest string for which similarity() uses the transposition-aware distance. */
const OSA_MAX_LENGTH = 40;

/**
 * Optimal string alignment (restricted Damerau-Levenshtein) distance: edits are
 * insert, delete, substitute and swap of two adjacent characters. A typo such
 * as "levenshtien" is one edit away from "levenshtein" here, two under plain
 * Levenshtein. Three rolling rows, O(|a|*|b|).
 */
const OSA_ROWS = [new Int32Array(OSA_MAX_LENGTH + 1), new Int32Array(OSA_MAX_LENGTH + 1), new Int32Array(OSA_MAX_LENGTH + 1)];

function osaDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev2 = OSA_ROWS[0];
  let prev = OSA_ROWS[1];
  let cur = OSA_ROWS[2];
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const bj = b.charCodeAt(j - 1);
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ai === bj ? 0 : 1));
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) {
        d = Math.min(d, prev2[j - 2] + 1);
      }
      cur[j] = d;
    }
    const spare = prev2;
    prev2 = prev;
    prev = cur;
    cur = spare;
  }
  return prev[m];
}

/**
 * Normalized edit similarity in 0..1 (1 = identical). Transposition-aware
 * (optimal string alignment) up to OSA_MAX_LENGTH characters, plain
 * Levenshtein via fastest-levenshtein beyond that.
 */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  const d = max <= OSA_MAX_LENGTH ? osaDistance(a, b) : distance(a, b);
  return 1 - d / max;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

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

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** True when every token is one or two letters: an acronym spelled out letter by letter. */
function isSpelledOut(norm: string): boolean {
  return norm.split(' ').every((t) => alphaOnly(t).length <= 2);
}

/** Implicit aliases every canonical gets: itself and, for domain-like names, the stem. */
function implicitAliases(canonical: string): string[] {
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

      const tokenCount = norm.split(' ').length;
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
            push(phoneticKeys, key, { termIndex, term, alias, alpha, length: alpha.length });
            phoneticMinLen = Math.min(phoneticMinLen, alpha.length);
            phoneticMaxLen = Math.max(phoneticMaxLen, alpha.length);
            // STT tends to split one long word into several ("pie dentic"), so
            // allow windows wide enough to reassemble it.
            maxWindow = Math.max(maxWindow, Math.ceil(alpha.length / 4));
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

// ---------------------------------------------------------------------------
// Tokenizer + skip ranges
// ---------------------------------------------------------------------------

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Token with a trailing possessive ('s / ’s) removed. Same as text when none. */
  readonly base: string;
  readonly baseEnd: number;
  /** `text` / `base` with diacritics folded and lowercased. */
  readonly textLower: string;
  readonly baseLower: string;
  /** True when this token sits inside a code span / URL / email / path. */
  readonly skipped: boolean;
  /** True when the gap between this token and the next is whitespace only. */
  readonly joinsNext: boolean;
}

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu;
const TRAILING_PUNCT_RE = /[.'’\-]+$/u;
const POSSESSIVE_RE = /['’][sS]$/u;

interface Range {
  readonly start: number;
  readonly end: number;
}

const FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const URL_RE = /\b(?:https?|ftp):\/\/\S+/gi;
const WWW_RE = /\bwww\.\S+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/**
 * A file path or a `scope/name` slug: a token containing `/` with no spaces,
 * starting at a word boundary (`src/core/matcher.ts`, `~/ashlr`, `@ashlr/lexicon`,
 * `ashlrai/lexicon`, `github.com/ashlrai/lexicon`). No file extension is
 * required: a repo or package slug is a typed identifier just as a path is.
 * `and/or` also qualifies, harmlessly; a slash with spaces around it does not.
 */
const PATH_RE = /(?:^|(?<=\s|[("'\[]))(?:~|\.{1,2}|@)?[\w.~-]*(?:\/[\w.\-]+)+/g;

function collectRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (const re of [FENCE_RE, INLINE_CODE_RE, URL_RE, WWW_RE, EMAIL_RE, PATH_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      ranges.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

function tokenize(text: string, skipCode: boolean): Token[] {
  const ranges = skipCode ? collectRanges(text) : [];
  const tokens: Token[] = [];
  const draft: Array<Omit<Token, 'joinsNext'>> = [];
  let rangeIdx = 0;

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    let raw = m[0];
    const start = m.index;
    const trimmed = raw.replace(TRAILING_PUNCT_RE, '');
    if (trimmed.length === 0) continue;
    raw = trimmed;
    const end = start + raw.length;

    // Advance past ranges that end before this token, then test intersection.
    while (rangeIdx < ranges.length && ranges[rangeIdx].end <= start) rangeIdx++;
    let skipped = false;
    for (let i = rangeIdx; i < ranges.length && ranges[i].start < end; i++) {
      if (ranges[i].end > start) {
        skipped = true;
        break;
      }
    }

    let base = raw;
    if (POSSESSIVE_RE.test(raw) && raw.length > 2) {
      base = raw.slice(0, -2);
    }
    draft.push({
      text: raw,
      start,
      end,
      base,
      baseEnd: start + base.length,
      textLower: foldLower(raw),
      baseLower: foldLower(base),
      skipped,
    });
  }

  for (let i = 0; i < draft.length; i++) {
    const t = draft[i];
    const next = draft[i + 1];
    const joinsNext = next !== undefined && /^\s+$/.test(text.slice(t.end, next.start));
    tokens.push({ ...t, joinsNext });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

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
