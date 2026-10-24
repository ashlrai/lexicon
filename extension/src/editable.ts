/**
 * Read and rewrite text in a composer without breaking the editor behind it.
 *
 * Rich editors (ProseMirror on ChatGPT and Claude, Lexical on Perplexity,
 * Quill on Gemini) own their DOM. Replacing innerHTML desyncs their state,
 * so corrections are applied as ranged `insertText` edits, which every one
 * of them observes like a native IME or spellcheck replacement. Textareas
 * get `insertText` or `setRangeText` (the browser's own edit, so undo keeps
 * working), and the React-safe native value setter plus an `input` event
 * only when neither takes.
 */
import { CODE_SELECTOR, deepActiveElement, isTextField, selectionFor } from './adapters.js';
import { API_MAX_BODY_BYTES } from './shared.js';
import type { Correction } from './shared.js';

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'PRE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'SECTION']);

export interface Segment {
  node: Text;
  /** Offset of node.data[0] in the flattened text. */
  start: number;
}

export interface Flattened {
  text: string;
  segments: Segment[];
}

/**
 * Flatten a contenteditable to plain text: text nodes in order, `<br>` and
 * block boundaries as `\n`. A `<br>` that ends a block (ProseMirror's
 * trailing break) is ignored so an empty paragraph does not count twice.
 */
export function flatten(root: Element): Flattened {
  const segments: Segment[] = [];
  let text = '';
  let pendingBreak = false;

  const push = (s: string): void => {
    if (pendingBreak && text.length > 0) {
      text += '\n';
    }
    pendingBreak = false;
    text += s;
  };

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const t = node as Text;
      if (pendingBreak && text.length > 0) text += '\n';
      pendingBreak = false;
      segments.push({ node: t, start: text.length });
      text += t.data;
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName;
    if (tag === 'BR') {
      const last = el.parentElement && el === el.parentElement.lastChild && BLOCK_TAGS.has(el.parentElement.tagName);
      if (!last) push('\n');
      return;
    }
    if (tag === 'SCRIPT' || tag === 'STYLE') return;
    const block = BLOCK_TAGS.has(tag) && el !== root;
    if (block) {
      // A new block always starts a new line, even when the previous block
      // was empty (ProseMirror's blank paragraph), so blank lines survive.
      if (pendingBreak || text.length > 0) text += '\n';
      pendingBreak = false;
    }
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block) pendingBreak = true;
  };

  for (const child of Array.from(root.childNodes)) walk(child);
  return { text, segments };
}

/**
 * The flattened `[start, end)` ranges of `el`'s text that sit inside code: a
 * `<pre>` block, inline `<code>` or a code editor (CODE_SELECTOR) under `el`.
 * Empty for a text field, whose code is markdown the matcher skips itself.
 * A rich editor holds code as elements, which flattening drops, so without
 * these ranges a code block typed into ChatGPT's or Claude's composer was
 * corrected on send like the prose around it.
 */
