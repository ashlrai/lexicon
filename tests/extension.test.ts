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
import type { KeyValueStore } from '../extension/src/background-core.js';
import { sendToBackground } from '../extension/src/chrome-store.js';
import { installContent } from '../extension/src/content-core.js';
import type { ContentHandle } from '../extension/src/content-core.js';
import { applyCorrections, flatten, invertCorrections, readText } from '../extension/src/editable.js';
import { createEmbedded, learnIntoYaml } from '../extension/src/embedded.js';
import { coerceSettings, hostKey, siteEnabled } from '../extension/src/shared.js';
import type { Correction, NormalizeReply, Request, StatusReply } from '../extension/src/shared.js';
import { TOAST_ID, showToast } from '../extension/src/toast.js';

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

  it('rewrites a textarea through the native setter and fires input', () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const t = document.getElementById('t') as HTMLTextAreaElement;
    t.value = 'ping ashler now';
    const seen: string[] = [];
    t.addEventListener('input', () => seen.push(t.value));
    const r = engine.normalize('ping ashler now');
    expect(applyCorrections(document, t, r.replacements, r.output)).toBe('ping Ashlr.AI now');
    expect(seen).toEqual(['ping Ashlr.AI now']);
  });

  it('rewrites a contenteditable in place, keeping the surrounding markup', () => {
    document.body.innerHTML = '<div id="e" contenteditable="true"><p>ping <em>ashler</em> and cooper netties</p></div>';
    const e = document.getElementById('e')!;
    const text = readText(e);
    const r = engine.normalize(text);
    expect(applyCorrections(document, e, r.replacements, r.output)).toBe(r.output);
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
});
