/**
 * suggestTerms(): what the lexicon should learn next, mined from the voice
 * history (`voice/history.jsonl`, one `{ raw, output }` pair per dictation)
 * and from the lexicon itself. Four kinds of suggestion come out:
 *
 *   alias  a garble that keeps showing up next to a term it sounds like and
 *          is never corrected ("ashlur" -> Ashlr.AI), a guess the matcher
 *          keeps making by phonetic/fuzzy match (promote it to an exact
 *          alias), or a rewrite the older rules made that the current ones
 *          no longer reproduce;
 *   term   a capitalized / CamelCase name that recurs in corrected output
 *          and is not in the lexicon, plus the top repo harvest candidates
 *          when a `cwd` is given;
 *   never  an ordinary word (stoplist) that was rewritten to a term by a
 *          phonetic/fuzzy guess: protect it with `never`;
 *   stale  a term older than STALE_AFTER_DAYS with no hits whose spellings
 *          never occur in the history.
 *
 * Pure apart from reading the history file (loadVoiceHistory) and the
 * optional repo harvest. Budget: under 100 ms for 1000 history lines and
 * 200 terms (tests/suggest-terms.test.ts measures it). The matcher costs
 * 50 to 80 ms on its own over 1000 lines, so it only runs on lines that hold
 * a window resembling some alias or that differ from their output, and
 * every per-window computation is cached by window text.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { doubleMetaphone } from 'double-metaphone';
import { distance } from 'fastest-levenshtein';
import { HARVEST_STOPLIST, harvestRepo } from './harvest.js';
import { STOPLIST, buildIndex, findReplacements, similarity } from './matcher.js';
import type { AliasEntry, MatcherIndex } from './matcher.js';
import { sanitizeForDisplay } from './schema.js';
import { resolvePaths } from './store.js';
import { suggestAliases } from './suggest.js';
import type { LoadedLexicon, Replacement, Term, TermCategory } from './types.js';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export type SuggestionKind = 'alias' | 'term' | 'never' | 'stale';

export interface TermSuggestion {
  kind: SuggestionKind;
  /** Existing term (alias / never / stale) or the proposed new canonical (term). */
  canonical: string;
  /** For 'alias': the garble to add. For 'never': the word to protect. */
  alias?: string;
  /** One human sentence. */
  reason: string;
  /** 0..1 */
  confidence: number;
  /** Up to 5 short snippets, sanitized for a terminal, at most 120 characters each. */
  evidence: string[];
  /** Occurrences supporting it (0 for 'stale'). */
  count: number;
  /** For 'term': aliases to add along with the new term (suggestAliases or the harvest guesses). */
  aliases?: string[];
  /** For 'term' from a harvest: the category the harvester assigned. */
  category?: TermCategory;
}

/** One line of `voice/history.jsonl`. `model` and `ms` are informational and optional here. */
export interface VoiceHistoryEntry {
  at: string;
  raw: string;
  output: string;
  model?: string;
  ms?: { record: number; transcribe: number; normalize: number };
}

export interface SuggestInput {
  loaded: LoadedLexicon;
  /** Default: `<dirname(loaded.global.path)>/voice/history.jsonl` when present. */
  history?: VoiceHistoryEntry[];
  /** Harvest this repository for 'term' candidates (top 10, minCount 5). */
  cwd?: string;
  /** Default 20. */
  limit?: number;
  /** Epoch milliseconds used for the 'stale' age check. Default Date.now(). */
  now?: number;
}

export const SUGGEST_DEFAULT_LIMIT = 20;
export const STALE_AFTER_DAYS = 30;
/** `--yes` and MCP auto-apply use this: suggestions at or above it are safe to apply unattended. */
export const AUTO_APPLY_CONFIDENCE = 0.8;

