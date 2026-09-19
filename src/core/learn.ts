/**
 * Learning from corrections. The loop this closes: the user dictates "ping
 * ashler", the agent writes "Ashler", the user says "it's Ashlr.AI, not
 * Ashler". parseCorrection() turns that sentence into { heard, meant } and
 * learnCorrection() stores `heard` as an alias of `meant` so the next
 * transcript is fixed before anyone sees it. suggestCanonicalFor() is the
 * other direction: an unknown garble comes in and we rank the terms it most
 * likely was, so the agent can ask "did you mean Ashlr.AI?".
 */
import { STOPLIST, phoneticKey, similarity } from './matcher.js';
import { addTerm, loadLexicon } from './store.js';
import type { StoreOptions } from './store.js';
import { suggestAliases } from './suggest.js';
import type { Lexicon, LexiconFile, Term, TermScope } from './types.js';

export interface Correction {
  /**
   * What the transcript / agent wrote (the wrong form). Empty when the sentence
   * only names the intended spelling ("spelled Zoë"); the caller then fills it
   * from context (the agent knows what it wrote) - learnCorrection refuses an
   * empty `heard`.
   */
  heard: string;
  /** What the user actually said / wants written. */
  meant: string;
}

export interface LearnResult {
  term: Term;
  /** True when a new term was written (false when `heard` merged into an existing one). */
  created: boolean;
  file: LexiconFile;
  /** False when `heard` was already an alias (or the canonical) of the term. */
  aliasAdded: boolean;
}

export interface CanonicalSuggestion {
  term: Term;
  /** 0..1; exact alias/canonical = 1, phonetic key match >= 0.9, else edit-distance similarity. */
  confidence: number;
}

/** Longest string accepted on either side of a correction. */
export const MAX_CORRECTION_LENGTH = 60;
/** Most words a bare (unquoted) side may span. Proper nouns are short; this keeps "it's X not Y" from eating a clause. */
const MAX_BARE_WORDS = 4;
/** Lowest confidence suggestCanonicalFor reports. */
const MIN_SUGGEST_CONFIDENCE = 0.6;
/** Confidence assigned when the double-metaphone keys agree. */
const PHONETIC_MATCH_CONFIDENCE = 0.9;
const MAX_SUGGESTIONS = 3;

// ---------------------------------------------------------------------------
// parseCorrection
// ---------------------------------------------------------------------------

/**
 * One side of a correction. Four capture groups, exactly one of which is set
 * when the side matches: "double quoted", “curly quoted”, `backticked`, bare.
 * Bare = 1..MAX_BARE_WORDS words with no quotes, commas or clause punctuation,
 * and never the word "not" (so "it's X not Y not Z" cannot swallow "not").
 */
const BARE_WORD = `(?!not\\b)[^\\s"“”\`,;:!?]+`;
const BARE = `${BARE_WORD}(?: ${BARE_WORD}){0,${MAX_BARE_WORDS - 1}}`;
const SIDE = `(?:"([^"]{1,80})"|“([^”]{1,80})”|\`([^\`]{1,80})\`|(${BARE}))`;
/** Same shape (still four groups, so indexes line up) but the bare alternative can never match. */
const QUOTED_SIDE = `(?:"([^"]{1,80})"|“([^”]{1,80})”|\`([^\`]{1,80})\`|((?!)))`;
const GROUPS_PER_SIDE = 4;
/** Trailing sentence punctuation tolerated after the last side. */
const TAIL = `\\s*[.!?]*\\s*$`;
/** A correction may be introduced mid-message ("no, it's X not Y") but must end the message. */
const LEAD = `(?:^|[\\s,;:—-])`;

type Side = 'meant' | 'heard';

interface CorrectionPattern {
  /** Template with {X} (meant) and {Y} (heard) placeholders. */
  template: string;
  /** Which side each {..} placeholder is, in the order they appear in the template. */
  order: readonly Side[];
  /** Only quoted sides are accepted (for templates too weak to trust bare words). */
  quotedOnly?: boolean;
  /**
   * When both sides are bare, at least one must contain a name-like token (see
   * looksLikeName): "replace the icon with the new logo" is an edit request, not
   * a spelling. Quoting either side is explicit and bypasses the check.
   */
  bareNeedsName?: boolean;
  /** Shown to users when nothing matched. */
  example: string;
}

