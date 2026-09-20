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
import { hostKey } from './shared.js';

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

export function isEditable(el: unknown): el is HTMLElement {
  if (!el || typeof el !== 'object' || !(el as Node).nodeType) return false;
  if ((el as Node).nodeType !== 1) return false;
  if (isTextField(el)) return !(el as HTMLTextAreaElement).readOnly && !(el as HTMLTextAreaElement).disabled;
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
    const focused = matches.find((m) => m === doc.activeElement || m.contains(doc.activeElement));
    const pick = focused ?? matches[0];
    if (pick && isEditable(pick)) return pick;
  }
  const active = editableRoot(doc.activeElement);
  if (active && (!adapter.editor || adapter.id === GENERIC.id)) return active;
  return null;
}

/**
 * The composer that owns an event target, or null when the target is some
 * other editable (editing a previous message, a search box).
 */
export function composerFromTarget(target: EventTarget | null, adapter: SiteAdapter): HTMLElement | null {
  const root = editableRoot(target as Node | null);
  if (!root) return null;
  if (!adapter.editor) return root;
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
