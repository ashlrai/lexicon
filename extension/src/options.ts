/// <reference types="chrome" />
/** Options page: server pairing, mode, live toggle, embedded YAML editor, site list, any-site opt-in. */
import { siteRows } from './adapters.js';
import { sendToBackground } from './chrome-store.js';
import { setMessage } from './rich-text.js';
import { parseLexicon, parseYaml } from './core.js';
import { ANY_SITE_DENIED_MESSAGE, coerceHostList, coerceSettings, connectionTestLine, countOf, errorMessage, extensionRequestFailedLine, pairPortOrigins, pairUrl, PAIR_PORT_DENIED_MESSAGE, sitesAfterChange, syncedLine, STORAGE_KEYS, storageWriteFailedLine, withConnection, yamlBoxAfterChange } from './shared.js';
import type { Failure, PairPortReply, Settings, StatusReply, SyncReply } from './shared.js';
import defaultYaml from '../../examples/lexicon.example.yaml';

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`options: missing #${id}`);
  return el as T;
}

const ui = {
  version: $<HTMLSpanElement>('version'),
  pairState: $<HTMLParagraphElement>('pair-state'),
  pairLink: $<HTMLAnchorElement>('pair-link'),
  baseUrl: $<HTMLInputElement>('baseUrl'),
  token: $<HTMLInputElement>('token'),
  toggleToken: $<HTMLButtonElement>('toggle-token'),
  test: $<HTMLButtonElement>('test'),
  testResult: $<HTMLSpanElement>('test-result'),
  live: $<HTMLInputElement>('live'),
  sync: $<HTMLButtonElement>('sync'),
  resetYaml: $<HTMLButtonElement>('reset-yaml'),
  yaml: $<HTMLTextAreaElement>('yaml'),
  yamlError: $<HTMLPreElement>('yaml-error'),
  yamlOk: $<HTMLParagraphElement>('yaml-ok'),
  sites: $<HTMLUListElement>('sites'),
  anySite: $<HTMLInputElement>('anySite'),
  anySiteMsg: $<HTMLParagraphElement>('anySite-msg'),
  save: $<HTMLButtonElement>('save'),
  saveMsg: $<HTMLSpanElement>('save-msg'),
};

let settings: Settings;

function modeInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]'));
}

function validateYaml(): boolean {
  try {
    const lexicon = parseLexicon(parseYaml(ui.yaml.value, { prettyErrors: true }));
    ui.yamlError.hidden = true;
    ui.yamlError.textContent = '';
    ui.yamlOk.textContent = `${countOf(lexicon.terms.length, 'term')}, ${countOf(lexicon.terms.reduce((n, t) => n + t.aliases.length, 0), 'alias', 'aliases')}.`;
    return true;
  } catch (err) {
    ui.yamlError.hidden = false;
    ui.yamlError.textContent = errorMessage(err);
    ui.yamlOk.textContent = '';
    return false;
  }
}

/** Hosts the guard ran on through "Any site" (STORAGE_KEYS.anySiteHosts). */
let anySiteHosts: string[] = [];

function renderSites(): void {
  ui.sites.replaceChildren();
  for (const row of siteRows(settings.sites, anySiteHosts)) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = settings.sites[row.host] !== false;
    box.dataset.host = row.host;
    box.addEventListener('change', () => {
      settings.sites[row.host] = box.checked;
    });
    const name = document.createElement('span');
    name.textContent = row.label;
    const host = document.createElement('span');
    host.className = 'host';
    host.textContent = row.host;
    label.append(box, name, host);
    li.appendChild(label);
    ui.sites.appendChild(li);
  }
}

/** "Paired" when a token is stored; the link always points at the current base URL's /pair. */
function renderPairState(): void {
  ui.pairLink.href = pairUrl(ui.baseUrl.value.trim() || settings.baseUrl);
  if (settings.token) {
    ui.pairState.textContent = `Paired with ${settings.baseUrl} (token stored).`;
    ui.pairState.className = 'pair-state ok';
    ui.pairLink.textContent = 'pair again';
  } else {
    ui.pairState.textContent = 'Not paired: no token stored.';
    ui.pairState.className = 'pair-state warn';
    ui.pairLink.textContent = 'pair in this browser';
  }
}