/** Order matters: first match wins. Every regex is case-insensitive. */
const PATTERNS: readonly CorrectionPattern[] = [
  // "it's X not Y" / "it's X, not Y" / "it's spelled X, not Y"
  { template: `${LEAD}it'?s (?:spelled |spelt |written |called )?{X},? not {Y}${TAIL}`, order: ['meant', 'heard'], example: "it's Ashlr.AI, not Ashler" },
  // "I said X not Y"
  { template: `${LEAD}i said {X},? not {Y}${TAIL}`, order: ['meant', 'heard'], example: 'I said Ashlr.AI not Ashler' },
  // "I meant X not Y"
  { template: `${LEAD}i meant {X},? not {Y}${TAIL}`, order: ['meant', 'heard'], example: 'I meant Ashlr.AI not Ashler' },
  // "X not Y" with no verb - only when both sides are quoted, otherwise far too loose
  { template: `^\\s*{X},? not {Y}${TAIL}`, order: ['meant', 'heard'], quotedOnly: true, example: '"Ashlr.AI" not "Ashler"' },
  // "not Y, X" / "not Y, it's X"
  { template: `^\\s*not {Y},\\s*(?:it'?s |i meant |i said |but )?{X}${TAIL}`, order: ['heard', 'meant'], example: "not Ashler, Ashlr.AI" },
  // "replace Y with X"
  { template: `${LEAD}replace {Y} with {X}${TAIL}`, order: ['heard', 'meant'], bareNeedsName: true, example: 'replace Ashler with Ashlr.AI' },
  // "Y -> X" / "Y => X" / "Y → X"
  { template: `^\\s*{Y}\\s*(?:->|=>|→)\\s*{X}${TAIL}`, order: ['heard', 'meant'], example: 'Ashler -> Ashlr.AI' },
  // "that should be X" (heard unknown; caller fills it from context). Must precede "Y should be X".
  { template: `${LEAD}(?:that|this|it) should (?:be|read|say) {X}${TAIL}`, order: ['meant'], example: 'that should be Ashlr.AI' },
  // "Y should be X"
  { template: `^\\s*{Y} should (?:be|read|say) {X}${TAIL}`, order: ['heard', 'meant'], bareNeedsName: true, example: 'Ashler should be Ashlr.AI' },
  // "spelled X" / "it's spelled X" / "spell it X" (heard unknown; caller fills it from context)
  { template: `\\b(?:spell(?:ed|t)?(?: it| as)?|spelling(?: is|:)?) {X}${TAIL}`, order: ['meant'], example: 'spelled Ashlr.AI' },
];

/** One human-readable example per supported phrasing, for error messages and docs. */
export const CORRECTION_EXAMPLES: readonly string[] = PATTERNS.map((p) => p.example);

interface CompiledPattern {
  re: RegExp;
  order: readonly Side[];
  bareNeedsName: boolean;
}

const COMPILED: readonly CompiledPattern[] = PATTERNS.map((p) => {
  const side = p.quotedOnly ? QUOTED_SIDE : SIDE;
  const source = p.template.replace(/\{[XY]\}/g, side);
  return { re: new RegExp(source, 'iu'), order: p.order, bareNeedsName: p.bareNeedsName === true };
});

interface SideMatch {
  value: string;
  /** True when the bare (unquoted) alternative matched. */
  bare: boolean;
}

/** Pick the one populated capture group out of a side's four; the last one is the bare form. */
function sideValue(groups: readonly (string | undefined)[], index: number): SideMatch | undefined {
  const start = index * GROUPS_PER_SIDE;
  for (let i = start; i < start + GROUPS_PER_SIDE; i++) {
    const v = groups[i];
    if (v !== undefined) return { value: v, bare: i === start + GROUPS_PER_SIDE - 1 };
  }
  return undefined;
}

/**
 * Does a bare side look like a name rather than a phrase? True when it holds a
 * token outside the stoplist that is capitalised, contains a digit, dot or
 * hyphen (Ashlr.AI, k8s, re-frame), or is the side's only token. "the icon"
 * and "the new logo" fail; "Ashler", "icon" and "Ashlr.AI" pass.
 */
function looksLikeName(phrase: string): boolean {
  const tokens = phrase.split(' ').filter((t) => t.length > 0);
  const single = tokens.length === 1;
  return tokens.some((token) => {
    if (STOPLIST.has(token.toLowerCase())) return false;
    if (single) return true;
    return /^\p{Lu}/u.test(token) || /[\p{N}.-]/u.test(token);
  });
}

