/// <reference types="chrome" />
/** Popup: engine status, per-site switch, recent corrections, "learn" mini-form. */
import { sendToBackground } from './chrome-store.js';
import { siteNote } from './adapters.js';
import { setMessage } from './rich-text.js';
import { coerceSettings, describeCorrection, hostKey, siteEnabled, statusFailedView, statusView, STORAGE_KEYS, withSiteSwitch } from './shared.js';
import type { Failure, LearnReply, StatusReply } from './shared.js';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`popup: missing #${id}`);
  return el as T;
}

const ui = {
  mode: $<HTMLSpanElement>('mode'),
  server: $<HTMLParagraphElement>('server'),
  siteHost: $<HTMLSpanElement>('site-host'),
  siteEnabled: $<HTMLInputElement>('site-enabled'),
  siteNote: $<HTMLParagraphElement>('site-note'),
  recent: $<HTMLUListElement>('recent'),
  learn: $<HTMLFormElement>('learn'),
  meant: $<HTMLInputElement>('meant'),
  heard: $<HTMLInputElement>('heard'),
  learnMsg: $<HTMLSpanElement>('learn-msg'),
  openOptions: $<HTMLButtonElement>('open-options'),
};

let currentHost = '';
let currentUrl = '';

async function activeUrl(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && new URL(tab.url).hostname) return tab.url;
  } catch {
    // no tabs permission for this URL; fine
  }
  return '';
}

function renderStatus(s: StatusReply): void {
  const view = statusView(s);
  ui.mode.textContent = view.mode;
  ui.mode.className = view.warn ? 'pill warn' : 'pill';
  setMessage(ui.server, view.line);

  ui.recent.replaceChildren();
  if (s.recent.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'None yet.';
    ui.recent.appendChild(li);
  }
  for (const c of s.recent) {
    const li = document.createElement('li');
    li.setAttribute('aria-label', describeCorrection(c));
    const from = document.createElement('span');
    from.className = 'from';
    from.textContent = c.original;
    const arrow = document.createElement('span');
    arrow.className = 'muted';
    arrow.textContent = '→';
    const to = document.createElement('span');
    to.className = 'to';
    to.textContent = c.replacement;
    li.append(from, arrow, to);
    ui.recent.appendChild(li);
  }
}

async function refresh(): Promise<void> {
  try {
    const status = await sendToBackground<StatusReply | Failure>({ type: 'status' });
    if (status.ok) renderStatus(status);
    else renderStatusFailure(status.error);
  } catch (err) {
    renderStatusFailure(err instanceof Error ? err.message : String(err));
  }
}

function renderStatusFailure(error: string): void {
  const view = statusFailedView(error);
  ui.mode.textContent = view.mode;
  ui.mode.className = 'pill warn';
  setMessage(ui.server, view.line);
}

async function loadSite(): Promise<void> {
  currentUrl = await activeUrl();
  currentHost = currentUrl ? new URL(currentUrl).hostname : '';
  const raw = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const settings = coerceSettings(raw[STORAGE_KEYS.settings], '');
  if (!currentHost) {
    ui.siteHost.textContent = '';
    ui.siteEnabled.disabled = true;
    ui.siteNote.textContent = 'Open a chat site to toggle it here.';
    return;
  }
  ui.siteHost.textContent = hostKey(currentHost);
  ui.siteEnabled.checked = siteEnabled(settings, currentHost);
  ui.siteNote.textContent = siteNote(settings, currentUrl);
}

ui.siteEnabled.addEventListener('change', () => {
  void (async () => {
    const raw = await chrome.storage.local.get([STORAGE_KEYS.settings]);
    const next = withSiteSwitch(raw[STORAGE_KEYS.settings], currentHost, ui.siteEnabled.checked);
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
    ui.siteNote.textContent = siteNote(coerceSettings(next, ''), currentUrl);
  })();
});

ui.learn.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const meant = ui.meant.value.trim();
  const heard = ui.heard.value.trim();
  if (!meant || !heard) return;
  ui.learnMsg.textContent = 'Learning...';
  void sendToBackground<LearnReply | Failure>({ type: 'learn', heard, meant })
    .then((reply) => {
      if (reply.ok) {
        setMessage(ui.learnMsg, `${reply.message} (${reply.mode === 'api' ? 'server' : 'embedded'})`);
        ui.meant.value = '';
        ui.heard.value = '';
        void refresh();
      } else {
        setMessage(ui.learnMsg, reply.error);
      }
    })
    .catch((err: unknown) => {
      setMessage(ui.learnMsg, err instanceof Error ? err.message : String(err));
    });
});

ui.openOptions.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

void loadSite();
void refresh();
