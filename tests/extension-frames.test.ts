// @vitest-environment jsdom
/**
 * Browser extension: which frames the composer guard covers (content-boot.ts
 * frameScope).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootContent, frameScope, scopeActive } from '../extension/src/content-boot.js';
import type { BootHandle, FrameWindow } from '../extension/src/content-boot.js';
import { createEmbedded } from '../extension/src/embedded.js';
import type { NormalizeReply, Request } from '../extension/src/shared.js';

const EXAMPLE_YAML = readFileSync(resolve(process.cwd(), 'examples/lexicon.example.yaml'), 'utf8');
const engine = createEmbedded(EXAMPLE_YAML);

function fakeSend(req: Request): Promise<NormalizeReply> {
  if (req.type !== 'normalize') throw new Error(`unexpected ${req.type}`);
  const r = engine.normalize(req.text, req.dryRun);
  return Promise.resolve({ ok: true, input: r.input, output: r.output, changed: r.changed, replacements: r.replacements, mode: 'embedded' });
}

/** A frame whose top window belongs to another origin: reading its location throws, as in a browser. */
function crossOriginFrame(href: string, ancestors: string[] = []): FrameWindow {
  const top = {
    get location(): { href: string } {
      throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
    },
    top: null,
  } as unknown as FrameWindow;
  const list = Object.assign([...ancestors], { length: ancestors.length });
  return { location: { href, ancestorOrigins: list }, top };
}

function sameOriginFrame(href: string, topHref: string): FrameWindow {
  const top: FrameWindow = { location: { href: topHref }, get top() { return top; } };
  return { location: { href }, top };
}

let booted: BootHandle | undefined;
afterEach(() => {
  booted?.stop();
  booted = undefined;
  document.body.innerHTML = '';
});

describe('extension: composers inside iframes', () => {
  it('the manifest and the "any site" registration reach frames', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'extension/manifest.json'), 'utf8')) as { content_scripts: { js: string[]; all_frames?: boolean; match_about_blank?: boolean }[] };
    const chat = manifest.content_scripts.find((c) => c.js.includes('content.js'));
    expect(chat?.all_frames).toBe(true);
    expect(chat?.match_about_blank).toBe(true);
    expect(readFileSync(resolve(process.cwd(), 'extension/src/background.ts'), 'utf8')).toMatch(/allFrames: true/);
  });

  it('covers the top frame, a same-origin frame and a chat-site frame, and leaves other cross-origin frames alone', () => {
    expect(frameScope(window)).toEqual({ url: window.location.href });
    // An about:blank editor frame is judged as the page it is part of.
    expect(frameScope(sameOriginFrame('about:blank', 'https://example.com/post'))).toEqual({ url: 'https://example.com/post', topUrl: 'https://example.com/post' });
    expect(frameScope(sameOriginFrame('https://example.com/editor', 'https://example.com/post'))).toEqual({ url: 'https://example.com/editor', topUrl: 'https://example.com/post' });
    // A chat embedded in another site: judged as the chat, under the tab's site switch.
    expect(frameScope(crossOriginFrame('https://claude.ai/embed', ['https://example.com']))).toEqual({ url: 'https://claude.ai/embed', topUrl: 'https://example.com/' });
    expect(frameScope(crossOriginFrame('https://claude.ai/embed'))).toEqual({ url: 'https://claude.ai/embed' });
    // An ad, a payment field or a widget from another origin: never.
    expect(frameScope(crossOriginFrame('https://js.stripe.com/v3/elements', ['https://example.com']))).toBeNull();
    expect(frameScope(crossOriginFrame('https://ads.example.net/frame'))).toBeNull();
  });

  it('a frame follows the site switch of the tab it is in', () => {
    const scope = { url: 'https://claude.ai/embed', topUrl: 'https://example.com/' };
    expect(scopeActive({ sites: {}, anySite: false }, scope)).toBe(true);
    expect(scopeActive({ sites: { 'example.com': false }, anySite: false }, scope)).toBe(false);
    expect(scopeActive({ sites: { 'claude.ai': false }, anySite: false }, scope)).toBe(false);
    // A same-origin frame of a site that is not built in needs "any site".
    expect(scopeActive({ sites: {}, anySite: false }, { url: 'https://example.com/post', topUrl: 'https://example.com/post' })).toBe(false);
    expect(scopeActive({ sites: {}, anySite: true }, { url: 'https://example.com/post', topUrl: 'https://example.com/post' })).toBe(true);
  });

  it('corrects a composer inside a same-origin iframe on Enter', async () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const win = iframe.contentWindow as Window;
    const doc = iframe.contentDocument as Document;
    const ta = doc.createElement('textarea');
    doc.body.appendChild(ta);
    ta.value = 'ping ashler about it';
    booted = await bootContent({ win, doc, loadSettings: () => Promise.resolve({ anySite: true }), onSettings: () => undefined, send: fakeSend });
    expect(booted).toBeDefined();
    expect(booted?.content.settings.enabled).toBe(true);
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await booted?.content.idle();
    // The generic Enter then types its newline, as a real Enter would.
    expect(ta.value).toBe('ping Ashlr.AI about it\n');
  });

  it('does not start in a cross-origin frame that is not a chat site', async () => {
    const result = await bootContent({ win: window, doc: document, frame: crossOriginFrame('https://ads.example.net/frame'), loadSettings: () => Promise.resolve({ anySite: true }), onSettings: () => undefined, send: fakeSend });
    expect(result).toBeUndefined();
  });
});
