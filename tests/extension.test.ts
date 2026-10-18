// @vitest-environment jsdom
/**
 * Browser extension: adapters, composer rewrite, Enter/click interception,
 * toast, embedded engine, and content <-> background message routing with a
 * mocked chrome.runtime. Pure DOM under jsdom; no real browser needed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADAPTERS, GENERIC, adapterFor, composerFromTarget, findComposer, findSendButton } from '../extension/src/adapters.js';
import { createBackground } from '../extension/src/background-core.js';
import { conflictNote } from '../src/core/index.js';
import type { KeyValueStore } from '../extension/src/background-core.js';
import { sendToBackground } from '../extension/src/chrome-store.js';
import { installContent } from '../extension/src/content-core.js';
import type { ContentHandle } from '../extension/src/content-core.js';
import { applyCorrections, flatten, invertCorrections, readText } from '../extension/src/editable.js';
import { createEmbedded, learnIntoYaml } from '../extension/src/embedded.js';
import { pairFromDocument } from '../extension/src/pair.js';
import { coerceSettings, connectionTestLine, countOf, hostKey, pairUrl, pairableBaseUrl, siteEnabled, statusView, syncedLine, PAIR_META } from '../extension/src/shared.js';
import type { Correction, Failure, LearnReply, NormalizeReply, PairReply, Request, StatusReply } from '../extension/src/shared.js';
import { TOAST_ID, showToast } from '../extension/src/toast.js';
import { setMessage } from '../extension/src/rich-text.js';

// import.meta.url is an http: URL under the jsdom environment; resolve from the repo root instead.
const EXAMPLE_YAML = readFileSync(resolve(process.cwd(), 'examples/lexicon.example.yaml'), 'utf8');
const engine = createEmbedded(EXAMPLE_YAML);

/** A fake background: the embedded engine over the example lexicon. */
function fakeSend(req: Request): Promise<NormalizeReply> {
  if (req.type !== 'normalize') throw new Error(`unexpected ${req.type}`);
  const r = engine.normalize(req.text, req.dryRun);
  return Promise.resolve({ ok: true, input: r.input, output: r.output, changed: r.changed, replacements: r.replacements, mode: 'embedded' });
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function toastText(): string {
  const host = document.getElementById(TOAST_ID);
  return host?.shadowRoot?.textContent ?? '';
}

let handle: ContentHandle | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  document.getElementById(TOAST_ID)?.remove();
});

// ---------------------------------------------------------------------------

describe('adapters', () => {
  it('maps hosts to adapters and falls back to generic', () => {
    expect(adapterFor('chatgpt.com').id).toBe('chatgpt');
    expect(adapterFor('chat.openai.com').id).toBe('chatgpt');
    expect(adapterFor('www.perplexity.ai').id).toBe('perplexity');
    expect(adapterFor('gemini.google.com').id).toBe('gemini');
    expect(adapterFor('example.org').id).toBe(GENERIC.id);
    expect(hostKey('WWW.Perplexity.ai')).toBe('perplexity.ai');
    expect(ADAPTERS.every((a) => a.hosts.length > 0)).toBe(true);
  });

  it('finds a textarea composer and its send button (Grok layout)', () => {
    document.body.innerHTML =
      '<form><textarea placeholder="Ask Grok anything"></textarea><button type="submit" data-testid="chat-submit" aria-label="Submit">Go</button></form>';
    const adapter = adapterFor('grok.com');
    const composer = findComposer(document, adapter);
    expect(composer?.tagName).toBe('TEXTAREA');
    const button = findSendButton(document, adapter, composer);
    expect(button?.getAttribute('data-testid')).toBe('chat-submit');
  });

  it('finds a contenteditable composer (ChatGPT ProseMirror layout)', () => {
    document.body.innerHTML =
      '<div contenteditable="true" class="other"></div>' +
      '<div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p>hi</p></div>' +
      '<button data-testid="send-button" aria-label="Send prompt"></button>';
    const adapter = adapterFor('chatgpt.com');
    const composer = findComposer(document, adapter);
    expect(composer?.id).toBe('prompt-textarea');
    expect(findSendButton(document, adapter, composer)?.getAttribute('data-testid')).toBe('send-button');
    // The other editable is not the composer.
    const other = document.querySelector('.other')!;
    expect(composerFromTarget(other, adapter)).toBeNull();
    expect(composerFromTarget(composer!.firstChild!.firstChild, adapter)).toBe(composer);
  });

  it('generic adapter uses the focused editable', () => {
    document.body.innerHTML = '<textarea id="a"></textarea><div id="b" contenteditable="true"></div>';
    (document.getElementById('b') as HTMLElement).focus();
    expect(findComposer(document, GENERIC)?.id).toBe('b');
    (document.getElementById('a') as HTMLElement).focus();
    expect(findComposer(document, GENERIC)?.id).toBe('a');
  });
});

// ---------------------------------------------------------------------------

describe('editable', () => {
  it('flattens paragraphs and ignores ProseMirror trailing breaks', () => {
    document.body.innerHTML =
      '<div id="e" contenteditable="true"><p>one <strong>two</strong></p><p><br class="ProseMirror-trailingBreak"></p><p>three<br>four</p></div>';
    expect(flatten(document.getElementById('e')!).text).toBe('one two\n\nthree\nfour');
  });

  it('rewrites a textarea through the native setter and fires input', async () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const t = document.getElementById('t') as HTMLTextAreaElement;
    t.value = 'ping ashler now';
    const seen: string[] = [];
    t.addEventListener('input', () => seen.push(t.value));
    const r = engine.normalize('ping ashler now');
    expect(await applyCorrections(document, t, r.replacements, r.output)).toBe('ping Ashlr.AI now');
    expect(seen).toEqual(['ping Ashlr.AI now']);
  });

  it('rewrites a contenteditable in place, keeping the surrounding markup', async () => {
    document.body.innerHTML = '<div id="e" contenteditable="true"><p>ping <em>ashler</em> and cooper netties</p></div>';
    const e = document.getElementById('e')!;
    const text = readText(e);
    const r = engine.normalize(text);
    expect(await applyCorrections(document, e, r.replacements, r.output)).toBe(r.output);
    expect(r.output).toBe('ping Ashlr.AI and Kubernetes');
    expect(e.querySelector('em')?.textContent).toBe('Ashlr.AI');
  });

  it('inverts corrections so undo restores the original', () => {
    const text = 'ashler ships sass on head sner';
    const r = engine.normalize(text);
    const inv = invertCorrections(r.replacements);
    let back = r.output;
    for (const c of [...inv].sort((a, b) => b.start - a.start)) {
      back = back.slice(0, c.start) + c.replacement + back.slice(c.end);
    }
    expect(back).toBe(text);
  });
});

// ---------------------------------------------------------------------------

