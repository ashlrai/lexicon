/**
 * The expansion core of the resident expander: a pure state machine over the
 * keystrokes typed into one focused text field. It keeps the tail of what was
 * typed, and when a word is finished (whitespace after it) runs the matcher
 * over that tail; a correction that ends in the word just finished becomes an
 * action for the key source to perform: press Backspace `backspaces` times,
 * then type `insert`. Nothing here does IO, reads a clock or the environment,
 * so every rule is a unit test (tests/daemon/expander.test.ts).
 *
 * Rules, each one a way a live rewrite could damage what the user meant:
 * - Only whitespace finishes a word. Punctuation does not (`Ashler.com`,
 *   `foo@ashler.io` must survive to their end), and the matcher still sees it,
 *   so `Ashler.` corrects when the space after the period arrives.
 * - Only the newly finished words are looked at. A correction that ends in
 *   text already settled (the user kept it, or undid our rewrite) is never
 *   made, and nothing may start inside our own inserted text.
 * - Enter, Tab, Escape, arrows, Home/End, Page keys, Delete and `reset` (the
 *   key source sends it for a click, a shortcut or a focus change) forget the
 *   buffer: after them the cursor is not where we think, or the field may have
 *   been submitted, so Backspaces could land on the wrong text.
 * - Backspace straight after an expansion is the undo gesture, as in espanso:
 *   the original text comes back and that word is never expanded again.
 * - `backspaces` counts grapheme clusters (what one Backspace removes in a
 *   text field), not UTF-16 units: `Zoë` with a combining mark, an emoji.
 *
 * Matching is alias-only by default (no phonetic or fuzzy tier): rewriting
 * text as it is typed must be exactly what the user listed, not a guess.
 */
import { buildIndex, normalizeWithIndex } from '../core/index.js';
import type { Lexicon, MatcherIndex, NormalizeOptions, Replacement } from '../core/index.js';

/** Keys that are not text. Every one but Backspace forgets the buffer. */
export const EXPANDER_NAMED_KEYS = [
  'Backspace',
  'Enter',
  'Tab',
  'Escape',
  'Delete',
  'Left',
  'Right',
  'Up',
  'Down',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'reset',
] as const;
export type ExpanderNamedKey = (typeof EXPANDER_NAMED_KEYS)[number];

export function isExpanderNamedKey(value: string): value is ExpanderNamedKey {
  return (EXPANDER_NAMED_KEYS as readonly string[]).includes(value);
}

/** What the key source does: Backspace `backspaces` times, then types `insert`. */
export interface ExpansionAction {
  kind: 'expand' | 'undo';
  /** Backspace presses, counted in grapheme clusters. */
  backspaces: number;
  /** Text to type after the Backspaces. */
  insert: string;
  /** The corrections made (for `expand`) or reverted (for `undo`). */
  replacements: { original: string; replacement: string; canonical: string }[];
}

export interface ExpanderOptions {
  /** Matcher options. Default `{ phonetic: false, fuzzy: false }`: aliases only. */
  normalize?: NormalizeOptions;
  /** Characters of typed text kept as context. Default 256; at least 32. */
  maxBuffer?: number;
}

export const DEFAULT_EXPANDER_BUFFER = 256;
const MIN_EXPANDER_BUFFER = 32;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Grapheme clusters in `s`: what that many Backspace presses remove. */
export function graphemeCount(s: string): number {
  let n = 0;
  for (const _ of segmenter.segment(s)) n += 1;
  return n;
}

function withoutLastGrapheme(s: string): string {
  let last = 0;
  for (const seg of segmenter.segment(s)) last = seg.index;
  return s.slice(0, last);
}

/** A Backspace cannot remove only part of the grapheme containing `at`. */
function graphemeStart(s: string, at: number): number {
  let start = 0;
  for (const seg of segmenter.segment(s)) {
    if (seg.index > at) break;
    start = seg.index;
  }
  return start;
}

const WHITESPACE_RE = /\s/u;
const WORD_RE = /[\p{L}\p{N}]/u;

interface LastExpansion {
  /** Buffer length right after the expansion. */
  at: number;
  /** The text the expansion replaced, from `start` to `at`. */
  before: string;
  /** Where the replaced text began, negative if trimming has passed it. */
  start: number;
  /** Entire inserted suffix, retained for undo even after the context is trimmed. */
  rendered: string;
  replacements: ExpansionAction['replacements'];
}

/**
 * One field's expander. `type` text as it is typed, `key` the named keys;
 * either may return the action to perform. A new lexicon (`setIndex`) keeps
 * the buffer, so a term learned mid-sentence applies from the next word.
 */
export class Expander {
  private index: MatcherIndex;
  private readonly matchOpts: NormalizeOptions;
  private readonly maxBuffer: number;
  private text = '';
  /** Text before this offset is settled: no correction may end at or before it. */
  private settled = 0;
  /** No correction may start before this offset (our own output, an undone word). */
  private floor = 0;
  private last: LastExpansion | undefined;
  /** A token outgrew the buffer: its unseen prefix still precedes the cursor. */
  private discardingWord = false;
  private hasUntrackedPrefix = false;

  constructor(lexicon: Lexicon | MatcherIndex, opts: ExpanderOptions = {}) {
    this.index = 'terms' in lexicon ? buildIndex(lexicon) : lexicon;
    this.matchOpts = { phonetic: false, fuzzy: false, ...opts.normalize, dryRun: false };
    if (opts.maxBuffer !== undefined && !Number.isFinite(opts.maxBuffer)) {
      throw new RangeError('maxBuffer must be a finite number');
    }
    this.maxBuffer = Math.max(MIN_EXPANDER_BUFFER, Math.floor(opts.maxBuffer ?? DEFAULT_EXPANDER_BUFFER));
  }

