/// <reference types="chrome" />
/**
 * Content script for the server's pairing page (http://127.0.0.1:41733/pair,
 * opened by `lexicon serve --pair`). Reads the token, port and version the
 * page carries in <meta> tags, asks the background worker to pair, and
 * writes the outcome into `#status`. The token goes straight to the worker
 * over runtime messaging; it is never stored or logged here.
 *
 * `pairFromDocument` is pure (DOM + a send function) so tests/extension.test.ts
 * can drive it under jsdom; the auto-run at the bottom is the chrome wiring.
 */
import { sendToBackground } from './chrome-store.js';
import { errorMessage, PAIR_META } from './shared.js';
import type { Failure, PairReply, Request } from './shared.js';

export interface PairDeps {
  doc: Document;
  send: (req: Request) => Promise<PairReply | Failure>;
}

export interface PairOutcome {
  ok: boolean;
  /** What `#status` now says. */
  status: string;
}

function meta(doc: Document, name: string): string {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content?.trim() ?? '';
}

function setStatus(doc: Document, text: string, state: 'ok' | 'error' | 'busy'): void {
  const el = doc.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.className = state === 'busy' ? '' : state;
}

export async function pairFromDocument(deps: PairDeps): Promise<PairOutcome> {
  const { doc } = deps;
  // The extension is present, so the page's "install it" fallback is not needed.
  const install = doc.getElementById('install');
  if (install) install.hidden = true;

  const token = meta(doc, PAIR_META.token);
  const port = meta(doc, PAIR_META.port) || doc.location.port;
  if (!token || !/^\d+$/.test(port)) {
    const status = 'This page carries no pairing token; run `lexicon serve --pair` again.';
    setStatus(doc, status, 'error');
    return { ok: false, status };
  }
  const baseUrl = `http://${doc.location.hostname}:${port}`;
  setStatus(doc, 'Checking the token with lexicon serve...', 'busy');
  let reply: PairReply | Failure;
  try {
    reply = await deps.send({ type: 'pair', baseUrl, token });
  } catch (err) {
    reply = { ok: false, error: errorMessage(err) };
  }
  if (reply.ok) {
    const status = `Paired with lexicon serve (${reply.terms} term${reply.terms === 1 ? '' : 's'}). You can close this tab.`;
    setStatus(doc, status, 'ok');
    const heading = doc.querySelector('h1');
    if (heading) heading.textContent = 'Paired';
    return { ok: true, status };
  }
  const status = `Pairing failed: ${reply.error}`;
  setStatus(doc, status, 'error');
  return { ok: false, status };
}

declare global {
  interface Window {
    __lexiconPair?: boolean;
  }
}

// Auto-run only as a real content script (chrome.runtime.id is set there, not in tests).
if (typeof chrome !== 'undefined' && chrome.runtime?.id && !window.__lexiconPair && window === window.top) {
  window.__lexiconPair = true;
  void pairFromDocument({ doc: document, send: (req) => sendToBackground<PairReply | Failure>(req) });
}
