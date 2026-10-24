// @vitest-environment jsdom
/**
 * Browser extension: how a correction is written into a composer (undo
 * history, shadow-root selections, large composers) and when Enter is
 * swallowed on a known site.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCorrections, caretOffset, setCaret } from '../extension/src/editable.js';
import { holdsCode } from '../extension/src/adapters.js';
import { createEmbedded } from '../extension/src/embedded.js';

const EXAMPLE_YAML = readFileSync(resolve(process.cwd(), 'examples/lexicon.example.yaml'), 'utf8');
const engine = createEmbedded(EXAMPLE_YAML);

/** Counts assignments through the textarea `value` setter (what drops the native undo history). */
function countValueSets(): { count(): number; restore(): void } {
  const proto = HTMLTextAreaElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')!;
  let n = 0;
  Object.defineProperty(proto, 'value', {
    configurable: true,
    get: desc.get,
    set(v: string) {
      n++;
      desc.set!.call(this, v);
    },
  });
  return { count: () => n, restore: () => Object.defineProperty(proto, 'value', desc) };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (document as { execCommand?: unknown }).execCommand;
});

describe('editable: a textarea correction keeps the undo history', () => {
  it('uses insertText on a focused textarea, so Ctrl+Z undoes it', async () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const t = document.getElementById('t') as HTMLTextAreaElement;
    t.value = 'ping ashler and ashlar now';
    t.focus();
    const calls: string[] = [];
    // The browser's insertText: replaces the selection, fires input, goes on the undo stack.
    (document as { execCommand?: unknown }).execCommand = (cmd: string, _ui: boolean, text?: string): boolean => {
      calls.push(`${cmd}:${text ?? ''}`);
      t.setRangeText(text ?? '', t.selectionStart ?? 0, t.selectionEnd ?? 0, 'end');
      t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      return true;
    };
    const sets = countValueSets();
    try {
      const r = engine.normalize(t.value);
      expect(await applyCorrections(document, t, r.replacements, r.output)).toBe('ping Ashlr.AI and Ashlr.AI now');
      expect(calls).toEqual(['insertText:Ashlr.AI', 'insertText:Ashlr.AI']);
      expect(sets.count()).toBe(0);
    } finally {
      sets.restore();
    }
  });

  it('falls back to setRangeText, not the value setter, when insertText is unavailable or the field is not focused', async () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const t = document.getElementById('t') as HTMLTextAreaElement;
    t.value = 'ping ashler now';
    const seen: string[] = [];
    t.addEventListener('input', () => seen.push(t.value));
    const sets = countValueSets();
    try {
      const r = engine.normalize(t.value);
      expect(await applyCorrections(document, t, r.replacements, r.output)).toBe('ping Ashlr.AI now');
      expect(seen).toEqual(['ping Ashlr.AI now']);
      expect(sets.count()).toBe(0);
    } finally {
      sets.restore();
    }
  });

  it('still lands the text through the value setter when an editing command misfires', async () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const t = document.getElementById('t') as HTMLTextAreaElement;
    t.value = 'ping ashler now';
    t.focus();
    (document as { execCommand?: unknown }).execCommand = (): boolean => {
      t.setRangeText('garbled', 0, 0, 'end');
      return true;
    };
    const r = engine.normalize(t.value);
    expect(await applyCorrections(document, t, r.replacements, r.output)).toBe('ping Ashlr.AI now');
  });
});

describe('editable: the caret inside an open shadow root', () => {
  /** A composer in a shadow root whose own selection (Chromium's ShadowRoot.getSelection) holds `range`, while the document's is retargeted to the host. */
  function shadowComposer(html: string): { host: HTMLElement; root: ShadowRoot; editor: HTMLElement; ranges: Range[] } {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = html;
    const editor = root.querySelector('[contenteditable]') as HTMLElement;
    const ranges: Range[] = [];
    const sel = {
      get rangeCount() {
        return ranges.length;
      },
      get anchorNode() {
        return ranges[0]?.startContainer ?? null;
      },
      getRangeAt: (i: number) => ranges[i],
      removeAllRanges: () => {
        ranges.length = 0;
      },
      addRange: (r: Range) => {
        ranges.push(r);
      },
    };
    (root as unknown as { getSelection(): unknown }).getSelection = () => sel;
    // What document.getSelection() reports for a caret in a shadow tree: a point beside the host.
    const outer = document.createRange();
    outer.setStart(document.body, Array.from(document.body.childNodes).indexOf(host));
    outer.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(outer);
    return { host, root, editor, ranges };
  }

  it('caretOffset reads the shadow root\'s selection, not the host-level document one', () => {
    const { editor, ranges } = shadowComposer('<div contenteditable="true">ping ashler and more</div>');
    const r = document.createRange();
    r.setStart(editor.firstChild!, 11);
    r.collapse(true);
    ranges.push(r);
    expect(caretOffset(document, editor)).toBe(11);
  });

  it('setCaret puts the caret in the shadow root\'s selection', () => {
    const { editor, ranges } = shadowComposer('<div contenteditable="true">ping ashler and more</div>');
    setCaret(document, editor, 4);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].startContainer).toBe(editor.firstChild);
    expect(ranges[0].startOffset).toBe(4);
  });

  it('holdsCode sees a caret inside code in a shadow-root composer', () => {
    const { editor, ranges } = shadowComposer('<div contenteditable="true">run <code>npm ci</code> now</div>');
    const code = editor.querySelector('code')!;
    const r = document.createRange();
    r.setStart(code.firstChild!, 2);
    r.collapse(true);
    ranges.push(r);
    expect(holdsCode(document, editor)).toBe(true);
  });
});