  /** The typed text the expander currently believes is before the cursor. */
  get buffer(): string {
    return this.text;
  }

  setIndex(lexicon: Lexicon | MatcherIndex): void {
    this.index = 'terms' in lexicon ? buildIndex(lexicon) : lexicon;
  }

  reset(): void {
    this.text = '';
    this.settled = 0;
    this.floor = 0;
    this.last = undefined;
    this.discardingWord = false;
    this.hasUntrackedPrefix = false;
  }

  /**
   * Text typed (one key, or a chunk a dictation tool injected at once). The
   * whole chunk is appended before matching, so a chunk ending in whitespace
   * is corrected in one action however many words it holds.
   */
  type(chunk: string): ExpansionAction | undefined {
    if (chunk === '') return undefined;
    this.last = undefined;
    if (this.discardingWord) {
      // A bounded tail must not turn the suffix of a long identifier or URL
      // into a new word. Backspace cannot reconstruct its discarded prefix.
      const boundary = chunk.search(WHITESPACE_RE);
      if (boundary === -1) return undefined;
      chunk = chunk.slice(boundary);
      this.discardingWord = false;
    }
    this.text += chunk;
    const done = this.finishedEnd();
    let action: ExpansionAction | undefined;
    if (done > this.settled) {
      action = this.expand(done);
      this.settled = Math.max(this.settled, this.finishedEnd());
    }
    this.trim();
    return action;
  }

  /** A named key. Only Backspace can return an action (the undo). */
  key(name: ExpanderNamedKey): ExpansionAction | undefined {
    if (name !== 'Backspace') {
      this.reset();
      return undefined;
    }
    const last = this.last;
    this.last = undefined;
    if (last && last.at === this.text.length) return this.undo(last);
    this.text = withoutLastGrapheme(this.text);
    if (this.text === '' && this.hasUntrackedPrefix) this.discardingWord = true;
    this.settled = Math.min(this.settled, this.text.length);
    this.floor = Math.min(this.floor, this.text.length);
    return undefined;
  }

  /** End of the last finished word: the length of the buffer without its trailing non-whitespace run. */
  private finishedEnd(): number {
    let end = this.text.length;
    while (end > 0 && !WHITESPACE_RE.test(this.text[end - 1] ?? '')) end -= 1;
    return end;
  }

  private expand(done: number): ExpansionAction | undefined {
    const region = this.text.slice(0, done);
    if (!WORD_RE.test(region.slice(this.settled))) return undefined;
    const result = normalizeWithIndex(region, this.index, this.matchOpts);
    const picked = result.replacements.filter(
      (r: Replacement) => r.end > this.settled && r.start >= this.floor && r.replacement !== r.original,
    );
    if (picked.length === 0) return undefined;
    const before = this.text;
    const start = graphemeStart(before, picked[0]!.start);
    const parts: string[] = [];
    let at = start;
    for (const r of picked) {
      parts.push(region.slice(at, r.start), r.replacement);
      at = r.end;
    }
    const lastEnd = at;
    parts.push(this.text.slice(at));
    const insert = parts.join('');
    const removed = this.text.slice(start);
    const action: ExpansionAction = {
      kind: 'expand',
      backspaces: graphemeCount(removed),
      insert,
      replacements: picked.map((r) => ({ original: r.original, replacement: r.replacement, canonical: r.canonical })),
    };
    this.text = this.text.slice(0, start) + insert;
    // Nothing may start inside what we just wrote: the floor is the end of the
    // last replacement, which sits before the unchanged text that followed it.
    this.floor = this.text.length - (start + removed.length - lastEnd);
    // A canonical may begin with a combining mark and join the preceding
    // grapheme. Include that unchanged prefix in a later undo as well.
    const undoStart = graphemeStart(this.text, start);
    this.last = {
      at: this.text.length,
      before: before.slice(undoStart),
      start: undoStart,
      rendered: this.text.slice(undoStart),
      replacements: action.replacements,
    };
    return action;
  }

  private undo(last: LastExpansion): ExpansionAction {
    // The Backspace itself already removed one grapheme from the field.
    const shown = withoutLastGrapheme(last.rendered);
    const restored = withoutLastGrapheme(last.before);
    this.text = (last.start > 0 ? this.text.slice(0, last.start) : '') + restored;
    this.discardingWord = false;
    // The restored words are settled and may never be expanded again.
    this.settled = this.text.length;
    this.floor = this.text.length;
    this.trim();
    return {
      kind: 'undo',
      backspaces: graphemeCount(shown),
      insert: restored,
      replacements: last.replacements,
    };
  }

  /** Keep at most maxBuffer characters, cut at whitespace so no partial word is left at the front. */
  private trim(): void {
    if (this.text.length <= this.maxBuffer) return;
    let cut = this.text.length - this.maxBuffer;
    while (cut < this.text.length && !WHITESPACE_RE.test(this.text[cut - 1] ?? '')) cut += 1;
    // Whitespace and a following combining mark can be one grapheme.
    for (const seg of segmenter.segment(this.text)) {
      if (seg.index >= cut) {
        cut = seg.index;
        break;
      }
      if (seg.index + seg.segment.length > cut) cut = seg.index + seg.segment.length;
    }
    if (cut === this.text.length && !WHITESPACE_RE.test(this.text.at(-1) ?? '')) {
      this.discardingWord = true;
    }
    this.hasUntrackedPrefix = true;
    this.text = this.text.slice(cut);
    this.settled = Math.max(0, this.settled - cut);
    this.floor = Math.max(0, this.floor - cut);
    if (this.last) {
      this.last = { ...this.last, at: this.last.at - cut, start: this.last.start - cut };
    }
  }
}
