// @vitest-environment jsdom
/**
 * Browser extension: how a correction is written into a composer (undo
 * history, shadow-root selections, large composers) and when Enter is
 * swallowed on a known site.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCorrections } from '../extension/src/editable.js';
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