function render(): void {
  ui.baseUrl.value = settings.baseUrl;
  ui.token.value = settings.token;
  renderPairState();
  for (const input of modeInputs()) input.checked = input.value === settings.mode;
  ui.live.checked = settings.live;
  ui.yaml.value = settings.yaml;
  ui.anySite.checked = settings.anySite;
  renderSites();
  validateYaml();
}

function collect(): Partial<Settings> {
  const mode = modeInputs().find((i) => i.checked)?.value === 'embedded' ? 'embedded' : 'api';
  return {
    baseUrl: ui.baseUrl.value.trim() || undefined,
    token: ui.token.value.trim(),
    mode,
    live: ui.live.checked,
    yaml: ui.yaml.value,
    sites: settings.sites,
  };
}

async function save(): Promise<void> {
  if (!validateYaml()) {
    ui.saveMsg.textContent = 'Fix the YAML before saving.';
    return;
  }
  const next = coerceSettings({ ...settings, ...collect() }, defaultYaml);
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  } catch (err) {
    setMessage(ui.saveMsg, storageWriteFailedLine(errorMessage(err)));
    return;
  }
  settings = next;
  ui.saveMsg.textContent = 'Saved.';
  setTimeout(() => {
    ui.saveMsg.textContent = '';
  }, 1500);
}

/**
 * Store the base URL, token and mode on screen, and nothing else (see
 * withConnection): what Test connection and Sync need the background to use.
 */
async function saveConnection(): Promise<void> {
  const form = collect();
  const raw = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const merged = withConnection(raw[STORAGE_KEYS.settings], { baseUrl: form.baseUrl, token: form.token ?? '', mode: form.mode ?? 'api' });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: merged });
  const next = coerceSettings(merged, defaultYaml);
  settings = { ...settings, baseUrl: next.baseUrl, token: next.token, mode: next.mode };
}

ui.save.addEventListener('click', () => void save());

// The manifest runs the pairing script on port 41733 only. For a `lexicon
// serve --port` other than that, ask for the port's loopback origins (inside
// this click, as the browser requires), have the worker run the script there,
// then open the page.
ui.pairLink.addEventListener('click', (ev) => {
  const baseUrl = ui.baseUrl.value.trim() || settings.baseUrl;
  const origins = pairPortOrigins(baseUrl);
  if (!origins) return;
  ev.preventDefault();
  const url = ui.pairLink.href;
  const fail = (message: string): void => {
    ui.pairState.className = 'pair-state warn';
    setMessage(ui.pairState, message);
  };
  void (async () => {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) return fail(PAIR_PORT_DENIED_MESSAGE);
    // The pairing itself stores this base URL with the token.
    const reply = await sendToBackground<PairPortReply | Failure>({ type: 'pairPort', baseUrl });
    if (!reply.ok) return fail(reply.error);
    await chrome.tabs.create({ url });
  })().catch((err: unknown) => fail(extensionRequestFailedLine(errorMessage(err))));
});
ui.yaml.addEventListener('input', () => void validateYaml());
ui.baseUrl.addEventListener('input', () => renderPairState());
ui.toggleToken.addEventListener('click', () => {
  const show = ui.token.type === 'password';
  ui.token.type = show ? 'text' : 'password';
  ui.toggleToken.textContent = show ? 'Hide' : 'Show';
});
ui.resetYaml.addEventListener('click', () => {
  ui.yaml.value = defaultYaml;
  validateYaml();
});

ui.test.addEventListener('click', () => {
  ui.testResult.textContent = 'Testing...';
  void (async () => {
    // Save the URL/token first so the background tests what is on screen.
    await saveConnection();
    // probe: a button press asks the server even while a rejected token is backed off.
    const status = await sendToBackground<StatusReply | Failure>({ type: 'status', probe: true });
    if (!status.ok) {
      setMessage(ui.testResult, status.error);
      return;
    }
    setMessage(ui.testResult, connectionTestLine(status));
  })().catch((err: unknown) => {
    setMessage(ui.testResult, extensionRequestFailedLine(errorMessage(err)));
  });
});

