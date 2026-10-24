/**
 * Per-site composer adapters: where the message box and the send button are.
 *
 * Selectors are ordered most-specific first and every entry has a broad
 * fallback, because these apps re-skin their DOM often. `GENERIC` covers any
 * other site: the focused textarea / contenteditable.
 *
 * Verified live (2026-09-19, injected content script, nothing sent):
 * ChatGPT logged-out composer, Grok (Tiptap), Gemini (Quill), Perplexity
 * (Lexical). Assumed from public DOM reports: ChatGPT logged-in
 * `#prompt-textarea` (ProseMirror), Claude.ai, Poe, Copilot (all behind a
 * login wall on that date), Grok on x.com.
 */
import { hostKey, siteEnabled } from './shared.js';
import type { Settings } from './shared.js';

export interface SiteAdapter {
  id: string;
  label: string;
  /** Hostnames (without `www.`) this adapter owns. Empty for the generic one. */
  hosts: string[];
  /** CSS selector for the editable composer. Empty means "the focused editable". */
  editor: string;
  /** CSS selector for the send button. Empty means "none known; re-dispatch Enter". */
  send: string;
}

export const ADAPTERS: readonly SiteAdapter[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    editor: '#prompt-textarea, textarea#mobile-composer-prompt',
    send: 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]',
  },
  {
    id: 'claude',
    label: 'Claude',
    hosts: ['claude.ai'],
    editor: 'div[contenteditable="true"].ProseMirror',
    send: 'button[aria-label="Send message"], button[aria-label="Send Message"]',
  },
  {
    id: 'grok',
    label: 'Grok',
    hosts: ['grok.com'],
    // 2026-09: a Tiptap (ProseMirror) contenteditable inside the form; the
    // textarea selectors are the pre-Tiptap layout, kept as fallbacks.
    editor:
      'form div.tiptap[contenteditable="true"], form div.ProseMirror[contenteditable="true"], div[contenteditable="true"][aria-label*="Grok" i], form textarea, textarea[placeholder*="Grok" i]',
    send: 'button[data-testid="chat-submit"], button[aria-label="Submit"]',
  },
  {
    id: 'grok-x',
    label: 'Grok on X',
    hosts: ['x.com'],
    editor: '',
    send: '',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    hosts: ['gemini.google.com'],
    editor: 'rich-textarea div.ql-editor[contenteditable="true"], div.ql-editor[contenteditable="true"]',
    send: 'button.send-button, button[aria-label="Send message"]',
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    hosts: ['perplexity.ai'],
    editor: '#ask-input[contenteditable="true"], textarea#ask-input, textarea[placeholder*="Ask" i]',
    send: 'button[data-testid="submit-button"], button[aria-label="Submit"]',
  },
  {
    id: 'poe',
    label: 'Poe',
    hosts: ['poe.com'],
    editor: 'textarea[class*="GrowingTextArea"], textarea[placeholder*="Talk" i], textarea[placeholder*="Message" i]',
    send: 'button[class*="SendButton"], button[aria-label="Send message"]',
  },
  {
    id: 'copilot',
    label: 'Copilot',
    hosts: ['copilot.microsoft.com'],
    editor: 'textarea#userInput, textarea[data-testid="composer-input"], textarea[placeholder*="Message" i]',
    send: 'button[data-testid="submit-button"], button[aria-label="Submit message"], button[aria-label="Send"]',
  },
];

export const GENERIC: SiteAdapter = { id: 'generic', label: 'Any site', hosts: [], editor: '', send: '' };

/** Host patterns the static content script is registered for (mirrors manifest.json). */
export const BUILTIN_MATCHES: readonly string[] = [
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://claude.ai/*',
  'https://grok.com/*',
  'https://x.com/i/grok*',
  'https://gemini.google.com/*',
  'https://www.perplexity.ai/*',
  'https://poe.com/*',
  'https://copilot.microsoft.com/*',
];

/**
 * True when `url` is a page the manifest's own content script covers (one of
 * BUILTIN_MATCHES: scheme, exact host, and the path, a trailing `*` matching
 * any rest). Anything else is reached only through the "any site"
 * registration.
 */
