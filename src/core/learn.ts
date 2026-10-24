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
import { InputError } from '../util/errors.js';
import type { StoreOptions } from './store.js';
import { suggestAliases } from './suggest.js';
import type { Lexicon, LexiconFile, LoadedLexicon, Term, TermScope } from './types.js';
import type { LearnConflict } from './conflict-note.js';

// The conflict wording lives in a module with no IO so the browser extension
// bundles the same sentences (extension/src/core.ts re-exports it).
export { conflictNote, conflictRemoveCommand, learnUnchangedNote, unchangedTermNote } from './conflict-note.js';
export type { ConflictNoteAudience, LearnConflict } from './conflict-note.js';

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
  /**
   * Another term that also claims `heard` (as an alias, or as its own
   * canonical), so a transcript can still be corrected to that term instead.
   * Absent when nothing else claims it.
   */
  conflict?: LearnConflict;
  /**
   * The project lexicon for this cwd that was skipped as untrusted (or
   * changed since trusted) and also claims `heard` for some other term. It is
   * never merged or read back to the caller: only its path and trust state
   * are given, so the user can review it with `lexicon trust`. Once trusted
   * that project term wins the merge over this correction.
   */
  untrustedProject?: { path: string; trust: 'untrusted' | 'changed' };
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
 * A period is part of a word only when something follows it without a space
 * (Ashlr.AI, Entire.io, README.md); a period followed by whitespace ends the
 * word, so ". remember that" cannot be swallowed into `heard`.
 */
const BARE_WORD = `(?!not\\b)(?:[^\\s"“”\`,;:!?.]|\\.(?=\\S))+`;
const BARE = `${BARE_WORD}(?: ${BARE_WORD}){0,${MAX_BARE_WORDS - 1}}`;
const SIDE = `(?:"([^"]{1,80})"|“([^”]{1,80})”|\`([^\`]{1,80})\`|(${BARE}))`;
/** Same shape (still four groups, so indexes line up) but the bare alternative can never match. */
const QUOTED_SIDE = `(?:"([^"]{1,80})"|“([^”]{1,80})”|\`([^\`]{1,80})\`|((?!)))`;
const GROUPS_PER_SIDE = 4;
/**
 * Trailing sentence punctuation tolerated after the last side. A correction
 * may also be followed by a new sentence ("... not Ashlur. remember that.",
 * "... not Ashler! now deploy it"): once a sentence terminator plus whitespace
 * follows the last side, the rest of the message is ignored. A comma or an
 * unpunctuated clause still fails, so "not Ashler, please remember" is rejected.
 */
const TAIL = `\\s*(?:[.!?]+\\s+[\\s\\S]*)?[.!?]*\\s*$`;
/** A correction may be introduced mid-message ("no, it's X not Y") but must end its sentence (see TAIL). */
// \u2014 is the em dash, written as an escape so the source holds none.
const LEAD = `(?:^|[\\s,;:\u2014-])`;

/** An apostrophe: the ASCII one or U+2019, written as an escape. */
const APOS = `['\u2019]`;

/** "it's", "it\u2019s", "its" (STT drops the apostrophe) or "it is" (STT spells the contraction out). */
const IT_IS = `it(?:${APOS}?s| is)`;

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
  /**
   * A literal every match must contain, tested first (with the same `iu`
   * flags) so a prompt without it never reaches the full pattern. The full
   * patterns backtrack and run in V8's regexp interpreter on a cold process,
   * which cost the prompt hook about 10 ms on an ordinary prompt that is not
   * a correction at all.
   */
  needle: RegExp;
}