describe('content: send interception', () => {
  function chatgptDom(text: string): { composer: HTMLElement; button: HTMLButtonElement } {
    document.body.innerHTML =
      `<div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p>${text}</p></div>` +
      '<button data-testid="send-button" aria-label="Send prompt">send</button>';
    return {
      composer: document.getElementById('prompt-textarea')!,
      button: document.querySelector('button')!,
    };
  }

  it('intercepts Enter, rewrites the composer, shows the toast, then re-dispatches Enter', async () => {
    const { composer } = chatgptDom('ping ashler');
    const send = vi.fn(fakeSend);
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send, settings: { enabled: true, live: false } });

    const siteEnter = vi.fn((ev: KeyboardEvent) => {
      // What the site would do: read the composer and submit.
      expect(readText(composer)).toBe('ping Ashlr.AI');
      ev.preventDefault();
    });
    composer.addEventListener('keydown', siteEnter);

    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
    composer.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(siteEnter).not.toHaveBeenCalled();

    await handle.idle();
    expect(send).toHaveBeenCalledWith({ type: 'normalize', text: 'ping ashler', dryRun: false });
    expect(readText(composer)).toBe('ping Ashlr.AI');
    expect(siteEnter).toHaveBeenCalledTimes(1);
    expect(toastText()).toContain('ashler');
    expect(toastText()).toContain('Ashlr.AI');
  });

  it('lets Shift+Enter (newline) through', () => {
    const { composer } = chatgptDom('ashler');
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    const ev = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true });
    composer.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('passes unchanged text through without rewriting and still sends', async () => {
    const { composer } = chatgptDom('hello world');
    const send = vi.fn(fakeSend);
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send, settings: { enabled: true, live: false } });
    const siteEnter = vi.fn((ev: KeyboardEvent) => ev.preventDefault());
    composer.addEventListener('keydown', siteEnter);

    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(readText(composer)).toBe('hello world');
    expect(composer.innerHTML).toBe('<p>hello world</p>');
    expect(siteEnter).toHaveBeenCalledTimes(1);
    expect(document.getElementById(TOAST_ID)).toBeNull();
  });

  it('after a precheck says "unchanged", Enter is not intercepted at all (zero delay)', async () => {
    const { composer } = chatgptDom('hello world');
    const send = vi.fn(fakeSend);
    handle = installContent({
      doc: document,
      hostname: 'chatgpt.com',
      send,
      settings: { enabled: true, live: false },
      precheckDebounceMs: 5,
    });
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(30);
    expect(send).toHaveBeenCalledWith({ type: 'normalize', text: 'hello world', dryRun: true });

    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    composer.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    await handle.idle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('intercepts a send-button click, rewrites, then re-clicks', async () => {
    const { composer, button } = chatgptDom('deploy on head sner');
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    const siteClick = vi.fn(() => {
      expect(readText(composer)).toBe('deploy on Hetzner');
    });
    button.addEventListener('click', siteClick);

    button.click();
    expect(siteClick).not.toHaveBeenCalled();
    await handle.idle();
    expect(siteClick).toHaveBeenCalledTimes(1);
    expect(readText(composer)).toBe('deploy on Hetzner');
  });

  it('does nothing when the site is switched off', async () => {
    const { composer } = chatgptDom('ping ashler');
    const send = vi.fn(fakeSend);
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send, settings: { enabled: false, live: false } });
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    composer.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    await handle.idle();
    expect(send).not.toHaveBeenCalled();
    expect(readText(composer)).toBe('ping ashler');
  });

  it('undo from the toast puts the original wording back', async () => {
    const { composer } = chatgptDom('ping ashler');
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    composer.addEventListener('keydown', (ev) => ev.preventDefault());
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(readText(composer)).toBe('ping Ashlr.AI');
    const undo = document.getElementById(TOAST_ID)!.shadowRoot!.querySelector<HTMLButtonElement>('button.undo')!;
    undo.click();
    expect(readText(composer)).toBe('ping ashler');
    expect(document.getElementById(TOAST_ID)).toBeNull();
  });

  it('live mode corrects text before the caret on an idle debounce (textarea)', async () => {
    document.body.innerHTML = '<form><textarea placeholder="Ask Grok anything"></textarea></form>';
    const t = document.querySelector('textarea')!;
    handle = installContent({
      doc: document,
      hostname: 'grok.com',
      send: vi.fn(fakeSend),
      settings: { enabled: true, live: true },
      liveDebounceMs: 5,
      precheckDebounceMs: 5,
    });
    t.value = 'ping ashler and ashler';
    t.setSelectionRange(11, 11); // right after the first "ashler"
    t.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(40);
    expect(t.value).toBe('ping Ashlr.AI and ashler');
    expect(t.selectionEnd).toBe('ping Ashlr.AI'.length);
  });
});

describe('content: matching that stopped early', () => {
  const incomplete = { reasons: ['time' as const], totalChars: 40, note: 'Matching stopped at the 25 ms budget; ...' };
  function stoppedSend(req: Request): Promise<NormalizeReply> {
    return fakeSend(req).then((r) => (r.ok ? { ...r, incomplete } : r));
  }
  function chatgptDom(text: string): HTMLElement {
    document.body.innerHTML =
      `<div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p>${text}</p></div>` +
      '<button data-testid="send-button" aria-label="Send prompt">send</button>';
    return document.getElementById('prompt-textarea')!;
  }

  it('says so in the toast next to the corrections', async () => {
    const composer = chatgptDom('ping ashler');
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send: vi.fn(stoppedSend), settings: { enabled: true, live: false } });
    composer.addEventListener('keydown', (ev) => ev.preventDefault());
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(readText(composer)).toBe('ping Ashlr.AI');
    expect(toastText()).toContain('Ashlr.AI');
    expect(toastText()).toMatch(/stopped early/i);
  });

  it('shows a notice even when nothing was corrected, and a precheck does not hide it', async () => {
    const composer = chatgptDom('hello world');
    const send = vi.fn(stoppedSend);
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send, settings: { enabled: true, live: false }, precheckDebounceMs: 5 });
    const siteEnter = vi.fn((ev: KeyboardEvent) => ev.preventDefault());
    composer.addEventListener('keydown', siteEnter);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(30);
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(siteEnter).toHaveBeenCalledTimes(1);
    expect(readText(composer)).toBe('hello world');
    expect(toastText()).toMatch(/stopped early/i);
    expect(document.getElementById(TOAST_ID)!.shadowRoot!.querySelector('button.undo')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('toast', () => {
  it('renders the corrections and an undo link', () => {
    const corrections: Correction[] = [
      { start: 0, end: 6, original: 'Ashler', replacement: 'Ashlr.AI', canonical: 'Ashlr.AI', reason: 'alias', confidence: 1 },
      { start: 10, end: 24, original: 'cooper netties', replacement: 'Kubernetes', canonical: 'Kubernetes', reason: 'phonetic', confidence: 0.9 },
    ];
    const onUndo = vi.fn();
    showToast(document, corrections, { onUndo, mode: 'api', durationMs: 60_000 });
    const text = toastText();
    expect(text).toContain('fixed 2 words');
    expect(text).toContain('Ashler');
    expect(text).toContain('Ashlr.AI');
    expect(text).toContain('Kubernetes');
    expect(text).toContain('phonetic 0.90');
    expect(text).toContain('local API');
    document.getElementById(TOAST_ID)!.shadowRoot!.querySelector<HTMLButtonElement>('button.undo')!.click();
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(document.getElementById(TOAST_ID)).toBeNull();
  });

  // Catches: the toast showed nothing of why the local API was skipped, and a
  // reason built for textContent would have shown its backticks literally.
  it('shows the fallback reason with commands as <code>, never as markup', () => {
    const corrections: Correction[] = [
      { start: 0, end: 6, original: 'ashler', replacement: 'Ashlr.AI', canonical: 'Ashlr.AI', reason: 'alias', confidence: 1 },
    ];
    showToast(document, corrections, {
      mode: 'embedded',
      durationMs: 60_000,
      fallback: 'No API token set: run `lexicon serve --pair` to pair this browser <img src=x onerror=alert(1)>',
    });
    const root = document.getElementById(TOAST_ID)!.shadowRoot!;
    const line = root.querySelector<HTMLElement>('.fallback')!;
    expect(line.textContent).toBe('Local API not used: No API token set: run lexicon serve --pair to pair this browser <img src=x onerror=alert(1)>');
    expect(line.textContent).not.toContain('`');
    expect([...line.querySelectorAll('code')].map((c) => c.textContent)).toEqual(['lexicon serve --pair']);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('.badge')!.textContent).toBe('embedded (fallback)');
    // The code style lives in the shadow root, so the host page's own <code> is untouched.
    expect(root.querySelector('style')!.textContent).toMatch(/\ncode \{/);
    expect(document.head.querySelector('style')).toBeNull();
  });

  it('carries the fallback reason from a corrected send into the toast', async () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"><p>ping ashler</p></div>';
    const composer = document.getElementById('prompt-textarea')!;
    const send = vi.fn(async (req: Request): Promise<NormalizeReply> => {
      const reply = await fakeSend(req);
      return reply.ok ? { ...reply, fallback: 'cannot reach lexicon serve at http://127.0.0.1:41733; start it with `lexicon serve`' } : reply;
    });
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send, settings: { enabled: true, live: false } });
    composer.addEventListener('keydown', (ev) => ev.preventDefault());
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    const line = document.getElementById(TOAST_ID)!.shadowRoot!.querySelector<HTMLElement>('.fallback')!;
    expect(line.textContent).toBe('Local API not used: cannot reach lexicon serve at http://127.0.0.1:41733; start it with lexicon serve');
    expect(line.querySelector('code')!.textContent).toBe('lexicon serve');
  });
});

