/// <reference types="chrome" />
/** Options page: server pairing, mode, live toggle, embedded YAML editor, site list, any-site opt-in. */
import { ADAPTERS } from './adapters.js';
import { sendToBackground } from './chrome-store.js';
import { parseLexicon, parseYaml } from './core.js';
import { coerceSettings, errorMessage, pairUrl, STORAGE_KEYS } from './shared.js';
import type { Failure, Settings, StatusReply, SyncReply } from './shared.js';
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
    ui.yamlOk.textContent = `${lexicon.terms.length} terms, ${lexicon.terms.reduce((n, t) => n + t.aliases.length, 0)} aliases.`;
    return true;
  } catch (err) {
    ui.yamlError.hidden = false;
    ui.yamlError.textContent = errorMessage(err);
    ui.yamlOk.textContent = '';
    return false;
  }
}

function renderSites(): void {
  ui.sites.replaceChildren();
  const known = new Set<string>();
  const rows: { label: string; host: string }[] = [];
  for (const a of ADAPTERS) {
    for (const host of a.hosts) {
      known.add(host);
      rows.push({ label: a.label, host });
    }
  }
  for (const host of Object.keys(settings.sites)) {
    if (!known.has(host)) rows.push({ label: host, host });
  }
  for (const row of rows) {
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
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  settings = next;
  ui.saveMsg.textContent = 'Saved.';
  setTimeout(() => {
    ui.saveMsg.textContent = '';
  }, 1500);
}

ui.save.addEventListener('click', () => void save());
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
    await save();
    const status = await sendToBackground<StatusReply | Failure>({ type: 'status' });
    if (!status.ok) {
      ui.testResult.textContent = status.error;
      return;
    }
    if (status.server) {
      ui.testResult.textContent = `Connected: lexicon ${status.server.version}, ${status.server.terms} terms${status.tokenSet ? '' : ' (no token set; /normalize will fall back to embedded)'}.`;
    } else {
      ui.testResult.textContent = `Unreachable: ${status.serverError ?? 'unknown error'}. Start it with \`lexicon serve\`.`;
    }
  })().catch((err: unknown) => {
    ui.testResult.textContent = errorMessage(err);
  });
});

ui.sync.addEventListener('click', () => {
  ui.sync.disabled = true;
  ui.yamlOk.textContent = 'Syncing...';
  void (async () => {
    await save();
    const reply = await sendToBackground<SyncReply | Failure>({ type: 'sync' });
    if (reply.ok) {
      ui.yaml.value = reply.yaml;
      settings.yaml = reply.yaml;
      validateYaml();
      ui.yamlOk.textContent = `Synced ${reply.terms} terms from the local API.`;
    } else {
      ui.yamlOk.textContent = '';
      ui.yamlError.hidden = false;
      ui.yamlError.textContent = `Sync failed: ${reply.error}`;
    }
  })()
    .catch((err: unknown) => {
      ui.yamlError.hidden = false;
      ui.yamlError.textContent = `Sync failed: ${errorMessage(err)}`;
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
        ui.anySiteMsg.textContent = 'Permission not granted.';
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
      ui.anySiteMsg.textContent = reply.error;
    }
  })().catch((err: unknown) => {
    ui.anySiteMsg.textContent = errorMessage(err);
  });
});

// Pairing happens in another tab (the /pair page); reflect it here without a reload.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEYS.settings]) return;
  const next = coerceSettings(changes[STORAGE_KEYS.settings].newValue, defaultYaml);
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
  const raw = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  settings = coerceSettings(raw[STORAGE_KEYS.settings], defaultYaml);
  render();
})();
