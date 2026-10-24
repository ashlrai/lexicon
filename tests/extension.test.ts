// @vitest-environment jsdom
/**
 * Browser extension: adapters, composer rewrite, Enter/click interception,
 * toast, embedded engine, and content <-> background message routing with a
 * mocked chrome.runtime. Pure DOM under jsdom; no real browser needed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADAPTERS, GENERIC, adapterFor, builtinPage, composerFromTarget, findComposer, findSendButton, guardActive, siteNote } from '../extension/src/adapters.js';
import { LEXICON_SHAPE_MESSAGE, createBackground, isPairPageOf, learnWarnings, tooLargeForApiMessage } from '../extension/src/background-core.js';
import { MAX_BODY_BYTES as SERVER_MAX_BODY_BYTES } from '../src/serve/server.js';
import { conflictNote } from '../src/core/index.js';
import type { KeyValueStore } from '../extension/src/background-core.js';
import { sendToBackground } from '../extension/src/chrome-store.js';
import { installContent } from '../extension/src/content-core.js';
import type { ContentHandle } from '../extension/src/content-core.js';
import { applyCorrections, flatten, invertCorrections, readText, setWholeText } from '../extension/src/editable.js';
import { createEmbedded, learnIntoYaml } from '../extension/src/embedded.js';
import { pairFromDocument } from '../extension/src/pair.js';
import { ANY_SITE_SCRIPT_ID, setAnySite } from '../extension/src/any-site.js';
import type { AnySiteApi, AnySiteScript } from '../extension/src/any-site.js';
import { prunePairPorts, registerPairPort } from '../extension/src/pair-port.js';
import type { PairPortApi } from '../extension/src/pair-port.js';
import { ANY_SITE_DENIED_MESSAGE, STORAGE_KEYS, API_MAX_BODY_BYTES, PAIR_PORT_DENIED_MESSAGE, pairPortOrigins, pairScriptMatches, coerceSettings, connectionTestLine, countOf, extensionRequestFailedLine, hostKey, pairUrl, pairableBaseUrl, siteEnabled, statusFailedView, statusView, syncedLine, PAIR_META, withConnection, withSiteSwitch, yamlBoxAfterChange } from '../extension/src/shared.js';
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

  it('rewrites a textarea and fires input', async () => {
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

  // Catches: the toast compared the composer with the corrected prefix only,
  // so after a live rewrite with text after the caret Undo did nothing.
  it('undo after a live rewrite puts the original back when text follows the caret', async () => {
    document.body.innerHTML = '<form><textarea placeholder="Ask Grok anything"></textarea></form>';
    const t = document.querySelector('textarea')!;
    handle = installContent({ doc: document, hostname: 'grok.com', send: vi.fn(fakeSend), settings: { enabled: true, live: true }, liveDebounceMs: 5, precheckDebounceMs: 1000, toastMs: 60_000 });
    t.value = 'ping ashler and ashler';
    t.setSelectionRange(11, 11);
    t.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(40);
    expect(t.value).toBe('ping Ashlr.AI and ashler');
    document.getElementById(TOAST_ID)!.shadowRoot!.querySelector<HTMLButtonElement>('button.undo')!.click();
    // Past the live debounce: the restored text is not corrected straight back.
    await wait(40);
    expect(t.value).toBe('ping ashler and ashler');
  });

  // Catches: the undo's own input event cleared the precheck and scheduled a
  // new dry run, so the next Enter corrected the restored wording again.
  it('after undo, Enter sends the restored wording as it is', async () => {
    document.body.innerHTML = '<form><textarea placeholder="Ask Grok anything"></textarea><button aria-label="Submit"></button></form>';
    const t = document.querySelector('textarea')!;
    const send = vi.fn(fakeSend);
    handle = installContent({ doc: document, hostname: 'grok.com', send, settings: { enabled: true, live: false }, precheckDebounceMs: 5, toastMs: 60_000 });
    t.addEventListener('keydown', (ev) => ev.preventDefault());
    t.value = 'ping ashler';
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(t.value).toBe('ping Ashlr.AI');
    document.getElementById(TOAST_ID)!.shadowRoot!.querySelector<HTMLButtonElement>('button.undo')!.click();
    expect(t.value).toBe('ping ashler');
    await wait(40);
    send.mockClear();
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(t.value).toBe('ping ashler');
    expect(send).not.toHaveBeenCalled();
  });

  it('undo after a live rewrite in a contenteditable restores the text after the caret too', async () => {
    document.body.innerHTML = '<div id="e" contenteditable="true"><p>ping ashler and more</p></div>';
    const e = document.getElementById('e')!;
    handle = installContent({ doc: document, hostname: 'example.org', send: vi.fn(fakeSend), settings: { enabled: true, live: true }, liveDebounceMs: 5, precheckDebounceMs: 1000, toastMs: 60_000 });
    e.focus();
    const node = e.querySelector('p')!.firstChild as Text;
    const r = document.createRange();
    r.setStart(node, 11);
    r.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(r);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(40);
    expect(readText(e)).toBe('ping Ashlr.AI and more');
    document.getElementById(TOAST_ID)!.shadowRoot!.querySelector<HTMLButtonElement>('button.undo')!.click();
    await wait(40);
    expect(readText(e)).toBe('ping ashler and more');
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
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"><p>ping ashler</p></div><button data-testid="send-button"></button>';
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

    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true"><p>ping ashler</p></div><button data-testid="send-button"></button>';
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
      // A server that refuses the correction itself is not overridden by the
      // embedded copy. A fresh background: this one backs off from the token
      // the server just rejected, so it would not ask.
      learnStatus = 400;
      const fresh = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token } }), defaultYaml: EXAMPLE_YAML });
      if (token) expect(await fresh.handle({ type: 'learn', heard: 'Hetznr', meant: 'Hetzner' })).toMatchObject({ ok: false });
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
      if (url.endsWith('/stats')) return json({ termCount: 3 });
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
    expect(sync).not.toHaveProperty('skippedProject');
    const settings = await bg.getSettings();
    expect(settings.yaml).toContain('Entire.io');
    // The synced YAML works offline afterwards.
    expect(createEmbedded(settings.yaml).normalize('open entire dot io').output).toBe('open Entire.io');
  });

  // Catches: sync dropped GET /lexicon's skippedProject, so Options could not
  // say that an untrusted repo lexicon was left out of what it synced.
  it('sync passes on the project lexicon the server skipped, path and trust only', async () => {
    const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return json({ ok: true, version: '1', terms: 1 });
      return json({
        lexicon: { version: 1, terms: [{ canonical: 'Entire.io', aliases: [] }] },
        paths: { global: '/g/lexicon.yaml' },
        projectTrust: 'changed',
        skippedProject: '/repo/.lexicon.yaml',
      });
    });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token: 'secret-token' } }), defaultYaml: EXAMPLE_YAML });
    const sync = await bg.handle({ type: 'sync' });
    expect(sync).toMatchObject({ ok: true, terms: 1, skippedProject: { path: '/repo/.lexicon.yaml', trust: 'changed' } });
  });

  // Catches: a 200 GET /lexicon without a `lexicon` object (another program
  // on the port, a proxy page) parsed as an empty lexicon and Sync wiped the
  // embedded YAML.
  it('sync leaves the embedded lexicon alone when GET /lexicon carries no lexicon', async () => {
    for (const body of [{}, { lexicon: null }, { lexicon: { version: 1 } }, null, { lexicon: 'terms: []' }]) {
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response);
      const store = memoryStore({ settings: { token: 'secret-token', yaml: EXAMPLE_YAML } });
      const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });
      expect(await bg.handle({ type: 'sync' })).toEqual({ ok: false, error: LEXICON_SHAPE_MESSAGE });
      expect((await bg.getSettings()).yaml).toBe(EXAMPLE_YAML);
    }
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

  // Catches: a bearer route failing for a reason other than 401 (another
  // program answering /health with ok, a lexicon that does not parse) was
  // ignored, so status said Local API and Test connection said Connected
  // while every /normalize fell back to the embedded lexicon.
  it('status reports a /stats failure other than 401 instead of Connected', async () => {
    const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return json({ ok: true, version: '9.9.9', terms: 3 });
      return json({ error: 'nope' }, 404);
    });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token: 'a'.repeat(32) } }), defaultYaml: EXAMPLE_YAML });
    const status = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(status.server).toEqual({ ok: true, version: '9.9.9', terms: 3 });
    expect(status.activeMode).toBe('embedded');
    expect(status.tokenError).toBeUndefined();
    expect(status.apiError).toMatch(/nope/);
    const line = connectionTestLine(status);
    expect(line.startsWith('Connected')).toBe(false);
    expect(line).toMatch(/^Reachable \(lexicon 9\.9\.9\), but .*nope.*\. Corrections use the embedded lexicon until that is fixed\.$/);
    expect(statusView(status).line).toMatch(/server: .*nope/);
    expect(statusView(status).warn).toBe(true);
  });

  // Catches: a token pasted with a character no header can carry (a smart
  // quote, a non-breaking space) made fetch throw a TypeError, which read as
  // "cannot reach lexicon serve" and left status saying Connected while every
  // /normalize fell back to the embedded lexicon.
  it('a stored token no header can carry is reported as a token problem, not an unreachable server', async () => {
    const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/health')) return json({ ok: true, version: '9.9.9', terms: 3 });
      // What Chromium does with a header value outside ISO-8859-1.
      const auth = (init.headers as Record<string, string>).Authorization;
      if ([...auth].some((ch) => ch.charCodeAt(0) > 0xff)) throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': String contains non ISO-8859-1 code point.");
      return json({ termCount: 3 });
    });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token: '\u201c' + 'a'.repeat(32) + '\u201d' } }), defaultYaml: EXAMPLE_YAML });
    const status = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(status.server).toEqual({ ok: true, version: '9.9.9', terms: 3 });
    expect(status.activeMode).toBe('embedded');
    expect(status.tokenError).toMatch(/token/);
    expect(status.tokenError).not.toMatch(/cannot reach/);
    const reply = (await bg.handle({ type: 'normalize', text: 'ping ashler' })) as NormalizeReply & { ok: true };
    expect(reply.mode).toBe('embedded');
    expect(reply.fallback).toMatch(/lexicon serve --show/);
    expect(reply.fallback).not.toMatch(/cannot reach/);
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
        '(to drop it, run: lexicon remove Ashlr.AI --alias Ashler --global). The project lexicon /repo/.lexicon.yaml is not trusted and also claims "Ashler"; ' +
        'once it is trusted its term wins (review it with: lexicon trust).',
    );
    body = { term: { canonical: 'Ashley' }, created: false, aliasAdded: true, conflict: { canonical: 'Ashler', scope: 'project', as: 'canonical', spelling: 'Ashler' } };
    const own = (await bg.handle({ type: 'learn', heard: 'Ashler', meant: 'Ashley' })) as { ok: true; message: string };
    // Catches: the popup's canonical-conflict sentence stopped at "kept as written"
    // and named no way out, while the core conflictNote names the remove command.
    expect(own.message).toBe(
      'Added "Ashler" as an alias of Ashley. But "Ashler" is its own term (project), so it may still be kept as written; ' +
        'if the user never means it as its own term, drop it with: lexicon remove Ashler --project.',
    );
    expect(own.message).toBe(
      `Added "Ashler" as an alias of Ashley. But ${conflictNote([{ canonical: 'Ashler', scope: 'project', as: 'canonical', spelling: 'Ashler' }])}.`,
    );
    // No conflict, or one of an unexpected shape: the plain message.
    body = { term: { canonical: 'Ashley' }, created: false, aliasAdded: true, conflict: 'odd' };
    expect(((await bg.handle({ type: 'learn', heard: 'Ashler', meant: 'Ashley' })) as { message: string }).message).toBe('Added "Ashler" as an alias of Ashley.');
  });

  // Catches: the popup's alias-conflict remove step was JSON-quoted, so a `$`
  // in a name expanded when pasted into a shell; it now uses the core's
  // shell-quoted conflictRemoveCommand (POSIX in the browser, no process).
  it('quotes the alias-conflict remove step for the shell', () => {
    const msg = learnWarnings('O$x', { canonical: 'Acme $HOME Co', scope: 'global', as: 'alias', spelling: 'O$x' }, undefined);
    expect(msg).toContain(`(to drop it, run: lexicon remove 'Acme $HOME Co' --alias 'O$x' --global).`);
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
    expect(await bg.handle({ type: 'sync' })).toEqual({ ok: false, error: 'API /lexicon returned HTTP 500; run `lexicon serve --status` to check the server' });
  });
});

// Catches: background and embedded errors that said what failed and stopped
// there ("API /lexicon timed out", "server reports not ok", "Embedded lexicon
// does not parse"), with no word of what to do next.
describe('extension errors name the next step', () => {
  function storeWith(settings: Record<string, unknown>): KeyValueStore {
    const data: Record<string, unknown> = { settings };
    return {
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
      set: async (items) => {
        Object.assign(data, items);
      },
    };
  }
  const token = 'a'.repeat(64);
  const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('a timeout and a server reporting not ok name `lexicon serve --status`', async () => {
    const aborting = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const bg = createBackground({ fetch: aborting as unknown as typeof fetch, store: storeWith({ token }), defaultYaml: EXAMPLE_YAML });
    expect(await bg.handle({ type: 'sync' })).toEqual({ ok: false, error: 'API /lexicon timed out after 10000 ms; run `lexicon serve --status` to check the server' });

    const notOk = vi.fn(async () => json({ ok: false, version: '1', terms: 0 }));
    const bg2 = createBackground({ fetch: notOk as unknown as typeof fetch, store: storeWith({ token }), defaultYaml: EXAMPLE_YAML });
    const status = (await bg2.handle({ type: 'status' })) as StatusReply;
    expect(status.serverError).toBe('server reports not ok; run `lexicon serve --status` to check the server');
  });

  it('a /normalize reply of another shape says the releases differ and to update one', async () => {
    const fetchMock = vi.fn(async (url: string) => (url.endsWith('/health') ? json({ ok: true, version: '9.9.9', terms: 1 }) : json({ text: 'x' })));
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: storeWith({ token }), defaultYaml: EXAMPLE_YAML });
    const reply = (await bg.handle({ type: 'normalize', text: 'ping ashler' })) as NormalizeReply & { fallback?: string };
    expect(reply).toMatchObject({ ok: true, mode: 'embedded' });
    expect(reply.fallback).toBe(
      'API /normalize returned an unexpected shape: the server and this extension are likely different releases; update lexicon or the extension so they match.',
    );
  });

  it('an embedded lexicon that does not parse says where to fix it', async () => {
    const bg = createBackground({ fetch: vi.fn() as unknown as typeof fetch, store: storeWith({ mode: 'embedded', yaml: 'terms: [' }), defaultYaml: EXAMPLE_YAML });
    const reply = (await bg.handle({ type: 'normalize', text: 'ping ashler' })) as Failure;
    expect(reply.ok).toBe(false);
    expect(reply.error.startsWith('Embedded lexicon does not parse (fix the YAML under Options > Embedded lexicon, or press Sync from local API there again): ')).toBe(true);
  });

  it('learning into the embedded YAML names Options for a broken file and a full one', () => {
    expect(() => learnIntoYaml('terms: [', 'Ashler', 'Ashlr.AI')).toThrow(/^Embedded YAML does not parse \(fix it under Options > Embedded lexicon\): /);
    expect(() => learnIntoYaml('version: 1\nterms: 3\n', 'Ashler', 'Ashlr.AI')).toThrow('Embedded YAML: terms is not a list; fix it under Options > Embedded lexicon.');
    const many = Array.from({ length: 64 }, (_, i) => `a${i}`);
    expect(() => learnIntoYaml(`version: 1\nterms:\n  - canonical: Quokka\n    aliases: [${many.join(', ')}]\n`, 'Kwokka', 'Quokka')).toThrow(
      'Quokka already has 64 aliases; remove one under Options > Embedded lexicon first.',
    );
    const full = `version: 1\nterms:\n${Array.from({ length: 5000 }, (_, i) => `  - canonical: T${i}\n    aliases: [t${i}x]\n`).join('')}`;
    expect(() => learnIntoYaml(full, 'Kwokka', 'Quokka')).toThrow(
      'The embedded lexicon already has 5000 terms; remove one under Options > Embedded lexicon, or pair with the local API (`lexicon serve --pair`), which keeps the lexicon on disk.',
    );
  });

  // Catches: the popup pill read a bare "Error" when the status request
  // failed, naming neither what failed nor what to try.
  it('the popup pill says what failed and the line how to get it back', () => {
    expect(statusFailedView('no response')).toEqual({
      mode: 'Status unavailable',
      warn: true,
      line: "could not read the extension status: no response. Close and reopen the popup; if it persists, reload Lexicon on the browser's extensions page.",
    });
    const popup = readFileSync(resolve(process.cwd(), 'extension/src/popup.ts'), 'utf8');
    expect(popup).not.toMatch(/textContent = 'Error'/);
  });

  // Catches: Options and the /pair page showed a failed request to the
  // background (the extension reloaded under the page) as a bare
  // "extension messaging failed", with no way back.
  it('a failed request to the background says to reload the page, then the extension', () => {
    expect(extensionRequestFailedLine('extension messaging failed')).toBe(
      "extension messaging failed. Reload this page; if it persists, reload Lexicon on the browser's extensions page.",
    );
    expect(extensionRequestFailedLine('no response. ')).toMatch(/^no response\. Reload/);
    const options = readFileSync(resolve(process.cwd(), 'extension/src/options.ts'), 'utf8');
    const catches = options.split('\n').filter((l) => /\.catch\(\(err: unknown\)/.test(l)).length;
    expect(catches).toBe(4);
    expect(options.match(/extensionRequestFailedLine\(errorMessage\(err\)\)/g)).toHaveLength(catches);
  });

  // Catches: the "Any site" registration had no matchOriginAsFallback, so an
  // editor that builds its editable in an about:blank (or blob:) frame was
  // never reached on a site other than the built-in ones.
  it('the any-site registration reaches about:blank frames where the browser accepts it, and falls back where not', async () => {
    const fakeApi = (acceptsFallback: boolean, initial: AnySiteScript[] = []): { api: AnySiteApi; scripts: Map<string, AnySiteScript>; registers: number } => {
      const state = { api: undefined as unknown as AnySiteApi, scripts: new Map(initial.map((s) => [s.id, s])), registers: 0 };
      state.api = {
        scripting: {
          getRegisteredContentScripts: async (filter) => [...state.scripts.values()].filter((s) => !filter?.ids || filter.ids.includes(s.id)),
          registerContentScripts: async (list) => {
            for (const s of list) {
              if (!acceptsFallback && 'matchOriginAsFallback' in s) throw new Error('Type error for parameter scripts: Unexpected property "matchOriginAsFallback"');
              if (state.scripts.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
              state.scripts.set(s.id, s);
              state.registers += 1;
            }
          },
          unregisterContentScripts: async (filter) => {
            for (const id of filter?.ids ?? [...state.scripts.keys()]) state.scripts.delete(id);
          },
        },
        permissions: { contains: async () => true },
      };
      return state;
    };
    const chromeLike = fakeApi(true);
    await setAnySite(chromeLike.api, true);
    const reg = chromeLike.scripts.get(ANY_SITE_SCRIPT_ID)!;
    expect(reg.matchOriginAsFallback).toBe(true);
    expect(reg.allFrames).toBe(true);
    expect(reg.matches).toEqual(['<all_urls>']);
    // Already registered the same way: nothing is re-registered.
    await setAnySite(chromeLike.api, true);
    expect(chromeLike.registers).toBe(1);
    // A registration from before the key is replaced.
    const old = fakeApi(true, [{ ...reg, matchOriginAsFallback: undefined }]);
    await setAnySite(old.api, true);
    expect(old.scripts.get(ANY_SITE_SCRIPT_ID)?.matchOriginAsFallback).toBe(true);
    // A browser that refuses the key still gets the frames registration.
    const firefoxLike = fakeApi(false);
    await setAnySite(firefoxLike.api, true);
    const ff = firefoxLike.scripts.get(ANY_SITE_SCRIPT_ID)!;
    expect(ff.allFrames).toBe(true);
    expect('matchOriginAsFallback' in ff).toBe(false);
    await setAnySite(firefoxLike.api, false);
    expect(firefoxLike.scripts.size).toBe(0);
    // Not granted: nothing registered.
    const denied = fakeApi(true);
    denied.api.permissions.contains = async () => false;
    await expect(setAnySite(denied.api, true)).rejects.toThrow(ANY_SITE_DENIED_MESSAGE);
    expect(denied.scripts.size).toBe(0);
  });

  // Catches: on a browser that refuses matchOriginAsFallback, every reconcile
  // (install, startup, a permission change) unregistered and registered the
  // script again, since the registration never matched the one with the key.
  it('the any-site reconcile leaves a registration alone where the browser refused the key', async () => {
    const fake = (acceptsFallback: () => boolean, browser: string, data?: Record<string, unknown>) => {
      const state = { scripts: new Map<string, AnySiteScript>(), registers: 0, unregisters: 0, api: undefined as unknown as AnySiteApi };
      state.api = {
        scripting: {
          getRegisteredContentScripts: async (filter) => [...state.scripts.values()].filter((s) => !filter?.ids || filter.ids.includes(s.id)),
          registerContentScripts: async (list) => {
            for (const s of list) {
              if (!acceptsFallback() && 'matchOriginAsFallback' in s) throw new Error('Type error for parameter scripts: Unexpected property "matchOriginAsFallback"');
              state.scripts.set(s.id, s);
              state.registers += 1;
            }
          },
          unregisterContentScripts: async (filter) => {
            for (const id of filter?.ids ?? [...state.scripts.keys()]) state.scripts.delete(id);
            state.unregisters += 1;
          },
        },
        permissions: { contains: async () => true },
        browser,
        ...(data
          ? {
              store: {
                get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
                set: async (items: Record<string, unknown>) => void Object.assign(data, items),
              },
            }
          : {}),
      };
      return state;
    };
    let accepts = false;
    const data: Record<string, unknown> = {};
    const firefox = fake(() => accepts, 'Firefox/128', data);
    for (let i = 0; i < 3; i++) await setAnySite(firefox.api, true);
    expect(firefox.registers).toBe(1);
    expect(firefox.unregisters).toBe(0);
    expect('matchOriginAsFallback' in firefox.scripts.get(ANY_SITE_SCRIPT_ID)!).toBe(false);
    expect(data[STORAGE_KEYS.anySiteNoFallback]).toBe('Firefox/128');

    // A browser update that accepts the key gets it on the next reconcile, once.
    accepts = true;
    firefox.api.browser = 'Firefox/140';
    await setAnySite(firefox.api, true);
    await setAnySite(firefox.api, true);
    expect(firefox.registers).toBe(2);
    expect(firefox.scripts.get(ANY_SITE_SCRIPT_ID)?.matchOriginAsFallback).toBe(true);
    expect(data[STORAGE_KEYS.anySiteNoFallback]).toBeNull();

    // With no store the refusal is remembered for the life of the module.
    const bare = fake(() => false, 'NoStore/1');
    for (let i = 0; i < 3; i++) await setAnySite(bare.api, true);
    expect(bare.registers).toBe(1);
  });

  // Catches: "Permission not granted." with no word of how to grant it or
  // whether the extension still works without it.
  it('the any-site refusal says how to grant it and what still works', () => {
    expect(ANY_SITE_DENIED_MESSAGE).toBe('The "any site" permission was not granted: tick the box again and choose Allow. The listed chat sites still work without it.');
    for (const file of ['extension/src/options.ts', 'extension/src/any-site.ts']) {
      const src = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(src, file).toContain('ANY_SITE_DENIED_MESSAGE');
      expect(src, file).not.toMatch(/not granted\./);
    }
  });
});

// ---------------------------------------------------------------------------

describe('pairing (/pair page content script + background)', () => {
  const TOKEN = 'a'.repeat(32);
  const PAIR_PAGE = { url: 'http://127.0.0.1:41733/pair' };

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
    expect(document.getElementById('status')!.textContent).toBe(
      "Pairing failed: extension messaging failed. Reload this page; if it persists, reload Lexicon on the browser's extensions page.",
    );

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

    const reply = await bg.handle({ type: 'pair', baseUrl: 'http://127.0.0.1:41733/', token: TOKEN }, { url: 'http://127.0.0.1:41733/pair' });
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

    const rejected = await bg.handle({ type: 'pair', baseUrl: 'http://127.0.0.1:41733', token: 'b'.repeat(32) }, PAIR_PAGE);
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining('401') });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((data.settings as { token: string }).token).toBe('keep-me');

    const hostile = await bg.handle({ type: 'pair', baseUrl: 'http://evil.example:41733', token: 'b'.repeat(32) }, { url: 'http://evil.example:41733/pair' });
    expect(hostile).toMatchObject({ ok: false, error: expect.stringContaining('127.0.0.1 or localhost') });
    // Catches: an upper-case hex token (a hand-edited serve.json, which lexicon
    // serve keeps) was refused before it was ever sent.
    const upper = await bg.handle({ type: 'pair', baseUrl: 'http://127.0.0.1:41733', token: 'B'.repeat(32) }, PAIR_PAGE);
    expect(upper).toMatchObject({ ok: false, error: expect.stringContaining('401') });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const malformed = await bg.handle({ type: 'pair', baseUrl: 'http://127.0.0.1:41733', token: 'not-hex' }, PAIR_PAGE);
    expect(malformed).toMatchObject({ ok: false, error: expect.stringContaining('no valid token') });
    // Neither of those touched the network.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((data.settings as { token: string }).token).toBe('keep-me');
  });

  // Catches: pairReq paired with whatever baseUrl the /pair page's meta named,
  // never checked against the tab that sent it, so a page could point the
  // extension (and its token) at another loopback server.
  it('the background pairs only with the origin of the /pair page that asked', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ termCount: 1 }) }) as unknown as Response);
    const data: Record<string, unknown> = { settings: { token: 'keep-me', baseUrl: 'http://127.0.0.1:41733', mode: 'api' } };
    const store: KeyValueStore = {
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
      set: async (items) => {
        Object.assign(data, items);
      },
    };
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });
    const req = { type: 'pair' as const, baseUrl: 'http://127.0.0.1:5000', token: 'b'.repeat(32) };
    for (const sender of [undefined, {}, { url: 'http://127.0.0.1:41733/pair' }, { url: 'http://localhost:5000/pair' }, { url: 'http://127.0.0.1:5000/other' }, { url: 'https://chat.example/pair' }, { url: 'not a url' }]) {
      const reply = await bg.handle(req, sender);
      expect(reply, JSON.stringify(sender)).toMatchObject({ ok: false, error: expect.stringContaining('Pairing must come from http://127.0.0.1:5000/pair itself') });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect((data.settings as { token: string }).token).toBe('keep-me');
    expect(await bg.handle(req, { url: 'http://127.0.0.1:5000/pair/' })).toMatchObject({ ok: true, baseUrl: 'http://127.0.0.1:5000' });
    expect(isPairPageOf('http://127.0.0.1:5000/pair?x=1', 'http://127.0.0.1:5000')).toBe(true);
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

  // Catches: the last-resort rewrite wiped the composer and wrote one <p> per
  // line, so a <pre> block (or inline <code>) became plain paragraphs and the
  // code lost its formatting in the message that was sent.
  it('setWholeText keeps pre and inline code elements, rewriting only the prose', () => {
    document.body.innerHTML =
      '<div id="e" contenteditable="true"><p>ping ashler with <code>ashler.run()</code> now</p><pre><code>const ashler = 1\nreturn ashler</code></pre><p>thanks ashler</p></div>';
    const e = document.getElementById('e')!;
    const pre = e.querySelector('pre')!;
    const inline = e.querySelector('p code')!;
    const before = readText(e);
    const next = before.replace(/^ping ashler/, 'ping Ashlr.AI').replace(/thanks ashler$/, 'thanks Ashlr.AI');
    setWholeText(document, e, next);
    expect(readText(e)).toBe(next);
    expect(e.querySelector('pre')).toBe(pre);
    expect(pre.textContent).toBe('const ashler = 1\nreturn ashler');
    expect(e.querySelector('p code')).toBe(inline);
    expect(inline.textContent).toBe('ashler.run()');
    expect(e.querySelectorAll('p')).toHaveLength(2);
  });

  // Catches: a rewrite that joined two prose lines (an alias split by a line
  // break) changed the line count of a prose region, so the ranged prose
  // edits gave up and the last resort turned the <pre> into paragraphs.
  it('setWholeText keeps code elements when a prose region loses a line', () => {
    document.body.innerHTML =
      '<div id="e" contenteditable="true"><p>ping ash</p><p>ler about <code>ashler()</code></p><pre><code>const ashler = 1</code></pre><p>thanks</p></div>';
    const e = document.getElementById('e')!;
    const pre = e.querySelector('pre')!;
    const inline = e.querySelector('p code')!;
    expect(readText(e)).toBe('ping ash\nler about ashler()\nconst ashler = 1\nthanks');
    const next = 'ping Ashlr.AI about ashler()\nconst ashler = 1\nthanks';
    setWholeText(document, e, next);
    expect(readText(e)).toBe(next);
    expect(e.querySelector('pre')).toBe(pre);
    expect(pre.textContent).toBe('const ashler = 1');
    expect(e.querySelector('p code')).toBe(inline);
    expect(e.querySelectorAll('p')).toHaveLength(2);
  });

  it('setWholeText keeps code elements when a prose region gains a line, in a <br> composer too', () => {
    document.body.innerHTML = '<div id="e" contenteditable="true">one two<br>see <code>npm i</code> now<pre>ls -la</pre>end</div>';
    const e = document.getElementById('e')!;
    const pre = e.querySelector('pre')!;
    const inline = e.querySelector('code')!;
    const next = 'one\ntwo\nsee npm i now\nls -la\nend';
    setWholeText(document, e, next);
    expect(readText(e)).toBe(next);
    expect(e.querySelector('pre')).toBe(pre);
    expect(e.querySelector('code')).toBe(inline);
    expect(e.querySelector('p')).toBeNull();
  });

  // Catches: the prose before a code span held the code's own text (`npm`
  // then <code>npm</code>), the first occurrence was taken as the code's
  // place, and the misaligned edits fell back to flattening the code.
  it('setWholeText aligns code with its own place when the prose holds the same text', () => {
    document.body.innerHTML = '<div id="e" contenteditable="true"><p>ashler said npm, run <code>npm</code> ashler</p><pre><code>npm</code></pre></div>';
    const e = document.getElementById('e')!;
    const pre = e.querySelector('pre')!;
    const inline = e.querySelector('p code')!;
    const next = 'Ashlr.AI said npm, run npm Ashlr.AI\nnpm';
    setWholeText(document, e, next);
    expect(readText(e)).toBe(next);
    expect(e.querySelector('pre')).toBe(pre);
    expect(e.querySelector('p code')).toBe(inline);
    expect(inline.textContent).toBe('npm');
  });

  // Catches: in a composer without <p> paragraphs, an empty line with a
  // <pre> right after it (or at the end, after one) was written as nothing,
  // since its line break was left to a following text line, so the rebuild
  // did not read back and the last resort flattened the code block.
  it('setWholeText keeps a <pre> next to an empty line in a <br> composer', () => {
    const cases: Array<[string, string]> = [
      ['<div id="e" contenteditable="true">one two<pre>ls</pre><div><br></div><pre>pwd</pre></div>', 'one\ntwo\nls\n\npwd'],
      ['<div id="e" contenteditable="true"><div><br></div><pre>ls</pre>one two</div>', '\nls\none\ntwo'],
      ['<div id="e" contenteditable="true">one two<pre>ls</pre><div><br></div></div>', 'one\ntwo\nls\n'],
      ['<div id="e" contenteditable="true">one two<br><br><pre>ls</pre>end</div>', 'one\ntwo\n\n\nls\nend'],
    ];
    for (const [html, next] of cases) {
      document.body.innerHTML = html;
      const e = document.getElementById('e')!;
      const pres = Array.from(e.querySelectorAll('pre'));
      // The rewrite gains a line in the prose, so ranged prose edits cannot express it.
      expect(readText(e).split('\n').length + 1, html).toBe(next.split('\n').length);
      setWholeText(document, e, next);
      expect(readText(e), html).toBe(next);
      expect(Array.from(e.querySelectorAll('pre')), html).toEqual(pres);
      expect(e.querySelector('p'), html).toBeNull();
    }
  });

  it('setWholeText restores every node when a rebuild cannot keep the code', () => {
    // The code text is not in the new text at all: nothing to keep, so the
    // last resort runs, but the rebuild attempt must not have lost any node.
    document.body.innerHTML = '<div id="e" contenteditable="true"><p>a <code>x</code></p><p>b</p></div>';
    const e = document.getElementById('e')!;
    setWholeText(document, e, 'a\nb\nc');
    expect(readText(e)).toBe('a\nb\nc');
  });

  it('setWholeText still rewrites the whole box when the code itself would change', () => {
    document.body.innerHTML = '<div id="e" contenteditable="true"><p>a</p><pre><code>ashler</code></pre></div>';
    const e = document.getElementById('e')!;
    setWholeText(document, e, 'a\nAshlr.AI');
    expect(readText(e)).toBe('a\nAshlr.AI');
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

  // Catches: in a rich text box the rewrite left the selection on the last
  // word it replaced (the first in the text, since corrections apply back to
  // front), so the line break Enter then inserted landed mid-text, after
  // "ping Ashlr.AI", instead of at the caret at the end.
  it('a rich text box gets its line break at the caret, shifted by the corrections before it', async () => {
    document.body.innerHTML = '<div id="e" class="ProseMirror" contenteditable="true"><p id="first">ping ashler</p><p id="last">use x with ashler and more</p></div>';
    const e = document.getElementById('e') as HTMLElement;
    e.focus();
    // The caret after "ashler" in the last paragraph, before " and more".
    document.getSelection()!.collapse(document.getElementById('last')!.firstChild, 'use x with ashler'.length);
    handle = installContent({ doc: document, hostname: 'example.org', send: vi.fn(fakeSend), settings: { enabled: true, live: false } });
    e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await handle.idle();
    expect(document.getElementById('first')!.innerHTML).toBe('ping Ashlr.AI');
    expect(document.getElementById('last')!.innerHTML).toBe('use x with Ashlr.AI<br> and more');
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
      '<form id="f"><input id="u" type="text"><input id="n" type="text"><button type="button">save</button></form>';
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

  // Catches: with "any site" on, Enter in a login form's username field
  // rewrote the username ("ashler" -> "Ashlr.AI") before the form submitted.
  it('never rewrites a username, email or code field, or a text field in a form with a password', async () => {
    for (const html of [
      '<form id="f"><input id="u" type="text" autocomplete="username"><button type="submit">go</button></form>',
      '<form id="f"><input id="u" type="text" autocomplete="section-login email"><button type="submit">go</button></form>',
      '<form id="f"><input id="u" type="text" autocomplete="one-time-code"><button type="submit">go</button></form>',
      '<form id="f"><input id="u" type="text"><input type="password"><button type="submit">log in</button></form>',
    ]) {
      document.body.innerHTML = html;
      const u = document.getElementById('u') as HTMLInputElement;
      const form = document.getElementById('f') as HTMLFormElement;
      const submitted = vi.fn((e: Event) => e.preventDefault());
      form.addEventListener('submit', submitted);
      const send = vi.fn(fakeSend);
      handle = installContent({ doc: document, hostname: 'example.org', send, settings: { enabled: true, live: true }, liveDebounceMs: 5, precheckDebounceMs: 5 });
      u.value = 'ashler';
      u.focus();
      u.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(20);
      u.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await handle.idle();
      expect(u.value, html).toBe('ashler');
      expect(send, html).not.toHaveBeenCalled();
      handle.destroy();
      handle = null;
    }
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
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    composer.dispatchEvent(ev);
    await handle.idle();
    // Nothing to click and no replay known to work: the press goes on as typed.
    expect(ev.defaultPrevented).toBe(false);
    expect(readText(composer)).toBe('ping ashler');
  });
});

describe('content: undo never overwrites what the user typed since', () => {
  it('leaves a new draft alone when the corrected message was sent and the user started another', async () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p>ping ashler</p></div><button data-testid="send-button"></button>';
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
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p>ping ashler</p></div><button data-testid="send-button"></button>';
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

  // Catches: a server holding one term read "1 terms" in Test connection and
  // in the popup status line.
  it('puts the term count in the right number', () => {
    const one = { ...base, server: { ok: true as const, version: '1.2.3', terms: 1 }, embeddedTerms: 1 };
    expect(connectionTestLine({ ...one, tokenSet: true, activeMode: 'api' })).toBe('Connected: lexicon 1.2.3, 1 term.');
    expect(connectionTestLine(one)).toBe('Server is up, not paired: lexicon 1.2.3, 1 term. Corrections use the embedded lexicon until you run `lexicon serve --pair`.');
    expect(statusView({ ...one, tokenSet: true, activeMode: 'api' }).line).toBe('lexicon 1.2.3, 1 term');
    expect(statusView({ ...one, server: null, serverError: 'down' }).line.startsWith('1 embedded term · ')).toBe(true);
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

  // Catches: a sync whose server left an untrusted repo lexicon out read
  // "Synced N terms" and nothing else, as if the repo's names were in it.
  it('names the skipped project lexicon and `lexicon trust`', () => {
    expect(syncedLine({ ok: true, terms: 2, yaml: '', skippedProject: { path: '/repo/.lexicon.yaml', trust: 'untrusted' } })).toBe(
      'Synced 2 terms from the local API. The project lexicon /repo/.lexicon.yaml is untrusted, so its terms were left out: review it and run `lexicon trust` in that repo, then sync again.',
    );
    expect(syncedLine({ ok: true, terms: 2, yaml: '', skippedProject: { path: '/repo/.lexicon.yaml', trust: 'changed' } })).toContain(
      'The project lexicon /repo/.lexicon.yaml has changed since it was trusted, so its terms were left out',
    );
  });
});

describe('popup and Options write only what they change', () => {
  // Catches: the popup stored coerceSettings(stored, ''), so the first site
  // switch on a fresh install saved an empty YAML and the embedded lexicon
  // corrected nothing.
  it('the popup site switch keeps every stored field and leaves the YAML to its default when none is stored', () => {
    const fresh = withSiteSwitch(undefined, 'www.Perplexity.ai', false);
    expect(fresh).toEqual({ sites: { 'perplexity.ai': false } });
    expect(coerceSettings(fresh, EXAMPLE_YAML).yaml).toBe(EXAMPLE_YAML);
    const stored = { token: 'a'.repeat(32), yaml: 'version: 1\nterms: []\n', sites: { 'claude.ai': false }, anySite: true };
    expect(withSiteSwitch(stored, 'chatgpt.com', false)).toEqual({ ...stored, sites: { 'claude.ai': false, 'chatgpt.com': false } });
    expect(stored.sites).toEqual({ 'claude.ai': false });
  });

  // Catches: Test connection and Sync saved the whole Options form, so a word
  // the popup had just learned into the embedded YAML (or a site it paused)
  // was overwritten with what Options had loaded.
  it('Test connection and Sync store only the connection fields over what is stored now', () => {
    const stored = { baseUrl: 'http://127.0.0.1:41733', token: '', mode: 'api', yaml: 'learned: yes', sites: { 'grok.com': false } };
    expect(withConnection(stored, { baseUrl: 'http://localhost:41800', token: 'b'.repeat(32), mode: 'api' })).toEqual({
      ...stored,
      baseUrl: 'http://localhost:41800',
      token: 'b'.repeat(32),
    });
    expect(withConnection(stored, { token: '', mode: 'embedded' })).toMatchObject({ baseUrl: 'http://127.0.0.1:41733', mode: 'embedded', yaml: 'learned: yes' });
    expect(withConnection(undefined, { token: 't', mode: 'api' })).toEqual({ token: 't', mode: 'api' });
    const options = readFileSync(resolve(process.cwd(), 'extension/src/options.ts'), 'utf8');
    const handler = (id: string): string => options.slice(options.indexOf(`ui.${id}.addEventListener('click'`), options.indexOf('});', options.indexOf(`ui.${id}.addEventListener('click'`)));
    for (const id of ['test', 'sync']) {
      expect(handler(id)).toContain('await saveConnection();');
      expect(handler(id)).not.toMatch(/await save\(\)/);
    }
  });

  it('the Options YAML box follows a YAML changed elsewhere unless it holds an unsaved edit', () => {
    expect(yamlBoxAfterChange('a', 'a', 'b')).toBe('b');
    expect(yamlBoxAfterChange('edited', 'a', 'b')).toBe('edited');
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

// ---------------------------------------------------------------------------

describe('background: text too large for the server request limit', () => {
  function storeWith(settings: Record<string, unknown>): KeyValueStore {
    const data: Record<string, unknown> = { settings };
    return {
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
      set: async (items) => {
        Object.assign(data, items);
      },
    };
  }
  const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

  // Catches: every debounced keystroke in a composer holding more than the
  // server's 1 MB body limit POSTed the whole text to /normalize, got a 413,
  // dropped the health cache and fell back, so each check cost two requests
  // that could never succeed.
  it('checks text over API_MAX_BODY_BYTES with the embedded lexicon without posting it, and says why', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return json({ ok: true, version: '1', terms: 1 });
      if (url.endsWith('/normalize')) return json({ error: 'request body exceeds 1048576 bytes' }, 413);
      return json({ error: 'nope' }, 404);
    });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: storeWith({ token: 'a'.repeat(64) }), defaultYaml: EXAMPLE_YAML });
    const big = 'ping ashler ' + 'x'.repeat(API_MAX_BODY_BYTES);
    for (const dryRun of [true, false, true]) {
      const reply = (await bg.handle({ type: 'normalize', text: big, dryRun })) as NormalizeReply;
      expect(reply).toMatchObject({ ok: true, mode: 'embedded' });
      expect(reply.ok && reply.replacements[0]).toMatchObject({ original: 'ashler', replacement: 'Ashlr.AI' });
      expect(reply.ok && reply.fallback).toBe(tooLargeForApiMessage(big.length + '{"text":""}'.length + (dryRun ? ',"dryRun":true'.length : 0)));
    }
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/normalize'))).toHaveLength(0);
    // One /health for all three: the size skip never discarded the cache.
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/health'))).toHaveLength(1);
    // Multi-byte text is measured in UTF-8 bytes, as the server counts it.
    const wide = 'é'.repeat(API_MAX_BODY_BYTES / 2);
    expect((await bg.handle({ type: 'normalize', text: wide })) as NormalizeReply).toMatchObject({ ok: true, mode: 'embedded', fallback: expect.stringContaining('1 MB') });
  });

  it('a server that is down is still reported as down for large text, and text under the limit still goes to the API', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const bg = createBackground({ fetch: down as unknown as typeof fetch, store: storeWith({ token: 'a'.repeat(64) }), defaultYaml: EXAMPLE_YAML });
    const reply = (await bg.handle({ type: 'normalize', text: 'x'.repeat(API_MAX_BODY_BYTES + 1) })) as NormalizeReply;
    expect(reply.ok && reply.fallback).toContain('cannot reach lexicon serve');

    const up = vi.fn(async (url: string) =>
      url.endsWith('/health') ? json({ ok: true, version: '1', terms: 1 }) : json({ input: 'hi', output: 'hi', changed: false, replacements: [] }),
    );
    const bg2 = createBackground({ fetch: up as unknown as typeof fetch, store: storeWith({ token: 'a'.repeat(64) }), defaultYaml: EXAMPLE_YAML });
    expect(await bg2.handle({ type: 'normalize', text: 'x'.repeat(API_MAX_BODY_BYTES - 100) })).toMatchObject({ ok: true, mode: 'api' });
  });

  it('the limit mirrors the server', () => {
    expect(API_MAX_BODY_BYTES).toBe(SERVER_MAX_BODY_BYTES);
  });
});

// ---------------------------------------------------------------------------

describe('adapters: code editors are never composers', () => {
  // Catches: with "any site" on, the focused contenteditable or textarea of a
  // code editor (CodeMirror, Monaco, Ace, a contenteditable <pre>, a
  // ProseMirror code block) was taken as the composer, so Enter rewrote code:
  // `const ashler = 1` became `const Ashlr.AI = 1`.
  const editors: Record<string, string> = {
    'CodeMirror 6': '<div class="cm-editor"><div class="cm-scroller"><div id="e" class="cm-content" contenteditable="true"><div class="cm-line">ping ashler</div></div></div></div>',
    'CodeMirror 5': '<div class="CodeMirror"><div><textarea id="e"></textarea></div></div>',
    'Monaco textarea': '<div class="monaco-editor"><div class="overflow-guard"><textarea id="e" class="inputarea"></textarea></div></div>',
    'Monaco EditContext': '<div class="monaco-editor"><div id="e" class="native-edit-context" contenteditable="true">ping ashler</div></div>',
    Ace: '<div class="ace_editor"><textarea id="e" class="ace_text-input"></textarea></div>',
    'contenteditable pre': '<pre id="e" contenteditable="true">ping ashler</pre>',
  };

  for (const [name, html] of Object.entries(editors)) {
    it(`${name}: not a composer on a generic site, and Enter passes through untouched`, async () => {
      document.body.innerHTML = html;
      const e = document.getElementById('e') as HTMLElement;
      if (e.tagName === 'TEXTAREA') (e as HTMLTextAreaElement).value = 'ping ashler';
      e.focus();
      expect(findComposer(document, GENERIC)).toBeNull();
      expect(composerFromTarget(e, GENERIC)).toBeNull();
      const send = vi.fn(fakeSend);
      handle = installContent({ doc: document, hostname: 'example.org', send, settings: { enabled: true, live: true }, liveDebounceMs: 1, precheckDebounceMs: 1 });
      e.dispatchEvent(new Event('input', { bubbles: true }));
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      e.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      await wait(10);
      await handle.idle();
      expect(send).not.toHaveBeenCalled();
      expect(readText(e)).toContain('ashler');
    });
  }

  it('a code editor inside a larger contenteditable page is not taken through its parent', () => {
    document.body.innerHTML =
      '<div id="page" contenteditable="true"><p>notes</p><div class="cm-editor"><div id="e" class="cm-content" contenteditable="true">x</div></div></div>';
    expect(composerFromTarget(document.getElementById('e'), GENERIC)).toBeNull();
    expect(composerFromTarget(document.querySelector('#page p'), GENERIC)).toBeNull();
  });

  // Catches: on a generic site, a rich composer holding a code block was not
  // a composer at all, so the prose around the code was never corrected; the
  // code is masked on its way to the engine instead, as on a known site.
  it('a generic rich composer holding code: the prose around it is corrected on Enter, the code never', async () => {
    document.body.innerHTML =
      '<div id="e" class="ProseMirror" contenteditable="true"><p>ping ashler</p><pre><code>const ashler = 1</code></pre><p id="last">use <code>ashler</code> with ashler</p></div>';
    const e = document.getElementById('e') as HTMLElement;
    e.focus();
    document.getSelection()!.collapse(document.getElementById('last')!.lastChild, ' with ashler'.length);
    expect(findComposer(document, GENERIC)).toBe(e);
    expect(composerFromTarget(e, GENERIC)).toBe(e);
    const send = vi.fn(fakeSend);
    handle = installContent({ doc: document, hostname: 'example.org', send, settings: { enabled: true, live: false } });
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    e.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await handle.idle();
    expect(e.querySelector('p')!.textContent).toBe('ping Ashlr.AI');
    expect(document.getElementById('last')!.textContent).toBe('use ashler with Ashlr.AI');
    expect(e.querySelector('pre code')!.textContent).toBe('const ashler = 1');
    expect(e.querySelector('#last code')!.textContent).toBe('ashler');
    const sent = (send.mock.calls[0][0] as { text: string }).text;
    expect(sent).not.toContain('const');
  });

  it('inline code with the caret in it is skipped; plain rich text and textareas still are composers', () => {
    document.body.innerHTML = '<div id="r" contenteditable="true"><p>ping <code id="c">ashler</code> now</p></div><textarea id="t"></textarea>';
    const r = document.getElementById('r') as HTMLElement;
    r.focus();
    const sel = document.getSelection()!;
    sel.collapse(document.getElementById('c')!.firstChild, 2);
    expect(findComposer(document, GENERIC)).toBeNull();
    // The caret in a code block is typing code too: Enter there is a new line of code, not a send.
    document.body.insertAdjacentHTML('beforeend', '<div id="b" contenteditable="true"><p>ping</p><pre><code id="pc">ashler</code></pre></div>');
    const b = document.getElementById('b') as HTMLElement;
    b.focus();
    sel.collapse(document.getElementById('pc')!.firstChild, 3);
    expect(findComposer(document, GENERIC)).toBeNull();
    expect(composerFromTarget(b, GENERIC)).toBeNull();
    sel.collapse(b.querySelector('p')!.firstChild, 2);
    expect(findComposer(document, GENERIC)).toBe(b);
    r.focus();
    sel.collapse(r.querySelector('p')!.lastChild, 1);
    expect(findComposer(document, GENERIC)).toBe(r);
    (document.getElementById('t') as HTMLElement).focus();
    expect(findComposer(document, GENERIC)?.id).toBe('t');
  });
});

// ---------------------------------------------------------------------------

describe('content: code in a known site\'s composer is never corrected', () => {
  // Catches: on ChatGPT, Claude and the other sites with their own composer
  // selector, a code block or inline code typed into the composer was
  // corrected on send with the prose (`const ashler = 1` became
  // `const Ashlr.AI = 1`): the rich editor holds code as <pre>/<code>, which
  // flattening dropped, so the matcher's own code skipping never saw it.
  const sites: Record<string, { host: string; html: (inner: string) => string; id: string }> = {
    ChatGPT: { host: 'chatgpt.com', id: 'prompt-textarea', html: (inner) => `<div id="prompt-textarea" contenteditable="true" class="ProseMirror">${inner}</div><button data-testid="send-button"></button>` },
    Claude: { host: 'claude.ai', id: 'c', html: (inner) => `<div id="c" contenteditable="true" class="ProseMirror">${inner}</div><button aria-label="Send message"></button>` },
  };

  for (const [name, site] of Object.entries(sites)) {
    it(`${name}: rewrites the prose around a code block and inline code, never the code`, async () => {
      document.body.innerHTML = site.html('<p>ping ashler</p><pre><code>const ashler = 1</code></pre><p>use <code>ashler</code> with ashler</p>');
      const composer = document.getElementById(site.id)!;
      const send = vi.fn(fakeSend);
      handle = installContent({ doc: document, hostname: site.host, send, settings: { enabled: true, live: false } });
      const siteEnter = vi.fn((ev: KeyboardEvent) => ev.preventDefault());
      composer.addEventListener('keydown', siteEnter);
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await handle.idle();
      expect(readText(composer)).toBe('ping Ashlr.AI\nconst ashler = 1\nuse ashler with Ashlr.AI');
      expect(composer.querySelector('pre code')!.textContent).toBe('const ashler = 1');
      expect(composer.querySelector('p code')!.textContent).toBe('ashler');
      expect(siteEnter).toHaveBeenCalledTimes(1);
      // The code never reaches the engine, so the server counts no hit for it.
      const sent = (send.mock.calls[0][0] as { text: string }).text;
      expect(sent).not.toContain('const');
      expect(sent.length).toBe('ping ashler\nconst ashler = 1\nuse ashler with ashler'.length);
    });
  }

  it('a composer whose only match is in code passes Enter through after the precheck', async () => {
    document.body.innerHTML = sites.ChatGPT.html('<p>see</p><pre><code>ashler()</code></pre>');
    const composer = document.getElementById('prompt-textarea')!;
    const send = vi.fn(fakeSend);
    handle = installContent({ doc: document, hostname: 'chatgpt.com', send, settings: { enabled: true, live: false }, precheckDebounceMs: 1 });
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(20);
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    composer.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    await handle.idle();
    expect(readText(composer)).toBe('see\nashler()');
  });
});

describe('pairing with lexicon serve on another --port', () => {
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'extension/manifest.json'), 'utf8')) as {
    host_permissions: string[];
    optional_host_permissions: string[];
    content_scripts: { matches: string[]; js: string[] }[];
  };

  // Catches: the manifest covers port 41733 only, so `lexicon serve --port
  // 5000 --pair` opened a page no content script ran on, and nothing said how
  // to pair with it.
  it('a non-default loopback port needs exactly its two loopback origins, the default port none', () => {
    expect(pairPortOrigins('http://127.0.0.1:41733')).toBeUndefined();
    expect(pairPortOrigins('http://localhost:41733/')).toBeUndefined();
    expect(pairPortOrigins('http://127.0.0.1:5000')).toEqual(['http://127.0.0.1:5000/*', 'http://localhost:5000/*']);
    expect(pairPortOrigins('http://localhost:5000')).toEqual(['http://127.0.0.1:5000/*', 'http://localhost:5000/*']);
    for (const bad of ['http://evil.example:5000', 'https://127.0.0.1:5000', 'http://127.0.0.1', 'http://127.0.0.1:5000/x', 'not a url']) {
      expect(pairPortOrigins(bad), bad).toBeUndefined();
    }
    expect(pairScriptMatches(['http://127.0.0.1:5000/*', 'http://localhost:5000/*'])).toEqual(['http://127.0.0.1:5000/pair*', 'http://localhost:5000/pair*']);
  });

  it('the manifest keeps its fixed permissions to the default port; other ports come from the optional grant', () => {
    expect(manifest.host_permissions.filter((p) => p.startsWith('http://'))).toEqual(['http://127.0.0.1:41733/*', 'http://localhost:41733/*']);
    // permissions.request may only ask for what optional_host_permissions covers.
    expect(manifest.optional_host_permissions).toEqual(['<all_urls>']);
    const pair = manifest.content_scripts.find((c) => c.js.includes('pair.js'))!;
    expect(pair.matches).toEqual(pairScriptMatches(['http://127.0.0.1:41733/*', 'http://localhost:41733/*']));
  });

  // Catches: setPairPort kept one registration under one id, so pairing a
  // third port unregistered the second port's /pair script.
  it('the /pair script stays registered for every paired port and is pruned when its access is removed', async () => {
    const scripts = new Map<string, { id: string; matches?: string[] }>([
      // A registration from the single-id release, for port 5000.
      ['lexicon-pair-port', { id: 'lexicon-pair-port', matches: pairScriptMatches(['http://127.0.0.1:5000/*', 'http://localhost:5000/*']) }],
    ]);
    const granted = new Set(['http://127.0.0.1:5000/*', 'http://localhost:5000/*', 'http://127.0.0.1:6000/*', 'http://localhost:6000/*', 'http://127.0.0.1:7000/*', 'http://localhost:7000/*']);
    const api: PairPortApi = {
      scripting: {
        getRegisteredContentScripts: async (filter) => [...scripts.values()].filter((s) => !filter?.ids || filter.ids.includes(s.id)),
        registerContentScripts: async (list) => {
          for (const s of list) {
            if (scripts.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
            scripts.set(s.id, { id: s.id, matches: s.matches });
          }
        },
        unregisterContentScripts: async (filter) => {
          for (const id of filter?.ids ?? [...scripts.keys()]) scripts.delete(id);
        },
      },
      permissions: { contains: async ({ origins }) => (origins ?? []).every((o) => granted.has(o)) },
    };
    const port = (n: number): string[] => [`http://127.0.0.1:${n}/*`, `http://localhost:${n}/*`];
    await registerPairPort(api, port(6000));
    await registerPairPort(api, port(7000));
    await registerPairPort(api, port(5000));
    // Pairing 6000 again is not a duplicate registration.
    await registerPairPort(api, port(6000));
    const matches = (): string[] => [...scripts.values()].flatMap((s) => s.matches ?? []).sort();
    expect(matches()).toEqual([...pairScriptMatches(port(5000)), ...pairScriptMatches(port(6000)), ...pairScriptMatches(port(7000))].sort());
    // The old single-id registration for 5000 was replaced, not doubled.
    expect(scripts.has('lexicon-pair-port')).toBe(false);
    // The default port needs no script and leaves the others alone.
    await registerPairPort(api, undefined);
    expect(scripts.size).toBe(3);
    // An ungranted port is refused and registers nothing.
    await expect(registerPairPort(api, port(8000))).rejects.toThrow(PAIR_PORT_DENIED_MESSAGE);
    expect(scripts.size).toBe(3);
    // Access to 6000 removed: only its script goes.
    granted.delete('http://localhost:6000/*');
    await prunePairPorts(api);
    expect(matches()).toEqual([...pairScriptMatches(port(5000)), ...pairScriptMatches(port(7000))].sort());
  });

  it('the background registers the /pair script for the port, clears it for the default port, and names a refused permission', async () => {
    const data: Record<string, unknown> = {};
    const store: KeyValueStore = {
      get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
      set: async (items) => {
        Object.assign(data, items);
      },
    };
    const setPairPort = vi.fn(async (_origins: string[] | undefined) => undefined);
    const bg = createBackground({ fetch: vi.fn() as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML, setPairPort });
    expect(await bg.handle({ type: 'pairPort', baseUrl: 'http://127.0.0.1:5000' })).toEqual({ ok: true, origins: ['http://127.0.0.1:5000/*', 'http://localhost:5000/*'] });
    expect(setPairPort).toHaveBeenLastCalledWith(['http://127.0.0.1:5000/*', 'http://localhost:5000/*']);
    expect(await bg.handle({ type: 'pairPort', baseUrl: 'http://127.0.0.1:41733' })).toEqual({ ok: true });
    expect(setPairPort).toHaveBeenLastCalledWith(undefined);
    expect(await bg.handle({ type: 'pairPort', baseUrl: 'http://evil.example:5000' })).toMatchObject({ ok: false, error: expect.stringContaining('127.0.0.1 or localhost') });
    setPairPort.mockRejectedValueOnce(new Error(PAIR_PORT_DENIED_MESSAGE));
    expect(await bg.handle({ type: 'pairPort', baseUrl: 'http://127.0.0.1:5000' })).toEqual({ ok: false, error: PAIR_PORT_DENIED_MESSAGE });
    expect(PAIR_PORT_DENIED_MESSAGE).toContain('Allow');
  });
});

// ---------------------------------------------------------------------------
// Audit: content scripts in shadow DOM, IME composition, site switches
// ---------------------------------------------------------------------------

describe('content: a composer inside an open shadow root', () => {
  // Catches: the capture listeners on the document saw the shadow host as
  // the event target, which is not editable, so a composer inside a web
  // component (any-site mode) was never corrected on Enter, never prechecked
  // on input, and findComposer missed it as the focused element.
  it('corrects a textarea inside a shadow root on Enter, and finds it as the focused composer', async () => {
    const host = document.createElement('chat-box');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<textarea></textarea>';
    const t = root.querySelector('textarea')!;
    t.focus();
    expect(findComposer(document, GENERIC)).toBe(t);
    const send = vi.fn(fakeSend);
    handle = installContent({ doc: document, hostname: 'example.org', send, settings: { enabled: true, live: false }, precheckDebounceMs: 5 });
    t.value = 'ping ashler';
    t.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    await wait(30);
    expect(send).toHaveBeenCalledWith({ type: 'normalize', text: 'ping ashler', dryRun: true });
    const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, composed: true });
    t.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await handle.idle();
    expect(t.value.startsWith('ping Ashlr.AI')).toBe(true);
  });
});

describe('content: IME composition in live mode', () => {
  // Catches: live mode rewrote the composer while an IME composition was
  // still open (input events fire during it), which cancels or garbles the
  // word being composed. It now waits for compositionend.
  it('does not rewrite during a composition, and corrects once it ends', async () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const t = document.getElementById('t') as HTMLTextAreaElement;
    t.focus();
    handle = installContent({ doc: document, hostname: 'example.org', send: vi.fn(fakeSend), settings: { enabled: true, live: true }, liveDebounceMs: 5, precheckDebounceMs: 1000, toastMs: 60_000 });
    t.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }));
    t.value = 'ping ashler';
    t.setSelectionRange(11, 11);
    t.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, isComposing: true }));
    await wait(40);
    expect(t.value).toBe('ping ashler');
    t.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: 'ashler' }));
    await wait(40);
    expect(t.value).toBe('ping Ashlr.AI');
  });

  it('a live check already scheduled does not fire once a composition starts', async () => {
    document.body.innerHTML = '<textarea id="t"></textarea>';
    const t = document.getElementById('t') as HTMLTextAreaElement;
    t.focus();
    const send = vi.fn(fakeSend);
    handle = installContent({ doc: document, hostname: 'example.org', send, settings: { enabled: true, live: true }, liveDebounceMs: 20, precheckDebounceMs: 1000, toastMs: 60_000 });
    t.value = 'ping ashler';
    t.setSelectionRange(11, 11);
    t.dispatchEvent(new Event('input', { bubbles: true }));
    t.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await wait(60);
    expect(t.value).toBe('ping ashler');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('extension: which pages the guard runs on', () => {
  const settings = (anySite: boolean, sites: Record<string, boolean> = {}) => ({ anySite, sites });

  // Catches: the content script read only the per-site switch, so turning
  // "any site" off left every open tab of another site rewriting text until
  // a reload, and the popup said "Corrections run before each send." on a
  // site where no content script runs at all.
  it('runs on a built-in chat site, and elsewhere only with "any site" on', () => {
    expect(builtinPage('https://chatgpt.com/c/1')).toBe(true);
    expect(builtinPage('https://www.perplexity.ai/search')).toBe(true);
    expect(builtinPage('https://x.com/i/grok?focus=1')).toBe(true);
    expect(builtinPage('https://x.com/home')).toBe(false);
    expect(builtinPage('http://chatgpt.com/')).toBe(false);
    expect(builtinPage('not a url')).toBe(false);
    expect(guardActive(settings(false), 'https://claude.ai/new')).toBe(true);
    expect(guardActive(settings(false), 'https://example.org/chat')).toBe(false);
    expect(guardActive(settings(true), 'https://example.org/chat')).toBe(true);
    expect(guardActive(settings(true, { 'example.org': false }), 'https://www.example.org/')).toBe(false);
    expect(guardActive(settings(false, { 'claude.ai': false }), 'https://claude.ai/new')).toBe(false);
  });

  it('the popup line says when the site is not covered', () => {
    expect(siteNote(settings(false), 'https://claude.ai/new')).toBe('Corrections run before each send.');
    expect(siteNote(settings(false), 'https://example.org/')).toContain('turn on "Any site" in Options');
    expect(siteNote(settings(true), 'https://example.org/')).toBe('Corrections run before each send.');
    expect(siteNote(settings(true, { 'example.org': false }), 'https://example.org/')).toBe('Paused on this site.');
  });
});