// ---------------------------------------------------------------------------

describe('embedded engine', () => {
  it('normalizes "ping ashler" with the example lexicon', () => {
    expect(engine.normalize('ping ashler').output).toBe('ping Ashlr.AI');
    expect(engine.termCount()).toBeGreaterThan(5);
    expect(engine.error()).toBeNull();
  });

  it('reports YAML errors instead of throwing', () => {
    const e = createEmbedded('version: 1\nterms: [ { canonical: "" } ]\n');
    expect(e.error()).toMatch(/canonical/);
    expect(e.normalize('ping ashler').output).toBe('ping ashler');
  });

  it('learns into the YAML: alias of an existing term, or a new learned term', () => {
    const a = learnIntoYaml(EXAMPLE_YAML, 'Ashlur', 'ashlr.ai');
    expect(a.message).toMatch(/alias of Ashlr.AI/);
    expect(createEmbedded(a.yaml).normalize('call ashlur').output).toBe('call Ashlr.AI');
    // Comments survive the round trip.
    expect(a.yaml).toContain('# Lexicon: personal vocabulary');

    const b = learnIntoYaml(a.yaml, 'entire dot io', 'Entire.io');
    expect(b.message).toMatch(/new term Entire.io/);
    expect(b.yaml).toContain('source: learned');
    expect(createEmbedded(b.yaml).normalize('open entire dot io').output).toBe('open Entire.io');

    expect(learnIntoYaml(b.yaml, 'Ashlur', 'Ashlr.AI').message).toMatch(/already an alias/);
    expect(() => learnIntoYaml(b.yaml, '', 'x')).toThrow(/required/);
  });
});

// ---------------------------------------------------------------------------