const MAX_EVIDENCE = 5;
const EVIDENCE_MAX_CHARS = 120;
/** Lines kept from the history file (newest). Mirrors voice/history.ts HISTORY_MAX_LINES. */
const MAX_HISTORY_LINES = 1000;
/** Longest token window compared against aliases. */
const MAX_WINDOW = 3;
/** A window this similar to an alias (edit similarity, or phonetic key plus a looser similarity) is "near" it. */
const NEAR_MIN_SCORE = 0.7;
/** Score given to a phonetic-key match that clears the per-key similarity floor. */
const KEY_MATCH_SCORE = 0.85;
/** Times an uncorrected near-miss must recur before it is proposed as an alias. */
const ALIAS_MIN_COUNT = 2;
/** Times the matcher must have guessed the same correction before promotion is proposed. */
const PROMOTE_MIN_COUNT = 3;
/** Times a capitalized name must recur in outputs before it is proposed as a term. */
const TERM_MIN_COUNT = 3;
const HARVEST_LIMIT = 10;
const HARVEST_MIN_COUNT = 5;
const HARVEST_MAX_CONFIDENCE = 0.7;
/** Token diff is O(n*m); lines longer than this are not diffed for historical rewrites. */
const MAX_DIFF_TOKENS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Function words (same list as the matcher, which does not export it): an
 * inexact multi-token window never starts or ends on one.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  `a an the and or but nor so yet if then than because although while whether unless
at by for from in into of off on onto to with without about over under up down out through across between among
after before during until since around near above below behind beside upon toward towards via per
i me my mine you your yours he him his she hers it its we us our ours they them their theirs
this that these those who whom whose which what
am is are was were be been being do does did done have has had having
can could may might must shall should will would
not no yes there here now when where why how`
    .split(/\s+/)
    .filter((w) => w.length > 0),
);

// ---------------------------------------------------------------------------
// History file
// ---------------------------------------------------------------------------

/** `<dirname(globalPath)>/voice/history.jsonl`. */
export function voiceHistoryPath(globalPath: string): string {
  return path.join(path.dirname(globalPath), 'voice', 'history.jsonl');
}

/**
 * Read the voice history next to the global lexicon (`$LEXICON_PATH` and the
 * XDG default apply when `globalPath` is omitted). Missing file, unreadable
 * file and malformed lines all yield nothing; at most the newest
 * 1000 entries are returned.
 */
export async function loadVoiceHistory(globalPath?: string): Promise<VoiceHistoryEntry[]> {
  const resolved = globalPath ?? resolvePaths().global;
  let text: string;
  try {
    text = await fs.readFile(voiceHistoryPath(resolved), 'utf8');
  } catch {
    return [];
  }
  const out: VoiceHistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = toHistoryEntry(parsed);
    if (entry) out.push(entry);
  }
  return out.length > MAX_HISTORY_LINES ? out.slice(out.length - MAX_HISTORY_LINES) : out;
}

function toHistoryEntry(value: unknown): VoiceHistoryEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.raw !== 'string' || typeof v.output !== 'string') return undefined;
  const entry: VoiceHistoryEntry = { at: typeof v.at === 'string' ? v.at : '', raw: v.raw, output: v.output };
  if (typeof v.model === 'string') entry.model = v.model;
  const ms = v.ms;
  if (typeof ms === 'object' && ms !== null) {
    const m = ms as Record<string, unknown>;
    if (typeof m.record === 'number' && typeof m.transcribe === 'number' && typeof m.normalize === 'number') {
      entry.ms = { record: m.record, transcribe: m.transcribe, normalize: m.normalize };
    }
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Diacritics stripped and lowercased: the comparison form the matcher index uses. */
function fold(s: string): string {
  const base = /[^\x00-\x7f]/.test(s) ? s.normalize('NFD').replace(/\p{M}+/gu, '') : s;
  return base.toLowerCase();
}

function alphaOnly(s: string): string {
  return fold(s).replace(/[^\p{L}]+/gu, '');
}

function collapse(s: string): string {
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, '');
}

function isOrdinaryWord(lower: string): boolean {
  return /^\p{Ll}+$/u.test(lower) && (STOPLIST.has(lower) || FUNCTION_WORDS.has(lower));
}

/** Title case, PascalCase or inner-capital (iPhone, macOS) with at least one lowercase letter; never all caps. */
function looksCapitalized(s: string): boolean {
  const letters = s.replace(/[^\p{L}]+/gu, '');
  if (letters.length < 2) return false;
  if (!/\p{Ll}/u.test(letters)) return false;
  if (/^\p{Lu}/u.test(letters)) return true;
  return /\p{Lu}/u.test(letters);
}

