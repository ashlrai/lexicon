/**
 * Where and when the composer guard runs, apart from chrome.* so tests can
 * drive it: which frames it covers (`frameScope`) and whether the settings
 * turn it on for the page a frame is part of (`scopeActive`).
 * content.ts wires `bootContent` to chrome.storage and chrome.runtime.
 */
import { builtinPage, guardActive } from './adapters.js';
import { installContent } from './content-core.js';
import type { ContentHandle } from './content-core.js';
import { coerceSettings, siteEnabled } from './shared.js';
import type { NormalizeReply, Request, Settings } from './shared.js';

/** The parts of a window `frameScope` reads. A real `Window` fits. */
export interface FrameWindow {
  readonly location: { readonly href: string; readonly ancestorOrigins?: { readonly length: number; readonly [index: number]: string } };
  readonly top: FrameWindow | null;
}

/**
 * The page a frame's guard judges its settings by. `url` decides the site's
 * adapter and whether the guard runs (`guardActive`); `topUrl`, for a
 * subframe, is the tab's page, whose site switch must be on too (the popup
 * pauses the site of the tab, not of a frame in it).
 */
export interface FrameScope {
  url: string;
  topUrl?: string;
}

/** The top window's href, or undefined when another origin owns it (reading it throws). */
function readableTopHref(win: FrameWindow): string | undefined {
  try {
    const top = win.top;
    if (!top) return undefined;
    const href = top.location.href;
    return typeof href === 'string' && href !== '' ? href : undefined;
  } catch {
    return undefined;
  }
}

/** The tab's origin as the browser reports it to a cross-origin frame (Chromium's `ancestorOrigins`), with a path. */
function ancestorTop(win: FrameWindow): string | undefined {
  const list = win.location.ancestorOrigins;
  if (!list || list.length === 0) return undefined;
  const origin = list[list.length - 1];
  return typeof origin === 'string' && /^https?:\/\//.test(origin) ? `${origin}/` : undefined;
}

/**
 * Whether the guard runs in this frame, and for which page. The top frame
 * always. A subframe only when it is part of the tab's own page (same
 * origin, so the top's URL can be read; an `about:blank` or `blob:` editor
 * frame is judged as that page) or is itself a built-in chat page (a chat
 * embedded in another site). A cross-origin frame of anything else, such as
 * an ad, a payment field or a third-party widget, is left alone.
 */
export function frameScope(win: FrameWindow): FrameScope | null {
  const own = win.location.href;
  let isTop = false;
  try {
    isTop = win.top === null || win.top === win;
  } catch {
    isTop = false;
  }
  if (isTop) return { url: own };
  const topHref = readableTopHref(win);
  if (topHref !== undefined) {
    const local = /^(?:about|blob):/i.test(own);
    return { url: local ? topHref : own, topUrl: topHref };
  }
  if (!builtinPage(own)) return null;
  const ancestor = ancestorTop(win);
  return ancestor !== undefined ? { url: own, topUrl: ancestor } : { url: own };
}

/** `guardActive` for a frame: its page's settings, and the tab's site switch for a subframe. */
export function scopeActive(settings: Pick<Settings, 'sites' | 'anySite'>, scope: FrameScope): boolean {
  if (!guardActive(settings, scope.url)) return false;
  if (scope.topUrl === undefined) return true;
  try {
    return siteEnabled(settings, new URL(scope.topUrl).hostname);
  } catch {
    return false;
  }
}

export interface BootDeps {
  win: Window;
  doc: Document;
  /** The stored settings value (`chrome.storage.local`'s `settings` key). */
  loadSettings(): Promise<unknown>;
  /** Calls `fn` with each new stored settings value. */
  onSettings(fn: (raw: unknown) => void): void;
  send(req: Request): Promise<NormalizeReply>;
  /** Override for tests. */
  frame?: FrameWindow;
}

export interface BootHandle {
  content: ContentHandle;
  scope: FrameScope;
  stop(): void;
}

/** Starts the guard in this frame when `frameScope` covers it, and keeps `enabled` in step with the stored settings. */
export async function bootContent(deps: BootDeps): Promise<BootHandle | undefined> {
  const frame = deps.frame ?? deps.win;
  const first = frameScope(frame);
  if (!first) return undefined;
  const scope = first;
  let settings = coerceSettings(await deps.loadSettings(), '');
  let hostname = '';
  try {
    hostname = new URL(scope.url).hostname;
  } catch {
    // no host: the generic adapter
  }
  const content = installContent({
    doc: deps.doc,
    hostname,
    send: deps.send,
    settings: { enabled: scopeActive(settings, scope), live: settings.live },
  });
  deps.onSettings((raw) => {
    settings = coerceSettings(raw, '');
    content.update({ enabled: scopeActive(settings, scope), live: settings.live });
  });
  return {
    content,
    get scope() {
      return scope;
    },
    stop() {
      content.destroy();
    },
  };
}