export function builtinPage(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return BUILTIN_MATCHES.some((pattern) => {
    const m = /^(https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
    if (!m) return false;
    const [, scheme, host, path] = m;
    if (u.protocol !== `${scheme}:` || u.hostname !== host) return false;
    const rest = u.pathname + u.search;
    return path.endsWith('*') ? rest.startsWith(path.slice(0, -1)) : u.pathname === path;
  });
}

/**
 * Whether the composer guard should run on `url`: its site switch is on, and
 * the page is a built-in chat site or "any site" is on. The content script
 * read only the site switch, so turning "any site" off unregistered the
 * script for new pages while every open tab of another site kept rewriting
 * text until it was reloaded.
 */
export function guardActive(settings: Pick<Settings, 'sites' | 'anySite'>, url: string): boolean {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return siteEnabled(settings, hostname) && (builtinPage(url) || settings.anySite);
}

/**
 * The popup's line under its site switch for the active tab's `url`. It said
 * "Corrections run before each send." on any site with the switch on, also
 * where no content script runs (a site that is not built in, with "any
 * site" off).
 */
export function siteNote(settings: Pick<Settings, 'sites' | 'anySite'>, url: string): string {
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    // no URL: the switch is off below
  }
  if (!hostname || !siteEnabled(settings, hostname)) return 'Paused on this site.';
  if (!guardActive(settings, url)) return 'Not one of the built-in chat sites: turn on "Any site" in Options to correct text here.';
  return 'Corrections run before each send.';
}

/**
 * The focused element, looking through open shadow roots: `doc.activeElement`
 * is the shadow host when focus sits in a field inside one, and the host is
 * not editable, so a composer in a web component was never found.
 */
export function deepActiveElement(doc: Document): Element | null {
  let el: Element | null = doc.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/**
 * The selection that holds the caret in `node`'s tree: inside an open shadow
 * root its own (`ShadowRoot.getSelection`, Chromium), because
 * `document.getSelection()` there is retargeted to the shadow host, so the
 * caret read as outside the composer; else the document's.
 */
export function selectionFor(doc: Document, node: Node): Selection | null {
  const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
  if (root && root !== doc && typeof (root as { getSelection?: unknown }).getSelection === 'function') {
    const sel = (root as unknown as { getSelection(): Selection | null }).getSelection();
    if (sel) return sel;
  }
  return doc.getSelection?.() ?? null;
}

/** The node an event really started at: the first of `composedPath()` (inside an open shadow root), else its target. */
export function eventOrigin(ev: Event): EventTarget | null {
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  return path[0] ?? ev.target;
}

export function adapterFor(hostname: string): SiteAdapter {
  const key = hostKey(hostname);
  return ADAPTERS.find((a) => a.hosts.includes(key)) ?? GENERIC;
}

export function isTextField(el: unknown): el is HTMLTextAreaElement | HTMLInputElement {
  if (!el || typeof el !== 'object') return false;
  const tag = (el as Element).tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return type === 'text' || type === 'search';
  }
  return false;
}

/** `autocomplete` tokens of a field that holds an identifier, never prose to correct. */
const IDENTIFIER_AUTOCOMPLETE = new Set(['username', 'email', 'one-time-code', 'current-password', 'new-password', 'tel', 'url', 'cc-number', 'cc-csc', 'cc-name', 'impp']);

/**
 * A one-line field that holds an identifier rather than dictation: its
 * `autocomplete` names a username, email, code, password, phone, URL or card
 * field, or it sits in a form with a password field (a login form's username
 * box). With "any site" on, Enter in a login form rewrote the username
 * ("ashler" -> "Ashlr.AI") before the form submitted.
 */
export function isIdentifierField(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el.tagName !== 'INPUT') return false;
  const tokens = (el.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
  if (tokens.some((t) => IDENTIFIER_AUTOCOMPLETE.has(t))) return true;
  const form = (el as HTMLInputElement).form;
  return form !== null && form.querySelector('input[type="password" i]') !== null;
}

/**
 * Containers of the code editors that take input through a contenteditable or
 * a hidden textarea: CodeMirror 6 and 5, Monaco, Ace.
 */
export const CODE_EDITOR_SELECTOR = '.cm-editor, .CodeMirror, .monaco-editor, .ace_editor';
/** Any code inside a rich-text composer: a code block, inline `<code>` (or `<kbd>`, `<samp>`, which the matcher skips in text too), or a code editor. */
export const CODE_SELECTOR = `pre, code, kbd, samp, ${CODE_EDITOR_SELECTOR}`;

/**
 * An element that edits code: a `<pre>` or `<code>`, or anything inside a
 * code editor. With "any site" on, the focused editable of CodeMirror,
 * Monaco or Ace was taken as the composer, so Enter rewrote code.
 */
export function isCodeEditor(el: Element): boolean {
  if (el.tagName === 'PRE' || el.tagName === 'CODE') return true;
  return typeof el.closest === 'function' && el.closest(CODE_EDITOR_SELECTOR) !== null;
}