/** One line, at most EVIDENCE_MAX_CHARS characters around [start, end), terminal-safe. */
function snippet(text: string, start = 0, end = text.length): string {
  const flat = text.replace(/\s+/g, ' ');
  let piece: string;
  if (flat.length <= EVIDENCE_MAX_CHARS) {
    piece = flat.trim();
  } else {
    const room = EVIDENCE_MAX_CHARS - 2;
    const span = Math.min(end - start, room);
    let from = Math.max(0, start - Math.floor((room - span) / 2));
    let to = Math.min(flat.length, from + room);
    if (to - from < room) from = Math.max(0, to - room);
    piece = `${from > 0 ? '…' : ''}${flat.slice(from, to).trim()}${to < flat.length ? '…' : ''}`;
  }
  const chars = Array.from(sanitizeForDisplay(piece));
  return chars.length <= EVIDENCE_MAX_CHARS ? chars.join('') : `${chars.slice(0, EVIDENCE_MAX_CHARS - 1).join('')}…`;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Tokenizer (a light version of the matcher's: skip ranges blanked, offsets kept)
// ---------------------------------------------------------------------------

interface Tok {
  /** As written, trailing punctuation trimmed. */
  readonly text: string;
  /** `text` without a trailing possessive. */
  readonly base: string;
  readonly lower: string;
  readonly start: number;
  readonly end: number;
  readonly stop: boolean;
  readonly fn: boolean;
  /** First token of the text or of a sentence. */
  readonly sentenceStart: boolean;
  /** Only whitespace between this token and the next. */
  readonly joinsNext: boolean;
}

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}'’.\-]*/gu;
const TRAILING_PUNCT_RE = /[.'’\-]+$/u;
const POSSESSIVE_RE = /['’][sS]$/u;
const SKIP_RES: readonly RegExp[] = [
  /```[\s\S]*?(?:```|$)/g,
  /`[^`\n]*`/g,
  /\b(?:https?|ftp):\/\/\S+/gi,
  /\bwww\.\S+/gi,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  /(?:^|(?<=\s|[("'\[]))(?:~|\.{1,2}|@)?[\w.~-]*(?:\/[\w.\-]+)+/g,
];

/** Code spans, URLs, emails and paths replaced by spaces so offsets survive. */
function blankSkipped(text: string): string {
  let out = text;
  for (const re of SKIP_RES) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => ' '.repeat(m.length));
  }
  return out;
}

function tokenize(text: string): Tok[] {
  const blanked = /[`/@:]/.test(text) ? blankSkipped(text) : text;
  const draft: Array<Omit<Tok, 'joinsNext'>> = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(blanked)) !== null) {
    const raw = m[0].replace(TRAILING_PUNCT_RE, '');
    if (raw.length === 0) continue;
    const start = m.index;
    const end = start + raw.length;
    const base = POSSESSIVE_RE.test(raw) && raw.length > 2 ? raw.slice(0, -2) : raw;
    const lower = fold(base);
    const prev = draft[draft.length - 1];
    const gap = prev ? blanked.slice(prev.end, start) : '';
    draft.push({
      text: raw,
      base,
      lower,
      start,
      end,
      stop: STOPLIST.has(lower),
      fn: FUNCTION_WORDS.has(lower),
      sentenceStart: !prev || /[.!?\n]/.test(gap),
    });
  }
  return draft.map((t, i) => {
    const next = draft[i + 1];
    return { ...t, joinsNext: next !== undefined && /^\s+$/.test(blanked.slice(t.end, next.start)) };
  });
}

// ---------------------------------------------------------------------------
// Alias catalogue: every alias (explicit and implicit) with the keys that find it cheaply
// ---------------------------------------------------------------------------

interface CatalogueEntry {
  readonly entry: AliasEntry;
  readonly alpha: string;
  readonly key: string;
}

interface Near {
  readonly canonical: string;
  readonly termIndex: number;
  /** Edit similarity, lifted to KEY_MATCH_SCORE on a phonetic-key match. */
  readonly score: number;
  /** Plain edit similarity, to break ties between windows that key alike. */
  readonly sim: number;
}