/** Order matters: first match wins. Every regex is case-insensitive. */
const PATTERNS: readonly CorrectionPattern[] = [
  // "it's X not Y" / "it's X, not Y" / "it's spelled X, not Y". The apostrophe
  // may be the typographic one (U+2019) that macOS and iOS smart punctuation and
  // dictation write; with only `'` accepted, "it\u2019s Ashlr.AI not Ashler" was no correction.
  // Speech-to-text often writes the contraction out ("it is X not Y") or drops
  // its apostrophe ("its X not Y"); IT_IS accepts all three.
  { template: `${LEAD}${IT_IS} (?:spelled |spelt |written |called )?{X},? not {Y}${TAIL}`, order: ['meant', 'heard'], example: "it's Ashlr.AI, not Ashler", needle: /not /iu },
  // "I said X not Y"
  { template: `${LEAD}i said {X},? not {Y}${TAIL}`, order: ['meant', 'heard'], example: 'I said Ashlr.AI not Ashler', needle: /not /iu },
  // "I meant X not Y"
  { template: `${LEAD}i meant {X},? not {Y}${TAIL}`, order: ['meant', 'heard'], example: 'I meant Ashlr.AI not Ashler', needle: /not /iu },
  // "X not Y" with no verb - only when both sides are quoted, otherwise far too loose
  { template: `^\\s*{X},? not {Y}${TAIL}`, order: ['meant', 'heard'], quotedOnly: true, example: '"Ashlr.AI" not "Ashler"', needle: /not /iu },
  // "not Y, X" / "not Y, it's X"
  { template: `^\\s*not {Y},\\s*(?:${IT_IS} |i meant |i said |but )?{X}${TAIL}`, order: ['heard', 'meant'], example: "not Ashler, Ashlr.AI", needle: /not /iu },
  // "replace Y with X"
  { template: `${LEAD}replace {Y} with {X}${TAIL}`, order: ['heard', 'meant'], bareNeedsName: true, example: 'replace Ashler with Ashlr.AI', needle: /replace /iu },
  // "Y -> X" / "Y => X" / "Y → X"
  { template: `^\\s*{Y}\\s*(?:->|=>|→)\\s*{X}${TAIL}`, order: ['heard', 'meant'], example: 'Ashler -> Ashlr.AI', needle: /->|=>|→/u },
  // "that should be X" (heard unknown; caller fills it from context). Must precede "Y should be X".
  { template: `${LEAD}(?:that|this|it) should (?:be|read|say) {X}${TAIL}`, order: ['meant'], example: 'that should be Ashlr.AI', needle: /should /iu },
  // "Y should be X"
  { template: `^\\s*{Y} should (?:be|read|say) {X}${TAIL}`, order: ['heard', 'meant'], bareNeedsName: true, example: 'Ashler should be Ashlr.AI', needle: /should /iu },
  // "spelled X" / "it's spelled X" / "spell it X" (heard unknown; caller fills it from context)
  { template: `\\b(?:spell(?:ed|t)?(?: it| as)?|spelling(?: is|:)?) {X}${TAIL}`, order: ['meant'], example: 'spelled Ashlr.AI', needle: /spel/iu },
];

/** One human-readable example per supported phrasing, for error messages and docs. */
export const CORRECTION_EXAMPLES: readonly string[] = PATTERNS.map((p) => p.example);

interface CompiledPattern {
  needle: RegExp;
  re: RegExp;
  order: readonly Side[];
  bareNeedsName: boolean;
}