describe('settings', () => {
  it('pairableBaseUrl accepts loopback http origins only; pairUrl appends /pair', () => {
    expect(pairableBaseUrl('http://127.0.0.1:41733')).toBe('http://127.0.0.1:41733');
    expect(pairableBaseUrl('http://localhost:41733/')).toBe('http://localhost:41733');
    expect(pairableBaseUrl('http://127.0.0.1:41733/pair')).toBeUndefined();
    expect(pairableBaseUrl('http://127.0.0.1:41733?x=1')).toBeUndefined();
    expect(pairableBaseUrl('http://evil.example:41733')).toBeUndefined();
    expect(pairableBaseUrl('https://127.0.0.1:41733')).toBeUndefined();
    expect(pairableBaseUrl('http://127.0.0.1')).toBeUndefined();
    expect(pairableBaseUrl('http://user:pw@127.0.0.1:41733')).toBeUndefined();
    expect(pairableBaseUrl('nope')).toBeUndefined();
    expect(pairUrl('http://127.0.0.1:41733/')).toBe('http://127.0.0.1:41733/pair');
  });

  it('coerces stored settings and honours per-site switches', () => {
    const s = coerceSettings({ baseUrl: 'http://127.0.0.1:41733/', mode: 'weird', sites: { 'chatgpt.com': false } }, 'yaml');
    expect(s.baseUrl).toBe('http://127.0.0.1:41733');
    expect(s.mode).toBe('api');
    expect(s.yaml).toBe('yaml');
    expect(siteEnabled(s, 'chatgpt.com')).toBe(false);
    expect(siteEnabled(s, 'www.perplexity.ai')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('message routing (mock chrome.runtime) and background', () => {
  type Listener = (msg: unknown, sender: { id: string }, sendResponse: (r: unknown) => void) => boolean | void;

  function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore & { data: Record<string, unknown> } {
    const data = { ...initial };
    return {
      data,
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
      set: async (items) => {
        Object.assign(data, items);
      },
    };
  }

  function mockChrome(): { listeners: Listener[] } {
    const listeners: Listener[] = [];
    const runtime = {
      id: 'ext-test',
      lastError: undefined as { message?: string } | undefined,
      onMessage: { addListener: (l: Listener) => listeners.push(l) },
      sendMessage: (msg: unknown, cb: (r: unknown) => void) => {
        for (const l of listeners) l(msg, { id: 'ext-test' }, cb);
      },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime };
    return { listeners };
  }

  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('routes a content-script normalize through the background and falls back to embedded when /health fails', async () => {
    mockChrome();
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const store = memoryStore();
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });
    chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      void bg.handle(msg as Request).then(sendResponse);
      return true;
    });

    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"><p>ping ashler</p></div>';
    const composer = document.getElementById('prompt-textarea')!;
    composer.addEventListener('keydown', (ev) => ev.preventDefault());
    handle = installContent({
      doc: document,
      hostname: 'chatgpt.com',
      send: (req) => sendToBackground<NormalizeReply>(req),
      settings: { enabled: true, live: false },
    });
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(readText(composer)).toBe('ping Ashlr.AI');
    expect(toastText()).toContain('embedded');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:41733/health', expect.anything());

    const status = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(status.activeMode).toBe('embedded');
    expect(status.server).toBeNull();
    expect(status.recent[0]).toMatchObject({ original: 'ashler', replacement: 'Ashlr.AI' });
  });

  // Catches: a refused connection reached the popup, Test connection and
  // Sync as the bare "Failed to fetch", with no word of where or what to run.
  it('a server that is not running is named with the URL and the command that starts it', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token: 'a'.repeat(64) } }), defaultYaml: EXAMPLE_YAML });
    const expected = 'cannot reach lexicon serve at http://127.0.0.1:41733; start it with `lexicon serve` (or `lexicon serve --install` to start it at login)';
    const status = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(status.serverError).toBe(expected);
    expect(await bg.handle({ type: 'sync' })).toEqual({ ok: false, error: expected });
    const reply = (await bg.handle({ type: 'normalize', text: 'ping ashler' })) as NormalizeReply;
    expect(reply.ok && reply.fallback).toBe(expected);
  });

  // Catches: with the server stopped, Learn wrote the embedded YAML and said
  // only "(embedded)", although the next Sync from local API replaces that
  // YAML and drops the word; the server-up fallbacks already said so.
  it('learn with the server stopped says the word went to the embedded lexicon only and how to start the server', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const store = memoryStore({ settings: { token: 'a'.repeat(64) } });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });
    const learn = (await bg.handle({ type: 'learn', heard: 'quorbix', meant: 'Quorbyx' })) as LearnReply;
    expect(learn).toMatchObject({ ok: true, mode: 'embedded' });
    expect(learn.message).toContain(
      "Saved to the embedded lexicon only, not the server's: cannot reach lexicon serve at http://127.0.0.1:41733; start it with `lexicon serve` (or `lexicon serve --install` to start it at login). A later Sync from local API replaces the embedded lexicon, so learn it again once the server is running.",
    );
    expect(await bg.handle({ type: 'normalize', text: 'ping quorbix' })).toMatchObject({ ok: true, mode: 'embedded', output: 'ping Quorbyx' });
    // The Embedded mode never meant to use the server: nothing to warn about.
    const embedded = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { mode: 'embedded' } }), defaultYaml: EXAMPLE_YAML });
    const quiet = (await embedded.handle({ type: 'learn', heard: 'quorbix', meant: 'Quorbyx' })) as LearnReply;
    expect(quiet).toMatchObject({ ok: true, mode: 'embedded' });
    expect(quiet.message).not.toContain('embedded lexicon only');
  });

  // Catches: with no token stored, learn and sync said only to paste the
  // `lexicon serve --show` token, never `lexicon serve --pair`, the one-step fix.
  it('a missing token names lexicon serve --pair first, then the manual paste', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: '1', terms: 1 }) }) as unknown as Response);
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore(), defaultYaml: EXAMPLE_YAML });
    const expected = 'No API token set: run `lexicon serve --pair` to pair this browser, or paste the token `lexicon serve --show` prints into Options.';
    const learn = (await bg.handle({ type: 'learn', heard: 'Ashlur', meant: 'Ashlr.AI' })) as LearnReply;
    expect(learn.message).toContain(expected);
    expect(await bg.handle({ type: 'sync' })).toEqual({ ok: false, error: expected });
  });

  // Catches: with the server up but no token (or a rejected one), Normalize
  // fell back to the embedded YAML while Learn failed outright, so the word the
  // popup said it could not learn was also never in the copy every send used.
  it('learn falls back to the embedded YAML exactly when normalize does, and says the server did not get it', async () => {
    const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    let learnStatus = 401;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return json({ ok: true, version: '1', terms: 1 });
      if (url.endsWith('/learn')) return json({ error: 'unauthorized' }, learnStatus);
      return json({ error: 'unauthorized' }, 401);
    });
    for (const token of ['', 'stale-token']) {
      learnStatus = 401;
      const store = memoryStore({ settings: { token } });
      const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });
      expect(await bg.handle({ type: 'normalize', text: 'ping quorbix' })).toMatchObject({ ok: true, mode: 'embedded', output: 'ping quorbix' });
      const learn = (await bg.handle({ type: 'learn', heard: 'quorbix', meant: 'Quorbyx' })) as LearnReply;
      expect(learn).toMatchObject({ ok: true, mode: 'embedded' });
      expect(learn.message).toContain("Saved to the embedded lexicon only, not the server's:");
      expect(learn.message).toContain(token ? 'rejected the token' : 'No API token set');
      expect(learn.message).toContain('Sync from local API replaces');
      expect(await bg.handle({ type: 'normalize', text: 'ping quorbix' })).toMatchObject({ ok: true, mode: 'embedded', output: 'ping Quorbyx' });
      // A server that refuses the correction itself is not overridden by the embedded copy.
      learnStatus = 400;
      if (token) expect(await bg.handle({ type: 'learn', heard: 'Hetznr', meant: 'Hetzner' })).toMatchObject({ ok: false });
    }
  });

  it('uses the local API with the bearer token when /health is ok, and learn/sync hit the right routes', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const json = (body: unknown, status = 200): Response =>
      ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/health')) return json({ ok: true, version: '9.9.9', terms: 3 });
      if (url.endsWith('/normalize')) {
        const { text } = JSON.parse(String(init.body)) as { text: string };
        return json({
          input: text,
          output: text.replace('ashler', 'Ashlr.AI'),
          changed: text.includes('ashler'),
          replacements: text.includes('ashler')
            ? [{ start: 5, end: 11, original: 'ashler', replacement: 'Ashlr.AI', canonical: 'Ashlr.AI', reason: 'alias', confidence: 1 }]
            : [],
          summary: '',
          ...(text.includes('long') ? { incomplete: { reasons: ['time'], totalChars: text.length, note: 'Matching stopped at the 1000 ms budget.' } } : {}),
        });
      }
      if (url.endsWith('/learn')) return json({ term: { canonical: 'Ashlr.AI', aliases: ['Ashlur'] }, created: false, aliasAdded: true, path: '/tmp/lexicon.yaml' });
      if (url.endsWith('/lexicon')) return json({ lexicon: { version: 1, terms: [{ canonical: 'Entire.io', aliases: ['entire dot io'] }] } });
      return json({ error: 'nope' }, 404);
    });
    const store = memoryStore({ settings: { token: 'secret-token' } });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });

    const reply = (await bg.handle({ type: 'normalize', text: 'ping ashler' })) as NormalizeReply;
    expect(reply.ok && reply.mode).toBe('api');
    expect(reply.ok && reply.output).toBe('ping Ashlr.AI');
    expect(reply.ok && reply.incomplete).toBeUndefined();
    // The server's budget signal reaches the content script.
    const cut = (await bg.handle({ type: 'normalize', text: 'ping ashler long' })) as NormalizeReply;
    expect(cut.ok && cut.incomplete).toMatchObject({ reasons: ['time'], totalChars: 16 });
    const normalizeCall = calls.find((c) => c.url.endsWith('/normalize'))!;
    expect((normalizeCall.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
    expect(normalizeCall.init.method).toBe('POST');
    // /health carries no token.
    const healthCall = calls.find((c) => c.url.endsWith('/health'))!;
    expect((healthCall.init.headers as Record<string, string>).Authorization).toBeUndefined();

    const status = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(status.activeMode).toBe('api');
    expect(status.server).toEqual({ ok: true, version: '9.9.9', terms: 3 });

    const learn = await bg.handle({ type: 'learn', heard: 'Ashlur', meant: 'Ashlr.AI' });
    expect(learn).toMatchObject({ ok: true, mode: 'api', message: 'Added "Ashlur" as an alias of Ashlr.AI.' });
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/learn'))!.init.body))).toEqual({ heard: 'Ashlur', meant: 'Ashlr.AI' });

    const sync = await bg.handle({ type: 'sync' });
    expect(sync).toMatchObject({ ok: true, terms: 1 });
    const settings = await bg.getSettings();
    expect(settings.yaml).toContain('Entire.io');
    // The synced YAML works offline afterwards.
    expect(createEmbedded(settings.yaml).normalize('open entire dot io').output).toBe('open Entire.io');
  });

  it('a rejected token falls back to embedded and says why', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return { ok: true, status: 200, json: async () => ({ ok: true, version: '1', terms: 1 }) } as unknown as Response;
      return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;
    });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token: 'bad' } }), defaultYaml: EXAMPLE_YAML });
    const reply = (await bg.handle({ type: 'normalize', text: 'ping ashler' })) as NormalizeReply;
    expect(reply.ok && reply.mode).toBe('embedded');
    expect(reply.ok && reply.fallback).toMatch(/401/);
    expect(reply.ok && reply.output).toBe('ping Ashlr.AI');
  });

  it('status proves the stored token: a 401 on /stats is reported, not "Connected"', async () => {
    const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    let token = 'wrong-token';
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/health')) return json({ ok: true, version: '9.9.9', terms: 3 });
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === `Bearer ${token}` && token === 'right-token' ? json({ termCount: 3 }) : json({ error: 'missing or invalid bearer token' }, 401);
    });
    const store = memoryStore({ settings: { token } });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });

    const bad = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(bad.server).toEqual({ ok: true, version: '9.9.9', terms: 3 });
    expect(bad.activeMode).toBe('embedded');
    expect(bad.tokenError).toMatch(/rejected the token \(401\)/);

    // Catches: with no token stored, status said "Local API" while every
    // /normalize fell back to the embedded lexicon.
    await bg.saveSettings({ token: '' });
    const none = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(none.server).toEqual({ ok: true, version: '9.9.9', terms: 3 });
    expect(none.tokenSet).toBe(false);
    expect(none.activeMode).toBe('embedded');
    expect(((await bg.handle({ type: 'normalize', text: 'ping ashler' })) as NormalizeReply & { ok: true }).mode).toBe('embedded');

    token = 'right-token';
    await bg.saveSettings({ token });
    const good = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(good.activeMode).toBe('api');
    expect(good.tokenError).toBeUndefined();
  });

  // Catches: a /learn whose `conflict` says another term also holds the
  // spelling (or whose `untrustedProject` claims it) showed a bare "Added ..."
  // in the popup, so the user trusted a correction that may not win.
  it('a learn that conflicts with another term says so, with the remove command', async () => {
    const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    let body: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (url: string) => (url.endsWith('/health') ? json({ ok: true, version: '1', terms: 1 }) : json(body)));
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token: 'secret-token' } }), defaultYaml: EXAMPLE_YAML });
    body = {
      term: { canonical: 'Ashley', aliases: ['Ashler'] },
      created: true,
      aliasAdded: true,
      path: '/tmp/lexicon.yaml',
      conflict: { canonical: 'Ashlr.AI', scope: 'global', as: 'alias', spelling: 'Ashler' },
      untrustedProject: { path: '/repo/.lexicon.yaml', trust: 'untrusted' },
    };
    const learn = (await bg.handle({ type: 'learn', heard: 'Ashler', meant: 'Ashley' })) as { ok: true; message: string };
    expect(learn.message).toBe(
      'Added new term Ashley with alias "Ashler". But "Ashler" is also an alias of Ashlr.AI (global lexicon), so it may still be corrected to that ' +
        '(to drop it, run: lexicon remove "Ashlr.AI" --alias "Ashler" --global). The project lexicon /repo/.lexicon.yaml is not trusted and also claims "Ashler"; ' +
        'once it is trusted its term wins (review it with: lexicon trust).',
    );
    body = { term: { canonical: 'Ashley' }, created: false, aliasAdded: true, conflict: { canonical: 'Ashler', scope: 'project', as: 'canonical', spelling: 'Ashler' } };
    const own = (await bg.handle({ type: 'learn', heard: 'Ashler', meant: 'Ashley' })) as { ok: true; message: string };
    // Catches: the popup's canonical-conflict sentence stopped at "kept as written"
    // and named no way out, while the core conflictNote names the remove command.
    expect(own.message).toBe(
      'Added "Ashler" as an alias of Ashley. But "Ashler" is its own term (project), so it may still be kept as written; ' +
        'if the user never means it as its own term, drop it with: lexicon remove "Ashler" --project.',
    );
    expect(own.message).toBe(
      `Added "Ashler" as an alias of Ashley. But ${conflictNote([{ canonical: 'Ashler', scope: 'project', as: 'canonical', spelling: 'Ashler' }])}.`,
    );
    // No conflict, or one of an unexpected shape: the plain message.
    body = { term: { canonical: 'Ashley' }, created: false, aliasAdded: true, conflict: 'odd' };
    expect(((await bg.handle({ type: 'learn', heard: 'Ashler', meant: 'Ashley' })) as { message: string }).message).toBe('Added "Ashler" as an alias of Ashley.');
  });

  it("a refused learn shows the server's reason, and a 403 is not reported as a bad token", async () => {
    const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    let learnStatus = 400;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return json({ ok: true, version: '1', terms: 1 });
      if (url.endsWith('/learn')) {
        return learnStatus === 400
          ? json({ error: 'learnCorrection: heard and meant are the same' }, 400)
          : json({ error: 'project lexicon at /p/.lexicon.yaml is untrusted; run `lexicon trust`' }, 403);
      }
      return {
        ok: false,
        status: 500,
        json: async () => {
          throw new SyntaxError('not json');
        },
      } as unknown as Response;
    });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token: 'secret-token' } }), defaultYaml: EXAMPLE_YAML });

    expect(await bg.handle({ type: 'learn', heard: 'Ashlr.AI', meant: 'Ashlr.AI' })).toEqual({
      ok: false,
      error: 'API /learn: learnCorrection: heard and meant are the same',
    });
    learnStatus = 403;
    const untrusted = await bg.handle({ type: 'learn', heard: 'Ashlur', meant: 'Ashlr.AI' });
    expect(untrusted).toMatchObject({ ok: false, error: expect.stringContaining('untrusted') });
    expect((untrusted as Failure).error).not.toContain('rejected the token');
    // A body that is not JSON still gives the status.
    expect(await bg.handle({ type: 'sync' })).toEqual({ ok: false, error: 'API /lexicon returned HTTP 500' });
  });
});