interface Catalogue {
  readonly index: MatcherIndex;
  /** Phonetic key -> entries. */
  readonly byKey: ReadonlyMap<string, readonly CatalogueEntry[]>;
  /** First two letters -> entries. */
  readonly byPrefix: ReadonlyMap<string, readonly CatalogueEntry[]>;
  /** Folded canonicals, aliases, collapsed forms and every word of a canonical. */
  readonly known: ReadonlySet<string>;
  /** Folded canonical / collapsed canonical / stem -> term. */
  readonly canonicalByForm: ReadonlyMap<string, Term>;
  readonly maxCollapsedLength: number;
  /** Cache: folded window -> nearest alias (or null). */
  readonly nearCache: Map<string, Near | null>;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildCatalogue(index: MatcherIndex): Catalogue {
  const byKey = new Map<string, CatalogueEntry[]>();
  const byPrefix = new Map<string, CatalogueEntry[]>();
  const known = new Set<string>();
  const canonicalByForm = new Map<string, Term>();
  let maxCollapsedLength = 0;

  for (const entries of index.exact.values()) {
    for (const entry of entries) {
      const alpha = alphaOnly(entry.normLower);
      const key = alpha.length >= 3 ? doubleMetaphone(alpha)[0] : '';
      const item: CatalogueEntry = { entry, alpha, key };
      if (key.length >= 3) pushTo(byKey, key, item);
      if (alpha.length >= 2) pushTo(byPrefix, alpha.slice(0, 2), item);
      known.add(entry.normLower);
      known.add(entry.collapsed);
      maxCollapsedLength = Math.max(maxCollapsedLength, entry.collapsed.length);
      if (!entry.explicit) {
        // Implicit entries are the canonical and its domain stem.
        canonicalByForm.set(entry.normLower, entry.term);
        canonicalByForm.set(entry.collapsed, entry.term);
      }
    }
  }
  for (const term of index.lexicon.terms) {
    for (const word of fold(term.canonical).split(/[^\p{L}\p{N}]+/u)) if (word) known.add(word);
  }
  return { index, byKey, byPrefix, known, canonicalByForm, maxCollapsedLength, nearCache: new Map() };
}

/** Similarity floor a phonetic-key match must also clear, looser than the matcher's since a human reviews the result. */
function keyMatchMinSim(keyLength: number): number {
  if (keyLength <= 3) return 0.6;
  if (keyLength === 4) return 0.5;
  return 0;
}

/**
 * The alias `windowLower` most resembles, if any: candidates come from the
 * phonetic-key and two-letter-prefix maps (an STT garble nearly always keeps
 * one of the two), scored by edit similarity, with a key match worth at
 * least KEY_MATCH_SCORE once it clears keyMatchMinSim. Exact forms and
 * `never` words of the term return null.
 */
function nearest(cat: Catalogue, windowLower: string): Near | null {
  const cached = cat.nearCache.get(windowLower);
  if (cached !== undefined) return cached;
  let result: Near | null = null;
  const collapsed = windowLower.replace(/[^\p{L}\p{N}]+/gu, '');
  if (!cat.known.has(windowLower) && !cat.known.has(collapsed)) {
    const alpha = windowLower.replace(/[^\p{L}]+/gu, '');
    const key = alpha.length >= 3 ? doubleMetaphone(alpha)[0] : '';
    const seen = new Set<CatalogueEntry>();
    const candidates: CatalogueEntry[] = [];
    for (const list of [key.length >= 3 ? cat.byKey.get(key) : undefined, cat.byPrefix.get(alpha.slice(0, 2))]) {
      if (!list) continue;
      for (const c of list) {
        if (!seen.has(c)) {
          seen.add(c);
          candidates.push(c);
        }
      }
    }
    let best = 0;
    for (const c of candidates) {
      const e = c.entry;
      const never = cat.index.never[e.termIndex];
      if (never.has(windowLower) || never.has(collapsed)) continue;
      const keyMatch = key.length >= 3 && c.key === key;
      const max = Math.max(collapsed.length, e.collapsed.length);
      // similarity <= 1 - |lenDiff| / max: prune, unless a long phonetic key vouches for it.
      if (!(keyMatch && key.length >= 5) && Math.abs(collapsed.length - e.collapsed.length) > (1 - NEAR_MIN_SCORE) * max) continue;
      let sim = 0;
      // Cheap bit-parallel bound before the transposition-aware distance.
      if (1 - Math.ceil(distance(collapsed, e.collapsed) / 2) / max >= 0.5) {
        sim = Math.max(similarity(windowLower, e.normLower), similarity(collapsed, e.collapsed));
      }
      let score = sim;
      if (keyMatch && sim >= keyMatchMinSim(key.length)) score = Math.max(sim, KEY_MATCH_SCORE);
      if (score > best || (score === best && result !== null && sim > result.sim)) {
        best = score;
        result = { canonical: e.term.canonical, termIndex: e.termIndex, score, sim };
      }
    }
    if (best < NEAR_MIN_SCORE) result = null;
  }
  cat.nearCache.set(windowLower, result);
  return result;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

interface Win {
  readonly from: number;
  readonly to: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly lower: string;
}

const DIGITS_RE = /^\p{N}+$/u;

/**
 * 1..MAX_WINDOW token windows worth comparing: some non-stoplist token, no
 * function word or bare number at either edge, short enough to be an alias.
 */
function windows(text: string, toks: readonly Tok[], maxCollapsed: number): Win[] {
  const out: Win[] = [];
  for (let i = 0; i < toks.length; i++) {
    let anyContent = false;
    let length = 0;
    for (let n = 1; n <= MAX_WINDOW; n++) {
      const j = i + n - 1;
      if (j >= toks.length) break;
      if (n > 1 && !toks[j - 1].joinsNext) break;
      const last = toks[j];
      length += last.lower.length;
      if (length > maxCollapsed + 4) break;
      if (!last.stop && !last.fn) anyContent = true;
      if (!anyContent) continue;
      if (n === 1 && alphaOnly(last.lower).length < 3) continue;
      if (n > 1 && (toks[i].fn || last.fn || DIGITS_RE.test(toks[i].lower) || DIGITS_RE.test(last.lower))) continue;
      const first = toks[i];
      const raw = text.slice(first.start, last.end);
      const base = text.slice(first.start, last.start) + last.base;
      out.push({ from: i, to: j, start: first.start, end: first.start + base.length, text: base, lower: fold(base).replace(/\s+/g, ' ') });
      if (raw !== base) {
        // The possessive form as well ("ashlur's"): the matcher tries both.
        out.push({ from: i, to: j, start: first.start, end: last.end, text: raw, lower: fold(raw).replace(/\s+/g, ' ') });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Token diff (raw vs output) for rewrites made when the line was recorded
// ---------------------------------------------------------------------------

interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** LCS-based diff of two token lists (case-folded). Returns the change hunks and the matched pairs a -> b. */
function diffTokens(a: readonly string[], b: readonly string[]): { hunks: Hunk[]; pairs: Map<number, number> } {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs = new Map<number, number>();
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  let a0 = 0;
  let b0 = 0;
  const flush = (): void => {
    if (a0 < i || b0 < j) hunks.push({ a0, a1: i, b0, b1: j });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      pairs.set(i, j);
      i++;
      j++;
      a0 = i;
      b0 = j;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  i = n;
  j = m;
  flush();
  return { hunks, pairs };
}

// ---------------------------------------------------------------------------
// Buckets (one per (canonical, word) pair) and the suggestion list
// ---------------------------------------------------------------------------

interface Bucket {
  canonical: string;
  word: string;
  count: number;
  evidence: string[];
  /** Sum of matcher confidences (promotions). */
  confidenceSum: number;
  /** The current matcher still reproduces this rewrite by guess (never / historical). */
  still: boolean;
}

function bump(map: Map<string, Bucket>, canonical: string, word: string, count: number, evidence: string, confidence = 0, still = false): void {
  const key = `${fold(canonical)}\0${fold(word)}`;
  let b = map.get(key);
  if (!b) {
    b = { canonical, word, count: 0, evidence: [], confidenceSum: 0, still: false };
    map.set(key, b);
  }
  b.count += count;
  b.confidenceSum += confidence * count;
  b.still = b.still || still;
  if (b.evidence.length < MAX_EVIDENCE && !b.evidence.includes(evidence)) b.evidence.push(evidence);
}

function dedupeKey(s: TermSuggestion): string {
  return `${s.kind}\0${fold(s.canonical)}\0${fold(s.alias ?? '')}`;
}

/**
 * Merge same-kind duplicates. Two signals may cite the same lines (a garble
 * left uncorrected when recorded that the matcher now guesses feeds both the
 * uncorrected and the promotion signal), so the count is the larger one, not
 * the sum; confidence and reason follow the stronger one, evidence unions.
 */
function mergeSuggestions(list: readonly TermSuggestion[]): TermSuggestion[] {
  const byKey = new Map<string, TermSuggestion>();
  for (const s of list) {
    const key = dedupeKey(s);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...s, evidence: [...s.evidence] });
      continue;
    }
    const stronger = s.confidence > prev.confidence ? s : prev;
    const merged: TermSuggestion = {
      ...prev,
      reason: stronger.reason,
      confidence: Math.max(prev.confidence, s.confidence),
      count: Math.max(prev.count, s.count),
      evidence: [...new Set([...prev.evidence, ...s.evidence])].slice(0, MAX_EVIDENCE),
    };
    if (stronger.aliases) merged.aliases = stronger.aliases;
    if (stronger.category) merged.category = stronger.category;
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}

function rank(s: TermSuggestion): number {
  return s.confidence * Math.log(1 + Math.max(s.count, 1));
}

// ---------------------------------------------------------------------------
// suggestTerms
// ---------------------------------------------------------------------------

interface Line {
  readonly raw: string;
  readonly output: string;
  count: number;
}

export async function suggestTerms(input: SuggestInput): Promise<TermSuggestion[]> {
  const { loaded } = input;
  const limit = Math.max(0, Math.floor(input.limit ?? SUGGEST_DEFAULT_LIMIT));
  const now = input.now ?? Date.now();
  const history = input.history ?? (await loadVoiceHistory(loaded.global.path));
  const lexicon = loaded.merged;
  const index = buildIndex(lexicon);
  const cat = buildCatalogue(index);

  // Identical dictations collapse into one line with a count.
  const lines = new Map<string, Line>();
  for (const entry of history) {
    if (typeof entry.raw !== 'string' || typeof entry.output !== 'string' || !entry.raw.trim()) continue;
    const key = `${entry.raw}\0${entry.output}`;
    const line = lines.get(key);
    if (line) line.count += 1;
    else lines.set(key, { raw: entry.raw, output: entry.output, count: 1 });
  }

  const aliasBuckets = new Map<string, Bucket>();
  const promoteBuckets = new Map<string, Bucket>();
  const historicalBuckets = new Map<string, Bucket>();
  const neverBuckets = new Map<string, Bucket>();
  const termBuckets = new Map<string, Bucket>();
  /** Every folded token seen in the history, for the stale check. */
  const seenTokens = new Set<string>();
  const replacementCache = new Map<string, Replacement[]>();
  const replacementsFor = (raw: string): Replacement[] => {
    let r = replacementCache.get(raw);
    if (!r) {
      r = findReplacements(raw, index);
      replacementCache.set(raw, r);
    }
    return r;
  };
  const covered = (reps: readonly Replacement[], start: number, end: number): Replacement | undefined =>
    reps.find((r) => r.start < end && start < r.end);

  for (const line of lines.values()) {
    const rawToks = tokenize(line.raw);
    for (const t of rawToks) seenTokens.add(t.lower);
    const outputLower = fold(line.output);
    const changed = line.raw !== line.output;

    // --- alias signals on the raw transcript ------------------------------
    const near: Array<{ win: Win; hit: Near }> = [];
    for (const win of windows(line.raw, rawToks, cat.maxCollapsedLength)) {
      if (win.from === win.to && isOrdinaryWord(win.lower)) continue;
      const hit = nearest(cat, win.lower);
      if (hit) near.push({ win, hit });
    }
    const reps = near.length > 0 || changed ? replacementsFor(line.raw) : [];

    // The best-scoring window wins a stretch of text; on a tie the one that
    // looks most like the alias, then the longer one ("ashlur ai" over "ashlur"
    // when both key alike but the pair reads closer to "Ashlr.AI").
    near.sort(
      (x, y) =>
        y.hit.score - x.hit.score ||
        y.hit.sim - x.hit.sim ||
        y.win.end - y.win.start - (x.win.end - x.win.start) ||
        x.win.start - y.win.start,
    );
    const taken: Array<{ start: number; end: number }> = [];
    for (const { win, hit } of near) {
      if (taken.some((t) => t.start < win.end && win.start < t.end)) continue;
      taken.push({ start: win.start, end: win.end });
      // Part of a longer exact alias ("ashler" inside "ashler ai"): nothing to learn.
      if (covered(reps, win.start, win.end)?.reason === 'alias') continue;
      // Rewritten when it was recorded: the diff below classifies it instead.
      if (!outputLower.includes(win.lower)) continue;
      bump(aliasBuckets, hit.canonical, win.text, line.count, snippet(line.raw, win.start, win.end), hit.score);
    }

    for (const r of reps) {
      if (r.reason === 'alias') continue;
      bump(promoteBuckets, r.canonical, r.original, line.count, snippet(line.raw, r.start, r.end), r.confidence);
    }

    // --- rewrites made when the line was recorded ---------------------------
    if (changed) {
      const outToks = tokenize(line.output);
      if (rawToks.length <= MAX_DIFF_TOKENS && outToks.length <= MAX_DIFF_TOKENS) {
        const { hunks, pairs } = diffTokens(
          rawToks.map((t) => t.lower),
          outToks.map((t) => t.lower),
        );
        for (const h of hunks) {
          if (h.a1 <= h.a0 || h.b1 <= h.b0) continue;
          // The rewrite may have kept part of a multi-word canonical ("mason wyeth" -> "Mason Wyatt"):
          // grow the hunk over matched neighbours until the output side reads as a canonical.
          let found: { term: Term; a0: number; a1: number } | undefined;
          for (let grow = 0; grow <= 2 && !found; grow++) {
            for (let l = 0; l <= grow && !found; l++) {
              const r = grow - l;
              const a0 = h.a0 - l;
              const a1 = h.a1 + r;
              const b0 = h.b0 - l;
              const b1 = h.b1 + r;
              if (a0 < 0 || b0 < 0 || a1 > rawToks.length || b1 > outToks.length) continue;
              let aligned = true;
              for (let x = 1; x <= l && aligned; x++) aligned = pairs.get(h.a0 - x) === h.b0 - x;
              for (let x = 0; x < r && aligned; x++) aligned = pairs.get(h.a1 + x) === h.b1 + x;
              if (!aligned) continue;
              const outText = line.output.slice(outToks[b0].start, outToks[b1 - 1].end);
              const term = cat.canonicalByForm.get(fold(outText)) ?? cat.canonicalByForm.get(collapse(outText));
              if (term) found = { term, a0, a1 };
            }
          }
          if (!found) continue;
          const start = rawToks[found.a0].start;
          const end = rawToks[found.a1 - 1].end;
          const original = line.raw.slice(start, end);
          const originalLower = fold(original).replace(/\s+/g, ' ');
          if (cat.known.has(originalLower) || cat.known.has(collapse(original))) continue; // exact alias or a case fix
          const current = reps.find((r) => r.start < end && start < r.end && fold(r.canonical) === fold(found.term.canonical));
          if (current?.reason === 'alias') continue;
          const still = current !== undefined;
          const ev = snippet(line.raw, start, end);
          if (found.a1 - found.a0 === 1 && isOrdinaryWord(originalLower)) {
            bump(neverBuckets, found.term.canonical, original, line.count, ev, 0, still);
          } else if (!still) {
            bump(historicalBuckets, found.term.canonical, original, line.count, ev);
          }
          // `still` and not ordinary: the promotion bucket above already counts it.
        }
      }
    }

    // --- new names in the corrected output ---------------------------------
    const outToks = changed ? tokenize(line.output) : rawToks;
    for (const t of outToks) seenTokens.add(t.lower);
    const qualifies = (t: Tok): boolean =>
      looksCapitalized(t.base) &&
      !t.stop &&
      !t.fn &&
      !HARVEST_STOPLIST.has(t.base) &&
      !cat.known.has(t.lower) &&
      !cat.known.has(t.lower.replace(/[^\p{L}\p{N}]+/gu, ''));
    for (let i = 0; i < outToks.length; ) {
      if (!qualifies(outToks[i])) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < outToks.length && outToks[j].joinsNext && qualifies(outToks[j + 1])) j++;
      const run = outToks.slice(i, j + 1);
      i = j + 1;
      // A lone capitalized word at a sentence start is just the sentence starting.
      if (run.length === 1 && run[0].sentenceStart) continue;
      const first = run[0];
      const last = run[run.length - 1];
      const phrase = line.output.slice(first.start, last.start) + last.base;
      const phraseLower = fold(phrase).replace(/\s+/g, ' ');
      if (alphaOnly(phraseLower).length < 4) continue;
      if (cat.known.has(phraseLower) || cat.known.has(collapse(phrase))) continue;
      if (nearest(cat, phraseLower)) continue; // sounds like an existing term: alias material, not a new term
      bump(termBuckets, phrase, '', line.count, snippet(line.output, first.start, last.end));
    }
  }

  const suggestions: TermSuggestion[] = [];

  for (const b of aliasBuckets.values()) {
    if (b.count < ALIAS_MIN_COUNT) continue;
    const score = b.confidenceSum / b.count;
    suggestions.push({
      kind: 'alias',
      canonical: b.canonical,
      alias: b.word,
      reason: `"${b.word}" was left uncorrected ${b.count} times and sounds like ${b.canonical}`,
      confidence: round(clamp01(0.3 + 0.45 * score + 0.05 * Math.min(b.count, 4))),
      evidence: b.evidence,
      count: b.count,
    });
  }
  for (const b of promoteBuckets.values()) {
    if (b.count < PROMOTE_MIN_COUNT) continue;
    const mean = b.confidenceSum / b.count;
    suggestions.push({
      kind: 'alias',
      canonical: b.canonical,
      alias: b.word,
      reason: `corrected by guess ${b.count} times; make it exact`,
      confidence: round(Math.min(0.95, Math.max(AUTO_APPLY_CONFIDENCE, mean))),
      evidence: b.evidence,
      count: b.count,
    });
  }
  for (const b of historicalBuckets.values()) {
    suggestions.push({
      kind: 'alias',
      canonical: b.canonical,
      alias: b.word,
      reason: `rewritten to ${b.canonical} ${b.count} time${b.count === 1 ? '' : 's'} before; the current rules no longer match it`,
      confidence: round(Math.min(0.75, 0.5 + 0.1 * Math.min(b.count, 3))),
      evidence: b.evidence,
      count: b.count,
    });
  }
  for (const b of neverBuckets.values()) {
    const term = lexicon.terms.find((t) => fold(t.canonical) === fold(b.canonical));
    if (term?.never?.some((w) => fold(w) === fold(b.word))) continue;
    suggestions.push({
      kind: 'never',
      canonical: b.canonical,
      alias: b.word,
      reason: b.still
        ? `ordinary word rewritten by guess ${b.count} time${b.count === 1 ? '' : 's'}; the current rules still do it`
        : `ordinary word rewritten by guess ${b.count} time${b.count === 1 ? '' : 's'} under earlier rules`,
      confidence: round(b.still ? 0.7 : Math.min(0.65, 0.5 + 0.05 * Math.min(b.count, 3))),
      evidence: b.evidence,
      count: b.count,
    });
  }
  for (const b of termBuckets.values()) {
    if (b.count < TERM_MIN_COUNT) continue;
    suggestions.push({
      kind: 'term',
      canonical: b.canonical,
      reason: `capitalized name seen ${b.count} times in transcripts and not in the lexicon`,
      confidence: round(Math.min(0.9, 0.35 + 0.1 * Math.min(b.count, 5))),
      evidence: b.evidence,
      count: b.count,
      aliases: suggestAliases(b.canonical),
    });
  }

  if (input.cwd) {
    const candidates = await harvestRepo(input.cwd, { limit: HARVEST_LIMIT, minCount: HARVEST_MIN_COUNT });
    const repoName = path.basename(path.resolve(input.cwd)) || input.cwd;
    for (const c of candidates) {
      if (cat.known.has(fold(c.canonical)) || cat.known.has(collapse(c.canonical))) continue;
      suggestions.push({
        kind: 'term',
        canonical: c.canonical,
        reason: `seen ${c.count} times in ${repoName} (harvest, ${c.source})`,
        // Repo identifiers are review material: capped under AUTO_APPLY_CONFIDENCE so --yes never adds them.
        confidence: round(Math.min(HARVEST_MAX_CONFIDENCE, 0.4 + 0.05 * Math.min(c.count, 6))),
        evidence: c.evidence.slice(0, MAX_EVIDENCE).map((e) => snippet(e)),
        count: c.count,
        aliases: c.suggestedAliases,
        category: c.category,
      });
    }
  }

  for (const term of lexicon.terms) {
    if ((term.hits ?? 0) > 0 || !term.createdAt) continue;
    const created = Date.parse(term.createdAt);
    if (!Number.isFinite(created)) continue;
    const days = Math.floor((now - created) / DAY_MS);
    if (days < STALE_AFTER_DAYS) continue;
    const forms = [term.canonical, ...term.aliases];
    const seen = forms.some((f) => {
      const words = fold(f).split(/[^\p{L}\p{N}.'’-]+/u).filter((w) => w.length > 0);
      return words.length > 0 && words.every((w) => seenTokens.has(w) || seenTokens.has(w.replace(/[^\p{L}\p{N}]+/gu, '')));
    });
    if (seen) continue;
    suggestions.push({
      kind: 'stale',
      canonical: term.canonical,
      reason: `never matched in ${days} days`,
      confidence: 0.3,
      evidence: [],
      count: 0,
    });
  }

  const merged = mergeSuggestions(suggestions);
  merged.sort((a, b) => rank(b) - rank(a) || b.confidence - a.confidence || a.canonical.localeCompare(b.canonical));
  return merged.slice(0, limit);
}