function cleanSide(raw: string): string {
  return raw
    .trim()
    .replace(/^[.,;:!?]+/, '')
    .replace(/[.,;:!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function allStoplisted(phrase: string): boolean {
  const words = phrase.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  return words.length > 0 && words.every((w) => STOPLIST.has(w));
}

/**
 * Detect a natural-language spelling correction. Returns undefined unless one
 * of the supported phrasings matches cleanly; see CORRECTION_EXAMPLES.
 */
export function parseCorrection(text: string): Correction | undefined {
  const input = text.replace(/\s+/g, ' ').trim();
  if (!input) return undefined;

  for (const { re, order, bareNeedsName } of COMPILED) {
    const m = re.exec(input);
    if (!m) continue;
    const groups = m.slice(1);
    let meant = '';
    let heard = '';
    let bad = false;
    let allBare = true;
    order.forEach((side, i) => {
      const match = sideValue(groups, i);
      if (match === undefined) {
        bad = true;
        return;
      }
      if (!match.bare) allBare = false;
      const cleaned = cleanSide(match.value);
      if (side === 'meant') meant = cleaned;
      else heard = cleaned;
    });
    if (bad) continue;
    // "replace the icon with the new logo" matches the shape of a correction but
    // names nothing; without quotes, demand that one side looks like a name.
    if (bareNeedsName && allBare && !looksLikeName(heard) && !looksLikeName(meant)) return undefined;

    // Conservative rejections: empty / oversized / identical sides, or two sides
    // made only of everyday words ("it's done not broken" is not a spelling).
    if (!meant || meant.length > MAX_CORRECTION_LENGTH) return undefined;
    if (heard.length > MAX_CORRECTION_LENGTH) return undefined;
    if (heard && heard.toLowerCase() === meant.toLowerCase()) return undefined;
    if (heard && allStoplisted(heard) && allStoplisted(meant)) return undefined;
    if (/^not\b/i.test(meant) || /^not\b/i.test(heard)) return undefined;
    return { heard, meant };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// learnCorrection
// ---------------------------------------------------------------------------

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The term `meant` refers to: canonical match first, then a term that lists `meant` as an alias. */
function termFor(lexicon: Lexicon, meant: string): Term | undefined {
  return (
    lexicon.terms.find((t) => sameText(t.canonical, meant)) ??
    lexicon.terms.find((t) => t.aliases.some((a) => sameText(a, meant)))
  );
}

function dedupeCaseInsensitive(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Record that the user said `meant` but the transcript wrote `heard`.
 * If a term already exists for `meant` (as canonical or alias), `heard` becomes
 * one more alias of it; otherwise a new term is created with `heard` plus the
 * auto-suggested STT misspellings. User intent wins: no stoplist check here.
 */
export async function learnCorrection(
  c: Correction,
  opts: StoreOptions & { scope?: TermScope } = {},
): Promise<LearnResult> {
  const heard = c.heard.trim().replace(/\s+/g, ' ');
  const meant = c.meant.trim().replace(/\s+/g, ' ');
  if (!meant) throw new Error('learnCorrection: the intended spelling (meant) must not be empty');
  if (!heard) {
    throw new Error(
      `learnCorrection: nothing to learn - say what was heard for "${meant}" (e.g. learn Ashler ${meant})`,
    );
  }
  if (heard.length > MAX_CORRECTION_LENGTH || meant.length > MAX_CORRECTION_LENGTH) {
    throw new Error(`learnCorrection: each side must be at most ${MAX_CORRECTION_LENGTH} characters`);
  }
  if (sameText(heard, meant)) {
    throw new Error(`learnCorrection: "${heard}" and "${meant}" are the same spelling; nothing to learn`);
  }

  const { scope, ...storeOpts } = opts;
  const loaded = await loadLexicon(storeOpts);
  const existing = termFor(loaded.merged, meant);

  if (existing) {
    const alreadyKnown =
      sameText(existing.canonical, heard) || existing.aliases.some((a) => sameText(a, heard));
    const targetScope: TermScope = scope ?? existing.scope ?? 'global';
    const saved = await addTerm(
      { canonical: existing.canonical, aliases: alreadyKnown ? [] : [heard], source: 'learned' },
      { ...storeOpts, scope: targetScope },
    );
    return { term: saved.term, created: saved.created, file: saved.file, aliasAdded: !alreadyKnown };
  }

  const aliases = dedupeCaseInsensitive([heard, ...suggestAliases(meant)]).filter((a) => !sameText(a, meant));
  const saved = await addTerm(
    { canonical: meant, aliases, source: 'learned' },
    { ...storeOpts, scope: scope ?? 'global' },
  );
  return { term: saved.term, created: saved.created, file: saved.file, aliasAdded: true };
}

// ---------------------------------------------------------------------------
// suggestCanonicalFor
// ---------------------------------------------------------------------------

/**
 * Rank existing terms by how likely `heard` is a garbling of them, so the agent
 * can ask "did you mean X?". Score per term = max over canonical + aliases of
 * max(similarity, phonetic-key match ? 0.9 : 0). Top 3 with confidence >= 0.6.
 */
export function suggestCanonicalFor(heard: string, lexicon: Lexicon): CanonicalSuggestion[] {
  const needle = heard.trim().toLowerCase();
  if (!needle) return [];
  const key = phoneticKey(needle);

  const scored: CanonicalSuggestion[] = [];
  for (const term of lexicon.terms) {
    let best = 0;
    for (const candidate of [term.canonical, ...term.aliases]) {
      const lower = candidate.toLowerCase();
      let score = similarity(needle, lower);
      if (key && phoneticKey(lower) === key) score = Math.max(score, PHONETIC_MATCH_CONFIDENCE);
      if (score > best) best = score;
    }
    if (best >= MIN_SUGGEST_CONFIDENCE) scored.push({ term, confidence: best });
  }

  scored.sort((a, b) => b.confidence - a.confidence || a.term.canonical.localeCompare(b.term.canonical));
  return scored.slice(0, MAX_SUGGESTIONS);
}