export function codeRanges(el: HTMLElement, flat?: Flattened): Array<[number, number]> {
  if (isTextField(el)) return [];
  const out: Array<[number, number]> = [];
  for (const seg of (flat ?? flatten(el)).segments) {
    const code = seg.node.parentElement?.closest(CODE_SELECTOR) ?? null;
    if (code === null || !el.contains(code) || seg.node.data.length === 0) continue;
    const start = seg.start;
    const end = seg.start + seg.node.data.length;
    const last = out[out.length - 1];
    if (last && last[1] >= start) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/**
 * `text` with every character in `ranges` except line breaks replaced by `_`:
 * the same length, so offsets into it are offsets into `text`, and no word
 * of the code is left for the engine to match (`_` is not a word character
 * to the matcher and, not being whitespace, keeps a phrase from joining
 * across the code). Ranges past the end of `text` are clipped.
 */
export function maskCode(text: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  if (ranges.length === 0) return text;
  let out = '';
  let at = 0;
  for (const [start, end] of ranges) {
    const s = Math.min(Math.max(start, at), text.length);
    const e = Math.min(end, text.length);
    if (e <= s) continue;
    out += text.slice(at, s) + text.slice(s, e).replace(/[^\n]/g, '_');
    at = e;
  }
  return out + text.slice(at);
}

export function readText(el: HTMLElement): string {
  if (isTextField(el)) return el.value;
  return flatten(el).text;
}

/**
 * The most characters of composer text the content script checks: the
 * server's request limit (`API_MAX_BODY_BYTES`, MAX_BODY_BYTES in
 * src/serve/server.ts), which text longer than this always exceeds as a
 * request. A longer composer is not read, flattened or sent to the
 * background at all, on each keystroke or on send.
 */
export const MAX_COMPOSER_CHARS = API_MAX_BODY_BYTES;

/**
 * True when `el` holds more than MAX_COMPOSER_CHARS characters, measured
 * without flattening (a field's value, a rich composer's `textContent`,
 * which leaves out only the line breaks flattening adds).
 */
export function composerTooLarge(el: HTMLElement): boolean {
  const length = isTextField(el) ? el.value.length : (el.textContent ?? '').length;
  return length > MAX_COMPOSER_CHARS;
}

/** What one check of a composer needs, from one flattening: its text, code ranges and caret. */
export interface ComposerSnapshot {
  text: string;
  /** `codeRanges` of the composer. */
  ranges: Array<[number, number]>;
  /** `caretOffset` of the composer. */
  caret: number;
}

/**
 * `readText`, `codeRanges` and `caretOffset` of `el` from a single
 * flattening. Each of them flattened the whole composer on its own, so a
 * live check of a long message walked it three times before it was sent.
 */
export function snapshot(doc: Document, el: HTMLElement): ComposerSnapshot {
  if (isTextField(el)) return { text: el.value, ranges: [], caret: el.selectionEnd ?? el.value.length };
  const flat = flatten(el);
  return { text: flat.text, ranges: codeRanges(el, flat), caret: caretOffset(doc, el, flat) };
}

/**
 * Map a flattened offset to a text node position. At a node boundary the
 * offset belongs to two nodes; a range START takes the later node (offset 0)
 * and a range END takes the earlier one (offset = length) so the range stays
 * inside the inline element it targets. Otherwise `deleteContents` collapses
 * the range outside that element and the replacement lands beside it.
 */
export function locate(flat: Flattened, offset: number, side: 'start' | 'end' = 'start'): { node: Text; offset: number } | null {
  let best: Segment | null = null;
  for (const seg of flat.segments) {
    const end = seg.start + seg.node.data.length;
    if (offset < seg.start || offset > end) continue;
    best = seg;
    if (side === 'end' ? seg.node.data.length > 0 : offset < end) break;
  }
  if (!best) return null;
  return { node: best.node, offset: offset - best.start };
}

/** Caret position in flattened coordinates, or the text length when unknown. */
export function caretOffset(doc: Document, el: HTMLElement, flattened?: Flattened): number {
  if (isTextField(el)) return el.selectionEnd ?? el.value.length;
  const flat = flattened ?? flatten(el);
  const sel = selectionFor(doc, el);
  if (!sel || sel.rangeCount === 0) return flat.text.length;
  const range = sel.getRangeAt(0);
  const node = range.endContainer;
  if (!el.contains(node)) return flat.text.length;
  if (node.nodeType === 3) {
    const seg = flat.segments.find((s) => s.node === node);
    return seg ? seg.start + range.endOffset : flat.text.length;
  }
  // Caret sits between elements: count everything before the child at endOffset.
  const child = node.childNodes[range.endOffset] ?? null;
  if (!child) {
    const lastSeg = flat.segments.filter((s) => node.contains(s.node)).pop();
    return lastSeg ? lastSeg.start + lastSeg.node.data.length : flat.text.length;
  }
  const first = flat.segments.find((s) => child === s.node || child.contains(s.node));
  return first ? first.start : flat.text.length;
}

function nativeValueSetter(el: HTMLTextAreaElement | HTMLInputElement): ((v: string) => void) | null {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  return desc?.set ? (v: string) => desc.set!.call(el, v) : null;
}

function fireInput(el: HTMLElement, inputType: string, data?: string): void {
  let ev: Event;
  try {
    ev = new InputEvent('input', { bubbles: true, cancelable: false, inputType, data });
  } catch {
    ev = new Event('input', { bubbles: true });
  }
  el.dispatchEvent(ev);
}

function setFieldValue(el: HTMLTextAreaElement | HTMLInputElement, value: string, caret?: number): void {
  const set = nativeValueSetter(el);
  if (set) set(value);
  else el.value = value;
  const pos = caret ?? value.length;
  try {
    el.setSelectionRange(pos, pos);
  } catch {
    // input types without selection support
  }
  fireInput(el, 'insertReplacementText', value);
}

/**
 * Replace [start, end) of a text field with the browser's own edit, so it
 * goes on the field's undo stack and Ctrl+Z takes it back: `insertText`
 * (`delete` for an empty replacement) while the field has focus, else
 * `setRangeText` and an `input` event (no undo entry, but the history the
 * user typed is kept, where assigning `value` drops it in Firefox and
 * Chromium). True when the field then holds `next`; false otherwise, and
 * the caller sets the value as before.
 */
function editFieldNatively(doc: Document, el: HTMLTextAreaElement | HTMLInputElement, start: number, end: number, replacement: string, next: string): boolean {
  const value = el.value;
  if (typeof doc.execCommand === 'function' && deepActiveElement(doc) === el) {
    try {
      el.setSelectionRange(start, end);
      const ok = replacement === '' ? doc.execCommand('delete', false) : doc.execCommand('insertText', false, replacement);
      if (ok && el.value === next) return true;
    } catch {
      // input types without selection support, or no editing command
    }
    if (el.value !== value) return false;
  }
  if (typeof el.setRangeText !== 'function') return false;
  try {
    el.setRangeText(replacement, start, end, 'end');
  } catch {
    return false;
  }
  if (el.value !== next) return false;
  fireInput(el, 'insertReplacementText', replacement);
  return true;
}

/** Replace [start, end) in a text field; keeps the caret sensible. */
function replaceInField(doc: Document, el: HTMLTextAreaElement | HTMLInputElement, start: number, end: number, replacement: string): void {
  const value = el.value;
  const caretBefore = el.selectionEnd ?? value.length;
  const next = value.slice(0, start) + replacement + value.slice(end);
  let caret = caretBefore;
  if (caretBefore >= end) caret = caretBefore + (replacement.length - (end - start));
  else if (caretBefore > start) caret = start + replacement.length;
  if (editFieldNatively(doc, el, start, end, replacement, next)) {
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      // input types without selection support
    }
    return;
  }
  setFieldValue(el, next, caret);
}

/**
 * Replace a flattened range inside a contenteditable. Tries execCommand
 * (native editing; rich editors observe it), then a DOM range splice.
 * Returns true when the flattened text afterwards contains the replacement
 * at `start`.
 */
function replaceInEditable(doc: Document, el: HTMLElement, start: number, end: number, replacement: string): boolean {
  // One flattening for the expected text and the range, one to check the
  // edit: each step flattened the whole composer again, four or five walks
  // of a long message per correction.
  let flat = flatten(el);
  const expectedPrefix = flat.text.slice(0, start) + replacement;

  const selectRange = (): Range | null => {
    const from = locate(flat, start, 'start');
    const to = locate(flat, end, 'end');
    if (!from || !to) return null;
    const range = doc.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  };

  const win = doc.defaultView;
  const sel = selectionFor(doc, el);
  if (sel && typeof doc.execCommand === 'function' && win) {
    const range = selectRange();
    if (range) {
      el.focus();
      sel.removeAllRanges();
      sel.addRange(range);
      let ok = false;
      try {
        ok = doc.execCommand('insertText', false, replacement);
      } catch {
        ok = false;
      }
      const after = flatten(el);
      if (ok && after.text.startsWith(expectedPrefix)) return true;
      flat = after;
    }
  }

  const range = selectRange();
  if (!range) return false;
  range.deleteContents();
  range.insertNode(doc.createTextNode(replacement));
  const spliced = flatten(el);
  if (sel) {
    // Leave the caret after the replacement.
    const after = locate(spliced, start + replacement.length);
    if (after) {
      const r = doc.createRange();
      r.setStart(after.node, after.offset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  fireInput(el, 'insertReplacementText', replacement);
  // applyCorrections compares the whole text at the end, so a page that
  // rewrites the composer on this input event is still caught there.
  return spliced.text.startsWith(expectedPrefix);
}

/** A macrotask, so the editor behind a contenteditable can commit the previous edit. */
function settle(doc: Document): Promise<void> {
  const win = doc.defaultView;
  return new Promise((resolve) => (win ? win.setTimeout(resolve, 0) : resolve()));
}

/**
 * Apply corrections (offsets into the composer's current text) right-to-left
 * so earlier offsets stay valid. Falls back to rewriting the whole text when
 * a ranged edit does not take. Resolves with the text the composer ends with.
 *
 * Text fields and the first ranged edit are applied synchronously. Later
 * ranged edits each wait one task: Lexical (Perplexity) commits an edit in a
 * microtask and, until then, resolves the next `insertText` against its own
 * pending selection rather than the DOM range we set, so back-to-back edits
 * landed at the caret and garbled the text (seen live, 2026-09).
 */
export async function applyCorrections(doc: Document, el: HTMLElement, corrections: readonly Correction[], expected: string): Promise<string> {
  const ordered = [...corrections].sort((a, b) => b.start - a.start);
  if (isTextField(el)) {
    for (const c of ordered) replaceInField(doc, el, c.start, c.end, c.replacement);
    if (el.value !== expected) setFieldValue(el, expected);
    return el.value;
  }
  let ok = true;
  for (let i = 0; i < ordered.length; i++) {
    if (i > 0) await settle(doc);
    const c = ordered[i];
    if (!replaceInEditable(doc, el, c.start, c.end, c.replacement)) {
      ok = false;
      break;
    }
  }
  const text = flatten(el).text;
  if (ok && text === expected) return text;
  setWholeText(doc, el, expected);
  return flatten(el).text;
}

/** Replace the single-line flattened range [start, end) by editing text node data in place. */
function editTextNodes(el: HTMLElement, start: number, end: number, replacement: string): boolean {
  const flat = flatten(el);
  const from = locate(flat, start, 'start');
  const to = start === end ? from : locate(flat, end, 'end');
  if (!from || !to) return false;
  if (from.node === to.node) {
    const d = from.node.data;
    from.node.data = d.slice(0, from.offset) + replacement + d.slice(to.offset);
    return true;
  }
  const i = flat.segments.findIndex((s) => s.node === from.node);
  const j = flat.segments.findIndex((s) => s.node === to.node);
  if (i < 0 || j < i) return false;
  for (let k = i + 1; k < j; k++) {
    const seg = flat.segments[k];
    if (seg) seg.node.data = '';
  }
  from.node.data = from.node.data.slice(0, from.offset) + replacement;
  to.node.data = to.node.data.slice(to.offset);
  return true;
}

/**
 * Where `code` sits in `text` at or after `from`: the occurrence nearest
 * `expected` (where it would be if the prose before it kept its length).
 * The first occurrence was the wrong one whenever the prose before a code
 * span held the same text (`run npm, then <code>npm</code>`): the code was
 * aligned with the prose word and the rewrite fell back to flattening it.
 * -1 when `text` does not hold it.
 */
function nearestOccurrence(text: string, code: string, from: number, expected: number): number {
  let best = -1;
  for (let at = text.indexOf(code, from); at >= 0; at = text.indexOf(code, at + 1)) {
    if (best < 0 || Math.abs(at - expected) < Math.abs(best - expected)) best = at;
    else if (at > expected) break;
    if (code.length === 0) break;
  }
  return best;
}

/**
 * The edits (old flattened [start, end) and the text to put there, each
 * within one line) that turn the prose of `flat` into `text` while every code
 * range keeps its text, or null when `text` does not hold the code as it
 * stands or a prose region changed its number of lines.
 */
function proseEdits(flat: Flattened, ranges: ReadonlyArray<readonly [number, number]>, text: string): Array<[number, number, string]> | null {
  const regions: Array<[number, number, string]> = [];
  let oldAt = 0;
  let newAt = 0;
  for (const [cs, ce] of ranges) {
    const code = flat.text.slice(cs, ce);
    const idx = nearestOccurrence(text, code, newAt, newAt + (cs - oldAt));
    if (idx < 0) return null;
    regions.push([oldAt, cs, text.slice(newAt, idx)]);
    oldAt = ce;
    newAt = idx + code.length;
  }
  regions.push([oldAt, flat.text.length, text.slice(newAt)]);
  const edits: Array<[number, number, string]> = [];
  for (const [start, end, next] of regions) {
    const oldLines = flat.text.slice(start, end).split('\n');
    const newLines = next.split('\n');
    if (oldLines.length !== newLines.length) return null;
    let at = start;
    oldLines.forEach((before, n) => {
      const after = newLines[n] ?? '';
      if (before !== after) {
        let p = 0;
        while (p < before.length && p < after.length && before[p] === after[p]) p++;
        let q = 0;
        while (q < before.length - p && q < after.length - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
        edits.push([at + p, at + before.length - q, after.slice(p, after.length - q)]);
      }
      at += before.length + 1;
    });
  }
  return edits;
}

/**
 * setWholeText for a rich editor holding code (a `<pre>` block or inline
 * `<code>`): only the prose text nodes are rewritten, so the code elements
 * keep their structure. Replacing everything turned a code block into plain
 * paragraphs. False (and nothing changed) when that cannot be done.
 */
function setProseKeepingCode(el: HTMLElement, text: string): boolean {
  const ranges = codeRanges(el);
  if (ranges.length === 0) return false;
  const flat = flatten(el);
  const edits = proseEdits(flat, ranges, text);
  if (edits === null) return false;
  const saved = flat.segments.map((s) => [s.node, s.node.data] as const);
  for (const [start, end, replacement] of [...edits].sort((a, b) => b[0] - a[0])) {
    if (!editTextNodes(el, start, end, replacement)) {
      for (const [node, data] of saved) node.data = data;
      return false;
    }
  }
  if (flatten(el).text === text) return true;
  for (const [node, data] of saved) node.data = data;
  return false;
}

/** The outermost code elements under `el` (a `<pre>`, inline `<code>`, a code editor), in document order. */
function outerCodeElements(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(CODE_SELECTOR)).filter((c) => {
    const outer = c.parentElement?.closest(CODE_SELECTOR) ?? null;
    return outer === null || !el.contains(outer) || outer === el;
  });
}

/**
 * setWholeText for a rich editor holding code when ranged prose edits
 * cannot express the rewrite (a prose region gained or lost a line): the
 * composer is rebuilt from `text`, one paragraph (or `<br>` line) per line as
 * the last resort does, but each code element goes back in as the element it
 * was, where its text sits in `text`: a block one (`<pre>`) on lines of its
 * own, an inline one inside its line. False, with every node put back where
 * it was, when `text` does not hold each code element's text in order (a
 * block one on whole lines) or the rebuilt composer does not read back as
 * `text`. The last resort flattened the code in both cases.
 */
function rebuildKeepingCode(doc: Document, el: HTMLElement, text: string): boolean {
  const codes = outerCodeElements(el);
  if (codes.length === 0) return false;
  const flat = flatten(el);
  type Part = string | HTMLElement;
  const out: Array<{ line: Part[] } | { block: HTMLElement }> = [];
  let cur: Part[] | null = null;
  const addProse = (chunk: string): void => {
    chunk.split('\n').forEach((part, n) => {
      if (n > 0 && cur !== null) {
        out.push({ line: cur });
        cur = null;
      }
      cur ??= [];
      if (part) cur.push(part);
    });
  };
  let newAt = 0;
  let oldAt = 0;
  // After a block element, the line break that ends it belongs to it.
  let afterBlock = false;
  for (const code of codes) {
    const codeText = flatten(code).text;
    const first = flat.segments.find((seg) => code.contains(seg.node));
    const oldStart = first ? first.start : oldAt;
    const idx = nearestOccurrence(text, codeText, newAt, newAt + Math.max(0, oldStart - oldAt));
    if (idx < 0) return false;
    const end = idx + codeText.length;
    if (BLOCK_TAGS.has(code.tagName)) {
      if (idx > 0 && text[idx - 1] !== '\n') return false;
      if (end < text.length && text[end] !== '\n') return false;
      if (idx - 1 >= newAt) addProse(text.slice(newAt, idx - 1));
      if (cur !== null) out.push({ line: cur });
      cur = null;
      out.push({ block: code });
      newAt = end < text.length ? end + 1 : end;
      afterBlock = end === text.length;
    } else {
      addProse(text.slice(newAt, idx));
      (cur as Part[] | null)?.push(code);
      newAt = end;
      afterBlock = false;
    }
    oldAt = oldStart + codeText.length;
  }
  if (!afterBlock) addProse(text.slice(newAt));
  if (cur !== null) out.push({ line: cur });

  const saved = Array.from(el.childNodes);
  const homes = codes.map((c) => [c, c.parentNode, c.nextSibling] as const);
  const usesParagraphs = Array.from(el.querySelectorAll('p')).some((p) => !codes.some((c) => c.contains(p)));
  while (el.firstChild) el.removeChild(el.firstChild);
  let prevWasLine = false;
  for (const [i, item] of out.entries()) {
    if ('block' in item) {
      el.appendChild(item.block);
      prevWasLine = false;
      continue;
    }
    const nodes = item.line.map((part) => (typeof part === 'string' ? doc.createTextNode(part) : part));
    const next = out[i + 1];
    if (!usesParagraphs && nodes.length === 0 && (next === undefined || 'block' in next)) {
      // An empty line before a block element or the end: a `<br>` there
      // reads as nothing (its break was left to a following text line, and a
      // trailing one is dropped), so the line is an empty block of its own,
      // as a browser writes one in a `<div>` composer.
      const blank = doc.createElement('div');
      blank.appendChild(doc.createElement('br'));
      el.appendChild(blank);
      prevWasLine = false;
      continue;
    }
    if (usesParagraphs) {
      const p = doc.createElement('p');
      if (nodes.length === 0) p.appendChild(doc.createElement('br'));
      for (const node of nodes) p.appendChild(node);
      el.appendChild(p);
    } else {
      if (prevWasLine) el.appendChild(doc.createElement('br'));
      for (const node of nodes) el.appendChild(node);
    }
    prevWasLine = true;
  }
  if (flatten(el).text === text) return true;
  while (el.firstChild) el.removeChild(el.firstChild);
  // Direct children go back with the rest; a nested one goes back into its old parent first.
  for (const [code, parent, next] of [...homes].reverse()) if (parent !== null && parent !== el) parent.insertBefore(code, next);
  for (const node of saved) el.appendChild(node);
  return false;
}

/**
 * Last resort: replace everything. Keeps one paragraph per line for
 * ProseMirror-style editors, and a composer's `<pre>` and `<code>` elements
 * as they are (only the prose around them is rewritten).
 */
export function setWholeText(doc: Document, el: HTMLElement, text: string): void {
  if (isTextField(el)) {
    setFieldValue(el, text);
    return;
  }
  if (el.querySelector(CODE_SELECTOR) !== null && (setProseKeepingCode(el, text) || rebuildKeepingCode(doc, el, text))) {
    fireInput(el, 'insertReplacementText', text);
    return;
  }
  const sel = selectionFor(doc, el);
  if (sel && typeof doc.execCommand === 'function') {
    el.focus();
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try {
      ok = doc.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }
    if (ok && flatten(el).text === text) return;
  }
  const usesParagraphs = el.querySelector('p') !== null;
  while (el.firstChild) el.removeChild(el.firstChild);
  const lines = text.split('\n');
  if (usesParagraphs) {
    for (const line of lines) {
      const p = doc.createElement('p');
      if (line) p.appendChild(doc.createTextNode(line));
      else p.appendChild(doc.createElement('br'));
      el.appendChild(p);
    }
  } else {
    lines.forEach((line, i) => {
      if (i > 0) el.appendChild(doc.createElement('br'));
      if (line) el.appendChild(doc.createTextNode(line));
    });
  }
  fireInput(el, 'insertReplacementText', text);
}

/** Corrections re-based onto the corrected text, so they can be undone. */
export function invertCorrections(corrections: readonly Correction[]): Correction[] {
  const ordered = [...corrections].sort((a, b) => a.start - b.start);
  let delta = 0;
  return ordered.map((c) => {
    const start = c.start + delta;
    const end = start + c.replacement.length;
    delta += c.replacement.length - (c.end - c.start);
    return { ...c, start, end, original: c.replacement, replacement: c.original };
  });
}

/**
 * Put a collapsed caret at flattened offset `offset` (clamped to the text).
 * Rewrites leave the caret after the last edit they made, which for
 * right-to-left corrections is the leftmost one: in live mode that dropped the
 * user's next keystrokes into the middle of their sentence.
 */
export function setCaret(doc: Document, el: HTMLElement, offset: number): void {
  if (isTextField(el)) {
    const pos = Math.max(0, Math.min(offset, el.value.length));
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // input types without selection support
    }
    return;
  }
  const sel = selectionFor(doc, el);
  if (!sel) return;
  const flat = flatten(el);
  const at = locate(flat, Math.max(0, Math.min(offset, flat.text.length)));
  const range = doc.createRange();
  if (at) range.setStart(at.node, at.offset);
  else range.selectNodeContents(el);
  range.collapse(at !== null);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The form's default button (HTML implicit submission): its first submit button in tree order. */
function defaultButton(form: HTMLFormElement): HTMLButtonElement | HTMLInputElement | null {
  for (const el of Array.from(form.elements)) {
    if (el.tagName === 'BUTTON' && (el as HTMLButtonElement).type === 'submit') return el as HTMLButtonElement;
    if (el.tagName === 'INPUT') {
      const type = (el as HTMLInputElement).type;
      if (type === 'submit' || type === 'image') return el as HTMLInputElement;
    }
  }
  return null;
}

/** Input types that block implicit submission (HTML: "a field that blocks implicit submission"). */
const BLOCKING_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number']);

/** How many of `form`'s fields block implicit submission. */
function blockingFieldCount(form: HTMLFormElement): number {
  let n = 0;
  for (const el of Array.from(form.elements)) {
    if (el.tagName === 'INPUT' && BLOCKING_INPUT_TYPES.has((el as HTMLInputElement).type)) n++;
  }
  return n;
}

/**
 * Carry out what a real Enter does in `el` when no handler cancelled it: a
 * script-dispatched keydown has no default action, so after the composer guard
 * swallowed the user's Enter and re-dispatched it, nothing else would.
 *
 * - single-line input: implicit submission (click the form's default button,
 *   or submit a form without one when this is its only text-like field);
 * - textarea: a newline replacing the selection;
 * - contenteditable: a new paragraph (a line break when the editor refuses).
 */
export function performEnterDefault(doc: Document, el: HTMLElement): void {
  if (isTextField(el)) {
    if (el.tagName === 'INPUT') {
      const form = (el as HTMLInputElement).form;
      if (!form) return;
      const button = defaultButton(form);
      if (button) {
        if (!button.disabled) button.click();
        return;
      }
      // Without a submit button a browser submits only a form whose single
      // text-like field this is; one with several (a login form driven by a
      // type="button") is never submitted by Enter.
      if (blockingFieldCount(form) > 1) return;
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return;
    }
    const field = el as HTMLTextAreaElement;
    let done = false;
    if (typeof doc.execCommand === 'function' && doc.activeElement === field) {
      try {
        const before = field.value;
        done = doc.execCommand('insertText', false, '\n') && field.value !== before;
      } catch {
        done = false;
      }
    }
    if (!done) {
      const start = field.selectionStart ?? field.value.length;
      const end = field.selectionEnd ?? start;
      field.setRangeText('\n', start, end, 'end');
      fireInput(field, 'insertLineBreak');
    }
    return;
  }
  if (typeof doc.execCommand === 'function') {
    try {
      if (doc.execCommand('insertParagraph', false) || doc.execCommand('insertLineBreak', false)) return;
    } catch {
      // fall through to the DOM splice
    }
  }
  const sel = selectionFor(doc, el);
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.getRangeAt(0).endContainer)) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const br = doc.createElement('br');
  range.insertNode(br);
  const after = doc.createRange();
  after.setStartAfter(br);
  after.collapse(true);
  sel.removeAllRanges();
  sel.addRange(after);
  fireInput(el, 'insertLineBreak');
}
