/**
 * Bottom-right toast listing the corrections just applied, with an undo link.
 * Rendered inside a shadow root so the host page's CSS cannot restyle it and
 * ours cannot leak out.
 */
import { describeCorrection, TOAST_MS } from './shared.js';
import type { Correction, Mode } from './shared.js';

export const TOAST_ID = 'lexicon-toast';

export interface ToastOptions {
  onUndo?: () => void;
  durationMs?: number;
  mode?: Mode;
  /** Shown instead of the corrections list (errors). */
  message?: string;
}

const STYLE = `
:host { all: initial; }
.toast {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
  max-width: min(420px, calc(100vw - 32px));
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #f4f6f8; background: #14201f; border: 1px solid #0f766e;
  border-radius: 10px; padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.35);
  display: flex; flex-direction: column; gap: 6px;
}
.title { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-weight: 600; }
.badge { font-size: 11px; font-weight: 500; color: #9fd8cf; }
ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
li { display: flex; gap: 6px; align-items: baseline; }
.from { color: #c0c8cf; text-decoration: line-through; }
.arrow { color: #7f8a94; }
.to { color: #fff; font-weight: 600; }
.reason { color: #7f8a94; font-size: 11px; }
.row { display: flex; gap: 12px; justify-content: flex-end; }
button {
  all: unset; cursor: pointer; color: #9fd8cf; font: inherit; font-weight: 600;
  padding: 2px 4px; border-radius: 4px;
}
button:hover, button:focus-visible { background: rgba(159, 216, 207, .15); outline: none; }
.msg { color: #ffd9a8; }
`;

export function showToast(doc: Document, corrections: readonly Correction[], opts: ToastOptions = {}): HTMLElement {
  removeToast(doc);
  const host = doc.createElement('div');
  host.id = TOAST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);

  const box = doc.createElement('div');
  box.className = 'toast';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');

  const title = doc.createElement('div');
  title.className = 'title';
  const heading = doc.createElement('span');
  heading.textContent = opts.message ? 'Lexicon' : `Lexicon fixed ${corrections.length} ${corrections.length === 1 ? 'word' : 'words'}`;
  title.appendChild(heading);
  if (opts.mode) {
    const badge = doc.createElement('span');
    badge.className = 'badge';
    badge.textContent = opts.mode === 'api' ? 'local API' : 'embedded';
    title.appendChild(badge);
  }
  box.appendChild(title);

  if (opts.message) {
    const msg = doc.createElement('div');
    msg.className = 'msg';
    msg.textContent = opts.message;
    box.appendChild(msg);
  } else {
    const list = doc.createElement('ul');
    for (const c of corrections) {
      const li = doc.createElement('li');
      li.setAttribute('aria-label', describeCorrection(c));
      const from = doc.createElement('span');
      from.className = 'from';
      from.textContent = c.original;
      const arrow = doc.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '→';
      const to = doc.createElement('span');
      to.className = 'to';
      to.textContent = c.replacement;
      const reason = doc.createElement('span');
      reason.className = 'reason';
      reason.textContent = c.reason === 'alias' ? '' : `${c.reason} ${c.confidence.toFixed(2)}`;
      li.append(from, arrow, to, reason);
      list.appendChild(li);
    }
    box.appendChild(list);
  }

  const row = doc.createElement('div');
  row.className = 'row';
  if (opts.onUndo) {
    const undo = doc.createElement('button');
    undo.type = 'button';
    undo.className = 'undo';
    undo.textContent = 'Undo';
    undo.title = 'Put the original wording back in the box';
    undo.addEventListener('click', () => {
      opts.onUndo?.();
      removeToast(doc);
    });
    row.appendChild(undo);
  }
  const close = doc.createElement('button');
  close.type = 'button';
  close.className = 'close';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => removeToast(doc));
  row.appendChild(close);
  box.appendChild(row);

  root.appendChild(box);
  (doc.body ?? doc.documentElement).appendChild(host);

  const duration = opts.durationMs ?? TOAST_MS;
  let timer = doc.defaultView?.setTimeout(() => removeToast(doc), duration);
  box.addEventListener('mouseenter', () => {
    if (timer !== undefined) doc.defaultView?.clearTimeout(timer);
    timer = undefined;
  });
  box.addEventListener('mouseleave', () => {
    timer = doc.defaultView?.setTimeout(() => removeToast(doc), duration);
  });
  return host;
}

export function removeToast(doc: Document): void {
  doc.getElementById(TOAST_ID)?.remove();
}