// ---------------------------------------------------------------------------

describe('pairing (/pair page content script + background)', () => {
  const TOKEN = 'a'.repeat(32);

  function pairPage(token = TOKEN, port = '41733'): void {
    document.head.innerHTML =
      `<meta name="${PAIR_META.token}" content="${token}">` +
      `<meta name="${PAIR_META.port}" content="${port}">` +
      `<meta name="${PAIR_META.version}" content="9.9.9">`;
    document.body.innerHTML = '<h1>Pairing Lexicon...</h1><p id="status">Waiting for the browser extension.</p><div id="install">install it</div>';
  }

  afterEach(() => {
    document.head.innerHTML = '';
  });

  it('the content script reads the meta tags, posts { type: "pair" } and reports success in #status', async () => {
    pairPage();
    const send = vi.fn(async (): Promise<PairReply> => ({ ok: true, baseUrl: 'http://localhost:41733', terms: 26, version: '9.9.9' }));
    const outcome = await pairFromDocument({ doc: document, send });
    // jsdom's location is http://localhost:3000/, so the base URL takes the page host and the meta port.
    expect(send).toHaveBeenCalledWith({ type: 'pair', baseUrl: 'http://localhost:41733', token: TOKEN });
    expect(outcome.ok).toBe(true);
    const status = document.getElementById('status')!;
    expect(status.textContent).toBe('Paired with lexicon serve (26 terms). You can close this tab.');
    expect(status.className).toBe('ok');
    expect(document.querySelector('h1')!.textContent).toBe('Paired');
    // The extension is present, so the page's install instructions stay hidden.
    expect(document.getElementById('install')!.hidden).toBe(true);
  });

  it('writes the background error into #status, and refuses a page without a token', async () => {
    pairPage();
    const send = vi.fn(async (): Promise<Failure> => ({ ok: false, error: 'API rejected the token (401). Re-copy it from `lexicon serve --show`.' }));
    const outcome = await pairFromDocument({ doc: document, send });
    expect(outcome.ok).toBe(false);
    expect(document.getElementById('status')!.textContent).toContain('Pairing failed: API rejected the token (401)');
    expect(document.getElementById('status')!.className).toBe('error');

    const thrown = vi.fn(async (): Promise<PairReply> => {
      throw new Error('extension messaging failed');
    });
    pairPage();
    await pairFromDocument({ doc: document, send: thrown });
    expect(document.getElementById('status')!.textContent).toBe('Pairing failed: extension messaging failed');

    pairPage('');
    const untouched = vi.fn(async (): Promise<PairReply> => ({ ok: true, baseUrl: '', terms: 0, version: '' }));
    await pairFromDocument({ doc: document, send: untouched });
    expect(untouched).not.toHaveBeenCalled();
    expect(document.getElementById('status')!.textContent).toContain('no pairing token');
  });

  it('the background proves the token on GET /stats, then stores baseUrl, token and mode api', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const auth = (init.headers as Record<string, string>).Authorization;
      if (url.endsWith('/stats')) return auth === `Bearer ${TOKEN}` ? json({ termCount: 26, aliasCount: 40 }) : json({ error: 'bad token' }, 401);
      if (url.endsWith('/health')) return json({ ok: true, version: '9.9.9', terms: 26 });
      return json({ error: 'nope' }, 404);
    });
    const store: KeyValueStore & { data: Record<string, unknown> } = (() => {
      const data: Record<string, unknown> = { settings: { mode: 'embedded', token: '', yaml: 'version: 1\nterms: []\n' } };
      return {
        data,
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
        set: async (items) => {
          Object.assign(data, items);
        },
      };
    })();
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });

    const reply = await bg.handle({ type: 'pair', baseUrl: 'http://127.0.0.1:41733/', token: TOKEN });
    expect(reply).toEqual({ ok: true, baseUrl: 'http://127.0.0.1:41733', terms: 26, version: '9.9.9' });
    expect(calls[0].url).toBe('http://127.0.0.1:41733/stats');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const settings = await bg.getSettings();
    expect(settings).toMatchObject({ baseUrl: 'http://127.0.0.1:41733', token: TOKEN, mode: 'api' });
    // The embedded YAML and the rest of the settings survive pairing.
    expect(settings.yaml).toBe('version: 1\nterms: []\n');
    // Status now reports the API without a second /health round trip being required.
    const status = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(status.activeMode).toBe('api');
    expect(status.tokenSet).toBe(true);
  });

  it('the background stores nothing when the server rejects the token or the URL is not loopback', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response);
    const data: Record<string, unknown> = { settings: { token: 'keep-me', baseUrl: 'http://127.0.0.1:41733', mode: 'api' } };
    const store: KeyValueStore = {
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
      set: async (items) => {
        Object.assign(data, items);
      },
    };
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });

    const rejected = await bg.handle({ type: 'pair', baseUrl: 'http://127.0.0.1:41733', token: 'b'.repeat(32) });
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining('401') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((data.settings as { token: string }).token).toBe('keep-me');

    const hostile = await bg.handle({ type: 'pair', baseUrl: 'http://evil.example:41733', token: 'b'.repeat(32) });
    expect(hostile).toMatchObject({ ok: false, error: expect.stringContaining('127.0.0.1 or localhost') });
    const malformed = await bg.handle({ type: 'pair', baseUrl: 'http://127.0.0.1:41733', token: 'not-hex' });
    expect(malformed).toMatchObject({ ok: false, error: expect.stringContaining('no valid token') });
    // Neither of those touched the network.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((data.settings as { token: string }).token).toBe('keep-me');
  });
});

