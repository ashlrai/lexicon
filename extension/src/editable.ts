/**
 * Read and rewrite text in a composer without breaking the editor behind it.
 *
 * Rich editors (ProseMirror on ChatGPT and Claude, Lexical on Perplexity,
 * Quill on Gemini) own their DOM. Replacing innerHTML desyncs their state,
 * so corrections are applied as ranged `insertText` edits, which every one
 * of them observes like a native IME or spellcheck replacement. Textareas
 * get the React-safe native value setter plus an `input` event.
 */
import { isTextField } from './adapters.js';
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

export function readText(el: HTMLElement): string {
  if (isTextField(el)) return el.value;
  return flatten(el).text;
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
export function caretOffset(doc: Document, el: HTMLElement): number {
  if (isTextField(el)) return el.selectionEnd ?? el.value.length;
  const flat = flatten(el);
  const sel = doc.getSelection?.();
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

/** Replace [start, end) in a text field; keeps the caret sensible. */
function replaceInField(el: HTMLTextAreaElement | HTMLInputElement, start: number, end: number, replacement: string): void {
  const value = el.value;
  const caretBefore = el.selectionEnd ?? value.length;
  const next = value.slice(0, start) + replacement + value.slice(end);
  let caret = caretBefore;
  if (caretBefore >= end) caret = caretBefore + (replacement.length - (end - start));
  else if (caretBefore > start) caret = start + replacement.length;
  setFieldValue(el, next, caret);
}

/**
 * Replace a flattened range inside a contenteditable. Tries execCommand
 * (native editing; rich editors observe it), then a DOM range splice.
 * Returns true when the flattened text afterwards contains the replacement
 * at `start`.
 */
function replaceInEditable(doc: Document, el: HTMLElement, start: number, end: number, replacement: string): boolean {
  const expectedPrefix = flatten(el).text.slice(0, start) + replacement;
  const verify = (): boolean => flatten(el).text.startsWith(expectedPrefix);

  const selectRange = (): Range | null => {
    const flat = flatten(el);
    const from = locate(flat, start, 'start');
    const to = locate(flat, end, 'end');
    if (!from || !to) return null;
    const range = doc.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    return range;
  };

  const win = doc.defaultView;
  const sel = doc.getSelection?.();
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
      if (ok && verify()) return true;
    }
  }

  const range = selectRange();
  if (!range) return false;
  range.deleteContents();
  range.insertNode(doc.createTextNode(replacement));
  if (sel) {
    // Leave the caret after the replacement.
    const flat = flatten(el);
    const after = locate(flat, start + replacement.length);
    if (after) {
      const r = doc.createRange();
      r.setStart(after.node, after.offset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  fireInput(el, 'insertReplacementText', replacement);
  return verify();
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
    for (const c of ordered) replaceInField(el, c.start, c.end, c.replacement);
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
  if (!ok || flatten(el).text !== expected) setWholeText(doc, el, expected);
  return flatten(el).text;
}

/** Last resort: replace everything. Keeps one paragraph per line for ProseMirror-style editors. */
export function setWholeText(doc: Document, el: HTMLElement, text: string): void {
  if (isTextField(el)) {
    setFieldValue(el, text);
    return;
  }
  const sel = doc.getSelection?.();
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