const COMPILED: readonly CompiledPattern[] = PATTERNS.map((p) => {
  const side = p.quotedOnly ? QUOTED_SIDE : SIDE;
  const source = p.template.replace(/\{[XY]\}/g, side);
  return { needle: p.needle, re: new RegExp(source, 'iu'), order: p.order, bareNeedsName: p.bareNeedsName === true };
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

  for (const { needle, re, order, bareNeedsName } of COMPILED) {
    if (!needle.test(input)) continue;
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
    // "it's 2024 not 2023" or "it's 3:30, not 3:15" corrects a fact, not a
    // spelling: a name holds a letter. Learned, it rewrote every 2023 to 2024.
    if (!/\p{L}/u.test(meant)) return undefined;
    return { heard, meant };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// learnCorrection
// ---------------------------------------------------------------------------

/** Trimmed, lowercased and in NFC, as store.ts compares spellings ("Caf\u00e9" and NFD "Cafe\u0301" are one). */
function foldText(s: string): string {
  return s.trim().toLowerCase().normalize('NFC');
}

function sameText(a: string, b: string): boolean {
  return foldText(a) === foldText(b);
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
    const key = foldText(v);
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
  opts: StoreOptions & {
    scope?: TermScope;
    /** Passed to `addTerm`: a project file written here is not registered as trusted. */
    leaveUntrusted?: boolean;
  } = {},
): Promise<LearnResult> {
  const heard = c.heard.trim().replace(/\s+/g, ' ');
  const meant = c.meant.trim().replace(/\s+/g, ' ');
  if (!meant) throw new InputError('the intended spelling (meant) must not be empty');
  if (!heard) {
    throw new InputError(
      `nothing to learn: give the misspelled form that was heard for "${meant}" (heard, e.g. "Ashler")`,
    );
  }
  // The usual cause is a whole phrase passed as `heard`, so say what to pass
  // (the words MCP learn_correction uses; POST /learn and the CLI show this).
  const tooLong = [...(heard.length > MAX_CORRECTION_LENGTH ? ['heard'] : []), ...(meant.length > MAX_CORRECTION_LENGTH ? ['meant'] : [])];
  if (tooLong.length > 0) {
    throw new InputError(
      `${tooLong.join(' and ')} must be at most ${MAX_CORRECTION_LENGTH} characters; nothing was written. Pass only the misspelled name as heard and the name the user wants as meant, not the sentence around them.`,
    );
  }
  if (heard === meant) {
    throw new InputError(`"${heard}" and "${meant}" are the same spelling; nothing to learn`);
  }

  const { scope, leaveUntrusted, ...storeOpts } = opts;
  const loaded = await loadLexicon(storeOpts);
  const writeOpts: StoreOptions & { leaveUntrusted?: boolean } = { ...storeOpts, ...(leaveUntrusted ? { leaveUntrusted } : {}) };
  if (sameText(heard, meant)) return learnCaseOnly(heard, meant, loaded, writeOpts, scope);
  const existing = termFor(loaded.merged, meant);

  const conflict = conflictFor(loaded.merged, heard, existing?.canonical ?? meant);
  const untrusted = untrustedClaim(loaded, heard, existing?.canonical ?? meant);
  const withConflict = { ...(conflict ? { conflict } : {}), ...(untrusted ? { untrustedProject: untrusted } : {}) };

  if (existing) {
    const targetScope: TermScope = scope ?? existing.scope ?? 'global';
    // Known where it would be written: the term's own file, or the file an
    // explicit scope names. Learning the same correction again rewrote the
    // file with the same bytes (so a watcher reloaded and a project file's
    // timestamp moved), and with a scope the term does not live in it wrote
    // a hollow copy there (created, with no alias) while reporting nothing added.
    const targetFile = targetScope === 'project' ? loaded.project : loaded.global;
    const inTarget = scope === undefined ? existing : targetFile?.lexicon.terms.find((t) => sameText(t.canonical, existing.canonical));
    const known = (t: Term | undefined): boolean => t !== undefined && (sameText(t.canonical, heard) || t.aliases.some((a) => sameText(a, heard)));
    if (known(inTarget) && targetFile) {
      return { term: existing, created: false, file: targetFile, aliasAdded: false, ...withConflict };
    }
    const saved = await addTerm(
      { canonical: existing.canonical, aliases: [heard], source: 'learned' },
      { ...writeOpts, scope: targetScope },
    );
    return { term: saved.term, created: saved.created, file: saved.file, aliasAdded: true, ...withConflict };
  }

  const aliases = dedupeCaseInsensitive([heard, ...suggestAliases(meant)]).filter((a) => !sameText(a, meant));
  const saved = await addTerm(
    { canonical: meant, aliases, source: 'learned' },
    { ...writeOpts, scope: scope ?? 'global' },
  );
  return { term: saved.term, created: saved.created, file: saved.file, aliasAdded: true, ...withConflict };
}

/**
 * Every spelling in `spellings` that a term other than `target` also holds,
 * as its canonical or an alias: the `conflict` learnCorrection reports, for a
 * whole alias list (MCP add_term). One entry per spelling, in order.
 */
export function spellingConflicts(lexicon: Lexicon, spellings: readonly string[], target: string): LearnConflict[] {
  const out: LearnConflict[] = [];
  for (const spelling of spellings) {
    const c = conflictFor(lexicon, spelling, target);
    if (c) out.push(c);
  }
  return out;
}

/**
 * A term other than `target` that holds `heard` as its canonical or as an
 * alias. learnCorrection never edits that term (one correction touches one
 * term); it reports it so the caller can say why the correction may not win.
 */
function conflictFor(lexicon: Lexicon, heard: string, target: string): LearnConflict | undefined {
  for (const t of lexicon.terms) {
    if (sameText(t.canonical, target)) continue;
    const scope: TermScope = t.scope ?? 'global';
    if (sameText(t.canonical, heard)) return { canonical: t.canonical, scope, as: 'canonical', spelling: t.canonical };
    const alias = t.aliases.find((a) => sameText(a, heard));
    if (alias !== undefined) return { canonical: t.canonical, scope, as: 'alias', spelling: alias };
  }
  return undefined;
}

/**
 * The skipped project file, when one of its terms other than `target` claims
 * `heard`. Only a yes or no comes out of the untrusted content: the term it
 * found is not returned, so nothing from the file reaches the caller.
 */
function untrustedClaim(loaded: LoadedLexicon, heard: string, target: string): LearnResult['untrustedProject'] {
  const skipped = loaded.skippedProject;
  if (!skipped || !conflictFor(skipped.lexicon, heard, target)) return undefined;
  return { path: skipped.path, trust: loaded.projectTrust === 'changed' ? 'changed' : 'untrusted' };
}

/**
 * "ashlr" should be "Ashlr": the spelling is right and only the case is not.
 * An alias that differs from the canonical only by case is meaningless (alias
 * matching ignores case, and the canonical itself already matches), so the
 * thing to learn is the canonical's casing:
 * - no term yet: create `meant` (with suggested misspellings), which rewrites
 *   every casing of it from now on;
 * - a term whose canonical is the same word in another case: recase it, keeping
 *   its aliases, notes and history;
 * - a term already spelled `meant`: nothing to write, reported as known;
 * - `meant` is an alias of a different term: refuse, because "ashlr" is being
 *   rewritten to that term and only the user can say which one is right.
 */
async function learnCaseOnly(
  heard: string,
  meant: string,
  loaded: Awaited<ReturnType<typeof loadLexicon>>,
  storeOpts: StoreOptions & { leaveUntrusted?: boolean },
  scope: TermScope | undefined,
): Promise<LearnResult> {
  const byCanonical = loaded.merged.terms.find((t) => sameText(t.canonical, meant));
  // The same checks as any other correction: another term (or the skipped
  // project file) that also claims `heard` keeps rewriting it to that term.
  const target = byCanonical?.canonical ?? meant;
  const conflict = conflictFor(loaded.merged, heard, target);
  const untrusted = untrustedClaim(loaded, heard, target);
  const withConflict = { ...(conflict ? { conflict } : {}), ...(untrusted ? { untrustedProject: untrusted } : {}) };
  if (!byCanonical) {
    const viaAlias = loaded.merged.terms.find((t) => t.aliases.some((a) => sameText(a, meant)));
    if (viaAlias) {
      throw new InputError(
        `"${meant}" is an alias of "${viaAlias.canonical}", so it is corrected to that; ` +
          `if "${meant}" is its own name, first drop that alias from "${viaAlias.canonical}" (lexicon review or lexicon edit; removing the term would delete it)`,
      );
    }
    const saved = await addTerm(
      { canonical: meant, aliases: suggestAliases(meant).filter((a) => !sameText(a, meant)), source: 'learned' },
      { ...storeOpts, scope: scope ?? 'global' },
    );
    return { term: saved.term, created: saved.created, file: saved.file, aliasAdded: true, ...withConflict };
  }

  const termScope: TermScope = byCanonical.scope ?? 'global';
  const file = termScope === 'project' ? loaded.project : loaded.global;
  // In NFC, as the store writes it: `Cafe` plus U+0301 is the canonical
  // `Café` already, and recasing to it rewrote the file and reported a change.
  if (byCanonical.canonical.normalize('NFC') === meant.normalize('NFC') && file) {
    return { term: byCanonical, created: false, file, aliasAdded: false, ...withConflict };
  }
  // Recase from the term as it is on disk, not the merged view: that one
  // carries the other file's aliases and this user's hit count.
  const onDisk = file?.lexicon.terms.find((t) => sameText(t.canonical, byCanonical.canonical));
  const base: Term = onDisk ?? byCanonical;
  const saved = await addTerm(
    { ...base, canonical: meant, aliases: base.aliases.filter((a) => !sameText(a, meant)) },
    { ...storeOpts, scope: termScope, merge: false },
  );
  return { term: saved.term, created: false, file: saved.file, aliasAdded: true, ...withConflict };
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