// ---------------------------------------------------------------------------
// Added after the 2026-09-19 live validation (docs/EXTENSION.md, "Supported sites").

describe('live-site regressions (2026-09-19)', () => {
  it('a dry-run precheck that found replacements still intercepts Enter', async () => {
    // The API and the embedded engine both report `changed: false` for a dry
    // run; the replacements list is what says the text needs fixing.
    document.body.innerHTML = '<form><textarea id="box"></textarea></form>';
    const box = document.getElementById('box') as HTMLTextAreaElement;
    const send = vi.fn(fakeSend);
    handle = installContent({ doc: document, hostname: 'example.org', send, settings: { enabled: true, live: false }, precheckDebounceMs: 5 });
    box.value = 'ping ashler about cooper netties';
    box.focus();
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(30);
    expect(send).toHaveBeenLastCalledWith({ type: 'normalize', text: 'ping ashler about cooper netties', dryRun: true });

    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    box.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await handle.idle();
    // The Enter itself still lands: a plain textarea on a generic site gets its newline.
    expect(box.value).toBe('ping Ashlr.AI about Kubernetes\n');
    expect(toastText()).toContain('Kubernetes');
  });

  it('finds the Grok Tiptap composer inside the form and ignores the stray textarea', () => {
    document.body.innerHTML =
      '<textarea></textarea>' +
      '<form><div class="tiptap ProseMirror" contenteditable="true" role="textbox" aria-label="Ask Grok anything"><p>hi</p></div>' +
      '<button type="submit" data-testid="chat-submit" aria-label="Submit"></button></form>';
    const adapter = adapterFor('grok.com');
    const composer = findComposer(document, adapter);
    expect(composer?.className).toBe('tiptap ProseMirror');
    expect(composerFromTarget(composer!.firstChild, adapter)).toBe(composer);
    expect(composerFromTarget(document.querySelector('textarea'), adapter)).toBeNull();
    expect(findSendButton(document, adapter, composer)?.getAttribute('data-testid')).toBe('chat-submit');
  });

  it('waits for the editor to flush one ranged edit before applying the next (Lexical)', async () => {
    document.body.innerHTML =
      '<div id="e" contenteditable="true" data-lexical-editor="true"><p dir="auto"><span data-lexical-text="true">ping ashler about cooper netties</span></p></div>';
    const e = document.getElementById('e')!;
    // A MutationObserver callback is how Lexical and ProseMirror learn about
    // native edits; a second edit before that callback ran is what desynced
    // Lexical on perplexity.ai.
    let flushes = 0;
    const flushesSeen: number[] = [];
    const mo = new MutationObserver(() => {
      flushes++;
    });
    mo.observe(e, { characterData: true, childList: true, subtree: true });
    e.addEventListener('input', () => flushesSeen.push(flushes));
    const r = engine.normalize(readText(e));
    expect(r.replacements).toHaveLength(2);
    expect(await applyCorrections(document, e, r.replacements, r.output)).toBe('ping Ashlr.AI about Kubernetes');
    mo.disconnect();
    expect(flushesSeen).toHaveLength(2);
    expect(flushesSeen[0]).toBe(0); // first edit is synchronous
    expect(flushesSeen[1]).toBeGreaterThanOrEqual(1); // second edit waited for the flush
    expect(e.querySelector('span[data-lexical-text]')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Audit (round 4): the composer guard must not break ordinary inputs.
// ---------------------------------------------------------------------------

describe('content: generic sites keep the Enter key working', () => {
  // A browser runs no default action for a script-dispatched (untrusted)
  // keydown: re-dispatching Enter after the rewrite inserts no newline and
  // submits no form. On a site without a known send button the guard has to
  // carry out what the real Enter would have done.

  it('a plain textarea still gets its newline, at the caret, after the rewrite', async () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const t = document.getElementById('t') as HTMLTextAreaElement;
    handle = installContent({ doc: document, hostname: 'example.org', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    t.value = 'ping ashler';
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    t.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await handle.idle();
    expect(t.value).toBe('ping Ashlr.AI\n');
    expect(t.selectionEnd).toBe(t.value.length);
  });

  it('a single-line input inside a form still submits it through its default button', async () => {
    document.body.innerHTML = '<form id="f"><input id="q" type="text"><button id="go" type="submit">go</button></form>';
    const q = document.getElementById('q') as HTMLInputElement;
    const form = document.getElementById('f') as HTMLFormElement;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    const clicked = vi.fn();
    form.addEventListener('submit', submitted);
    document.getElementById('go')!.addEventListener('click', clicked);
    handle = installContent({ doc: document, hostname: 'example.org', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    q.value = 'ping ashler';
    q.focus();
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(q.value).toBe('ping Ashlr.AI');
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('a form without a submit button and several text fields is not submitted, as a real Enter would not', async () => {
    document.body.innerHTML =
      '<form id="f"><input id="u" type="text"><input id="p" type="password"><button type="button">log in</button></form>';
    const u = document.getElementById('u') as HTMLInputElement;
    const form = document.getElementById('f') as HTMLFormElement;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submitted);
    handle = installContent({ doc: document, hostname: 'example.org', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    u.value = 'ping ashler';
    u.focus();
    u.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(u.value).toBe('ping Ashlr.AI');
    expect(submitted).not.toHaveBeenCalled();
  });

  it('a form without a submit button and one text field is still submitted', async () => {
    document.body.innerHTML = '<form id="f"><input id="q" type="search"><input type="checkbox"></form>';
    const q = document.getElementById('q') as HTMLInputElement;
    const form = document.getElementById('f') as HTMLFormElement;
    const submitted = vi.fn((e: Event) => e.preventDefault());
    form.addEventListener('submit', submitted);
    handle = installContent({ doc: document, hostname: 'example.org', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    q.value = 'ping ashler';
    q.focus();
    q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(q.value).toBe('ping Ashlr.AI');
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('a site that handles Enter itself (keydown or keypress) gets the event and no extra newline', async () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const t = document.getElementById('t') as HTMLTextAreaElement;
    const onKeypress = vi.fn((e: KeyboardEvent) => e.preventDefault());
    t.addEventListener('keypress', onKeypress);
    handle = installContent({ doc: document, hostname: 'example.org', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    t.value = 'ping ashler';
    t.focus();
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(onKeypress).toHaveBeenCalledTimes(1);
    expect(t.value).toBe('ping Ashlr.AI');
  });

  it('a known site whose send button is missing gets no stray newline either', async () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p>ping ashler</p></div>';
    const composer = document.getElementById('prompt-textarea')!;
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(readText(composer)).toBe('ping Ashlr.AI');
  });
});

describe('content: undo never overwrites what the user typed since', () => {
  it('leaves a new draft alone when the corrected message was sent and the user started another', async () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p>ping ashler</p></div>';
    const composer = document.getElementById('prompt-textarea')!;
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    composer.addEventListener('keydown', (ev) => ev.preventDefault());
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(readText(composer)).toBe('ping Ashlr.AI');
    // The site sent it and cleared the box; the user is typing the next message.
    composer.innerHTML = '<p>and one more thing</p>';
    document.getElementById(TOAST_ID)!.shadowRoot!.querySelector<HTMLButtonElement>('button.undo')!.click();
    expect(readText(composer)).toBe('and one more thing');
  });

  it('still restores the dictated wording into an emptied composer', async () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p>ping ashler</p></div>';
    const composer = document.getElementById('prompt-textarea')!;
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    composer.addEventListener('keydown', (ev) => ev.preventDefault());
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    composer.innerHTML = '<p><br></p>';
    document.getElementById(TOAST_ID)!.shadowRoot!.querySelector<HTMLButtonElement>('button.undo')!.click();
    expect(readText(composer)).toBe('ping ashler');
  });
});

describe('content: live mode keeps the caret where the user is typing', () => {
  it('contenteditable: the caret ends after the corrected prefix, not after the first rewrite', async () => {
    document.body.innerHTML = '<div id="e" contenteditable="true"><p>ping ashler about cooper netties and</p></div>';
    const e = document.getElementById('e')!;
    handle = installContent({
      doc: document,
      hostname: 'example.org',
      send: vi.fn(fakeSend),
      settings: { enabled: true, live: true },
      liveDebounceMs: 5,
      precheckDebounceMs: 1000,
    });
    e.focus();
    const text = e.querySelector('p')!.firstChild as Text;
    const sel = document.getSelection()!;
    const r = document.createRange();
    r.setStart(text, text.data.length);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(60);
    expect(readText(e)).toBe('ping Ashlr.AI about Kubernetes and');
    const { caretOffset } = await import('../extension/src/editable.js');
    expect(caretOffset(document, e)).toBe('ping Ashlr.AI about Kubernetes and'.length);
  });
});

// ---------------------------------------------------------------------------

// Catches: Options and the popup set every message with textContent, so a
// command read "`lexicon serve --pair`" with the backticks shown literally.
describe('popup status line', () => {
  const base: StatusReply = {
    ok: true,
    configuredMode: 'api',
    activeMode: 'embedded',
    server: null,
    serverError: 'cannot reach lexicon serve at http://127.0.0.1:41733; start it with `lexicon serve` (or `lexicon serve --install` to start it at login)',
    tokenSet: false,
    embeddedTerms: 12,
    recent: [],
    live: false,
    anySite: false,
  };

  // Catches: a first run (no server, no token) ended the line with a bare
  // "no token set", so starting the server looked like the whole fix and the
  // popup still read Embedded (fallback) afterwards.
  it('a first run with no server and no token names starting the server and then pairing', () => {
    expect(statusView(base)).toEqual({
      mode: 'Embedded (fallback)',
      warn: true,
      line:
        '12 embedded terms · server: cannot reach lexicon serve at http://127.0.0.1:41733; start it with `lexicon serve` (or `lexicon serve --install` to start it at login) · no token set: once the server is running, run `lexicon serve --pair`',
    });
  });

  it('names the fix for each other state the API is not used in', () => {
    expect(statusView({ ...base, server: { ok: true, version: '1.2.3', terms: 4 }, serverError: undefined }).line).toBe(
      '12 embedded terms · server up (lexicon 1.2.3), but no token set: run `lexicon serve --pair`',
    );
    const rejected = 'API rejected the token (401). Re-copy it from `lexicon serve --show`, or run `lexicon serve --pair`.';
    expect(statusView({ ...base, server: { ok: true, version: '1', terms: 1 }, serverError: undefined, tokenSet: true, tokenError: rejected }).line).toBe(`12 embedded terms · ${rejected}`);
    // Catches: "embedded YAML has errors" with no word of where to fix it.
    expect(statusView({ ...base, configuredMode: 'embedded', embeddedError: 'bad indent' })).toEqual({
      mode: 'Embedded',
      warn: false,
      line: '12 embedded terms · embedded YAML has errors: fix it under Options > Embedded lexicon',
    });
    expect(statusView({ ...base, activeMode: 'api', tokenSet: true, server: { ok: true, version: '1.2.3', terms: 4 } })).toEqual({ mode: 'Local API', warn: false, line: 'lexicon 1.2.3, 4 terms' });
  });

  it('renders through setMessage, so a server error string stays text', () => {
    const el = document.createElement('p');
    setMessage(el, statusView({ ...base, serverError: '<img src=x onerror="alert(1)">' }).line);
    expect(el.querySelector('img')).toBeNull();
    expect(Array.from(el.querySelectorAll('code'), (c) => c.textContent)).toEqual(['lexicon serve --pair']);
  });
});

describe('Options > Test connection result', () => {
  const base: StatusReply = {
    ok: true,
    configuredMode: 'api',
    activeMode: 'embedded',
    server: { ok: true, version: '1.2.3', terms: 4 },
    tokenSet: false,
    embeddedTerms: 12,
    recent: [],
    live: false,
    anySite: false,
  };

  // Catches: a server that was up with no token set read "Connected: ...",
  // though this browser's corrections still used the embedded lexicon.
  it('does not say Connected for a server that is up but not paired', () => {
    const line = connectionTestLine(base);
    expect(line.startsWith('Connected')).toBe(false);
    expect(line).toBe('Server is up, not paired: lexicon 1.2.3, 4 terms. Corrections use the embedded lexicon until you run `lexicon serve --pair`.');
  });

  it('says Connected only with a token, and names the fix otherwise', () => {
    expect(connectionTestLine({ ...base, tokenSet: true, activeMode: 'api' })).toBe('Connected: lexicon 1.2.3, 4 terms.');
    expect(connectionTestLine({ ...base, tokenSet: true, tokenError: 'API rejected the token (401).' })).toBe('Reachable (lexicon 1.2.3), but API rejected the token (401).');
    expect(connectionTestLine({ ...base, server: null, serverError: 'timeout' })).toBe('Unreachable: timeout. Start it with `lexicon serve`.');
    expect(connectionTestLine({ ...base, server: null, serverError: 'start it with `lexicon serve`' })).toBe('Unreachable: start it with `lexicon serve`.');
  });
});

describe('Options > Sync from the local API result', () => {
  // Catches: one synced term read "Synced 1 terms".
  it('puts the term count in the right number', () => {
    expect(syncedLine({ ok: true, terms: 1, yaml: '' })).toBe('Synced 1 term from the local API.');
    expect(syncedLine({ ok: true, terms: 0, yaml: '' })).toBe('Synced 0 terms from the local API.');
    expect(syncedLine({ ok: true, terms: 3, yaml: '' })).toBe('Synced 3 terms from the local API.');
    expect(countOf(1, 'alias', 'aliases')).toBe('1 alias');
    expect(countOf(2, 'alias', 'aliases')).toBe('2 aliases');
  });
});

describe('popup and options messages render commands as <code>', () => {
  it('turns backticked spans into <code> and keeps everything else as text', () => {
    const el = document.createElement('p');
    setMessage(el, 'No API token set: run `lexicon serve --pair` to pair this browser, or paste the token `lexicon serve --show` prints into Options.');
    expect(el.textContent).toBe('No API token set: run lexicon serve --pair to pair this browser, or paste the token lexicon serve --show prints into Options.');
    expect(Array.from(el.querySelectorAll('code'), (c) => c.textContent)).toEqual(['lexicon serve --pair', 'lexicon serve --show']);
    expect(el.innerHTML).toBe('No API token set: run <code>lexicon serve --pair</code> to pair this browser, or paste the token <code>lexicon serve --show</code> prints into Options.');
  });

  it('never parses markup, inside or outside the backticks, and keeps an unpaired backtick', () => {
    const el = document.createElement('p');
    setMessage(el, 'API /learn: <img src=x onerror="alert(1)"> run `<b>x</b>` then ` dangling');
    expect(el.querySelector('img, b')).toBeNull();
    expect(el.querySelector('code')!.textContent).toBe('<b>x</b>');
    expect(el.textContent).toBe('API /learn: <img src=x onerror="alert(1)"> run <b>x</b> then ` dangling');
    setMessage(el, 'empty `` pair');
    expect(el.textContent).toBe('empty `` pair');
    expect(el.querySelector('code')).toBeNull();
    setMessage(el, 'replaced');
    expect(el.innerHTML).toBe('replaced');
  });

  it('options and popup route every command-bearing message through setMessage and never use innerHTML', () => {
    for (const file of ['extension/src/options.ts', 'extension/src/popup.ts']) {
      const src = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
      // The YAML editor's parse error stays plain text: it quotes the user's YAML, backticks and all.
      const plain = src.split('\n').filter((l) => /\.textContent\s*=/.test(l) && !l.includes('ui.yamlError.textContent = errorMessage(err)'));
      expect(plain.length).toBeGreaterThan(10);
      for (const line of plain) {
        // A message assigned as plain text may not carry a backticked command
        // or a string that came from the background (error/message fields).
        expect(line, `${file}: ${line.trim()}`).not.toMatch(/`lexicon[^`$]*`|\.error\b|\.message\b|errorMessage\(|tokenError|parts\.join/);
      }
    }
  });
});
