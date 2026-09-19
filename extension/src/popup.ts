/// <reference types="chrome" />
/** Popup: engine status, per-site switch, recent corrections, "learn" mini-form. */
import { sendToBackground } from './chrome-store.js';
import { coerceSettings, describeCorrection, hostKey, siteEnabled, STORAGE_KEYS } from './shared.js';
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

async function activeHostname(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) return new URL(tab.url).hostname;
  } catch {
    // no tabs permission for this URL; fine
  }
  return '';
}

function renderStatus(s: StatusReply): void {
  if (s.activeMode === 'api' && s.server) {
    ui.mode.textContent = 'Local API';
    ui.mode.className = 'pill';
    ui.server.textContent = `lexicon ${s.server.version}, ${s.server.terms} terms`;
  } else {
    ui.mode.textContent = s.configuredMode === 'embedded' ? 'Embedded' : 'Embedded (fallback)';
    ui.mode.className = s.configuredMode === 'embedded' ? 'pill' : 'pill warn';
    const parts: string[] = [`${s.embeddedTerms} embedded terms`];
    if (s.configuredMode === 'api') parts.push(s.serverError ? `server: ${s.serverError}` : 'server unreachable');
    if (!s.tokenSet && s.configuredMode === 'api') parts.push('no token set');
    if (s.embeddedError) parts.push('embedded YAML has errors');
    ui.server.textContent = parts.join(' · ');
  }

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
    else {
      ui.mode.textContent = 'Error';
      ui.mode.className = 'pill warn';
      ui.server.textContent = status.error;
    }
  } catch (err) {
    ui.mode.textContent = 'Error';
    ui.mode.className = 'pill warn';
    ui.server.textContent = err instanceof Error ? err.message : String(err);
  }
}

async function loadSite(): Promise<void> {
  currentHost = await activeHostname();
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
  ui.siteNote.textContent = ui.siteEnabled.checked ? 'Corrections run before each send.' : 'Paused on this site.';
}

ui.siteEnabled.addEventListener('change', () => {
  void (async () => {
    const raw = await chrome.storage.local.get([STORAGE_KEYS.settings]);
    const settings = coerceSettings(raw[STORAGE_KEYS.settings], '');
    settings.sites[hostKey(currentHost)] = ui.siteEnabled.checked;
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    ui.siteNote.textContent = ui.siteEnabled.checked ? 'Corrections run before each send.' : 'Paused on this site.';
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
        ui.learnMsg.textContent = `${reply.message} (${reply.mode === 'api' ? 'server' : 'embedded'})`;
        ui.meant.value = '';
        ui.heard.value = '';
        void refresh();
      } else {
        ui.learnMsg.textContent = reply.error;
      }
    })
    .catch((err: unknown) => {
      ui.learnMsg.textContent = err instanceof Error ? err.message : String(err);
    });
});

ui.openOptions.addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

void loadSite();
void refresh();