ui.sync.addEventListener('click', () => {
  ui.sync.disabled = true;
  ui.yamlOk.textContent = 'Syncing...';
  void (async () => {
    await saveConnection();
    const reply = await sendToBackground<SyncReply | Failure>({ type: 'sync' });
    if (reply.ok) {
      ui.yaml.value = reply.yaml;
      settings.yaml = reply.yaml;
      validateYaml();
      setMessage(ui.yamlOk, syncedLine(reply));
    } else {
      ui.yamlOk.textContent = '';
      ui.yamlError.hidden = false;
      setMessage(ui.yamlError, `Sync failed: ${reply.error}`);
    }
  })()
    .catch((err: unknown) => {
      ui.yamlError.hidden = false;
      setMessage(ui.yamlError, `Sync failed: ${extensionRequestFailedLine(errorMessage(err))}`);
    })
    .finally(() => {
      ui.sync.disabled = false;
    });
});

ui.anySite.addEventListener('change', () => {
  void (async () => {
    if (ui.anySite.checked) {
      // Must run inside the user gesture.
      const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
      if (!granted) {
        ui.anySite.checked = false;
        ui.anySiteMsg.textContent = ANY_SITE_DENIED_MESSAGE;
        return;
      }
    } else {
      try {
        await chrome.permissions.remove({ origins: ['<all_urls>'] });
      } catch {
        // Some browsers refuse to drop optional origins; the registration is removed anyway.
      }
    }
    const reply = await sendToBackground<{ ok: true } | Failure>({ type: 'anySite', enabled: ui.anySite.checked });
    if (reply.ok) {
      settings.anySite = ui.anySite.checked;
      ui.anySiteMsg.textContent = ui.anySite.checked ? 'Enabled on every site (focused text box).' : 'Limited to the listed chat sites.';
    } else {
      ui.anySite.checked = !ui.anySite.checked;
      setMessage(ui.anySiteMsg, reply.error);
    }
  })().catch((err: unknown) => {
    setMessage(ui.anySiteMsg, extensionRequestFailedLine(errorMessage(err)));
  });
});

// Pairing happens in another tab (the /pair page); reflect it here without a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEYS.settings]) return;
  const next = coerceSettings(changes[STORAGE_KEYS.settings].newValue, defaultYaml);
  // A Learn in the popup (embedded mode) changed the YAML: show it unless the box holds an unsaved edit.
  if (next.yaml !== settings.yaml) {
    ui.yaml.value = yamlBoxAfterChange(ui.yaml.value, settings.yaml, next.yaml);
    settings.yaml = next.yaml;
    validateYaml();
  }
  // A site the popup paused or resumed: follow it, keeping this page's unsaved switches, so Save does not undo it.
  const sites = sitesAfterChange(settings.sites, coerceSettings(changes[STORAGE_KEYS.settings].oldValue, defaultYaml).sites, next.sites);
  if (JSON.stringify(sites) !== JSON.stringify(settings.sites)) {
    settings.sites = sites;
    renderSites();
  }
  if (next.token === settings.token && next.baseUrl === settings.baseUrl && next.mode === settings.mode) return;
  settings = { ...settings, token: next.token, baseUrl: next.baseUrl, mode: next.mode };
  ui.baseUrl.value = settings.baseUrl;
  ui.token.value = settings.token;
  for (const input of modeInputs()) input.checked = input.value === settings.mode;
  renderPairState();
  ui.saveMsg.textContent = settings.token ? 'Paired.' : '';
});

void (async () => {
  ui.version.textContent = `v${chrome.runtime.getManifest().version}`;
  const raw = await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.anySiteHosts]);
  settings = coerceSettings(raw[STORAGE_KEYS.settings], defaultYaml);
  anySiteHosts = coerceHostList(raw[STORAGE_KEYS.anySiteHosts]);
  render();
})();