/**
 * True when the generic adapter must leave `root` alone: the caret sits in
 * code (a code block, inline code or a code editor under `root`), where Enter
 * types a new line of code rather than sending, or `root` embeds a code
 * editor. A code block or inline code elsewhere in `root` no
 * longer makes it so: the content script masks every code range on its way
 * to the engine (codeRanges, maskCode), so the prose around the code is
 * corrected and the code never is, as on a known site. It used to skip the
 * whole send whenever `root` held a code block. Known sites name their
 * composer and are not asked.
 */
export function holdsCode(doc: Document, root: HTMLElement): boolean {
  if (isTextField(root)) return false;
  // An embedded code editor (CodeMirror, Monaco, Ace) owns its DOM: a rewrite
  // of the page around it could still replace the editor's nodes.
  if (root.querySelector(CODE_EDITOR_SELECTOR)) return true;
  const anchor = selectionFor(doc, root)?.anchorNode ?? null;
  if (!anchor || !root.contains(anchor)) return false;
  const el = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
  const code = el?.closest(CODE_SELECTOR) ?? null;
  return code !== null && root.contains(code);
}

export function isEditable(el: unknown): el is HTMLElement {
  if (!el || typeof el !== 'object' || !(el as Node).nodeType) return false;
  if ((el as Node).nodeType !== 1) return false;
  if (isCodeEditor(el as Element)) return false;
  if (isTextField(el)) return !(el as HTMLTextAreaElement).readOnly && !(el as HTMLTextAreaElement).disabled && !isIdentifierField(el);
  const h = el as HTMLElement;
  const ce = h.getAttribute('contenteditable');
  return ce === '' || ce === 'true' || ce === 'plaintext-only';
}

function visible(el: Element): boolean {
  const h = el as HTMLElement;
  // jsdom has no layout; offsetParent is null there for everything, so only
  // trust an explicit hidden attribute or inline display:none.
  if (h.hidden) return false;
  if (h.style && h.style.display === 'none') return false;
  return true;
}

/** Walk up from a node to the editable host (the element with contenteditable / the textarea). */
export function editableRoot(node: Node | null): HTMLElement | null {
  let cur: Node | null = node;
  while (cur) {
    // Inside a code editor or code block: its contenteditable parent (a page
    // that embeds the editor) is not the composer either.
    if (cur.nodeType === 1 && isCodeEditor(cur as Element)) return null;
    if (isEditable(cur)) return cur as HTMLElement;
    cur = cur.parentNode;
  }
  return null;
}

/**
 * The composer for this adapter: first visible selector match, else the
 * focused editable when the adapter has no selector (generic sites).
 */
export function findComposer(doc: Document, adapter: SiteAdapter): HTMLElement | null {
  if (adapter.editor) {
    const matches = Array.from(doc.querySelectorAll(adapter.editor)).filter(visible);
    const active = deepActiveElement(doc);
    const focused = matches.find((m) => m === active || m.contains(active));
    const pick = focused ?? matches[0];
    if (pick && isEditable(pick)) return pick;
  }
  const active = editableRoot(deepActiveElement(doc));
  if (active && (!adapter.editor || adapter.id === GENERIC.id) && !(adapter.editor === '' && holdsCode(doc, active))) return active;
  return null;
}

/**
 * The composer that owns an event target, or null when the target is some
 * other editable (editing a previous message, a search box).
 */
export function composerFromTarget(target: EventTarget | null, adapter: SiteAdapter): HTMLElement | null {
  const root = editableRoot(target as Node | null);
  if (!root) return null;
  if (!adapter.editor) return holdsCode(root.ownerDocument, root) ? null : root;
  return root.matches(adapter.editor) ? root : null;
}

export function findSendButton(doc: Document, adapter: SiteAdapter, composer: HTMLElement | null): HTMLElement | null {
  if (!adapter.send) return null;
  const scope: ParentNode = composer?.closest('form') ?? doc;
  const inScope = Array.from(scope.querySelectorAll<HTMLElement>(adapter.send)).filter(visible);
  const candidates = inScope.length ? inScope : Array.from(doc.querySelectorAll<HTMLElement>(adapter.send)).filter(visible);
  return candidates.find((b) => !(b as HTMLButtonElement).disabled) ?? null;
}

export function sendButtonFromTarget(target: EventTarget | null, adapter: SiteAdapter): HTMLElement | null {
  if (!adapter.send || !target || typeof (target as Element).closest !== 'function') return null;
  return (target as Element).closest<HTMLElement>(adapter.send);
}
