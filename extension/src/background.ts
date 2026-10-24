/// <reference types="chrome" />
/**
 * MV3 service worker (module). Holds the API token, does every fetch, and
 * answers the content script, popup and options page.
 */
import { setAnySite as setAnySiteWith } from './any-site.js';
import type { AnySiteApi } from './any-site.js';
import { createBackground } from './background-core.js';
import { chromeStore } from './chrome-store.js';
import defaultYaml from '../../examples/lexicon.example.yaml';
import { prunePairPorts, registerPairPort } from './pair-port.js';
import type { PairPortApi } from './pair-port.js';
import type { Request } from './shared.js';

/** `chrome.scripting` and `chrome.permissions` as any-site.ts takes them, with storage to remember a refused key in. */
const anySiteApi: AnySiteApi = { scripting: chrome.scripting, permissions: chrome.permissions, store: chromeStore, browser: navigator.userAgent };

function setAnySite(enabled: boolean): Promise<void> {
  return setAnySiteWith(anySiteApi, enabled);
}

/** `chrome.scripting` and `chrome.permissions` as pair-port.ts takes them. */
const pairPortApi: PairPortApi = { scripting: chrome.scripting, permissions: chrome.permissions };

/**
 * `pair.js` on the /pair page of a `lexicon serve --port` other than the
 * default (the manifest's content script covers 41733 only), one
 * registration per port (see pair-port.ts). Options asks for the port's two
 * loopback origins first, inside the click.
 */
function setPairPort(origins: string[] | undefined): Promise<void> {
  return registerPairPort(pairPortApi, origins);
}

const background = createBackground({
  fetch: (input, init) => fetch(input, init),
  store: chromeStore,
  defaultYaml,
  setAnySite,
  setPairPort,
});

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse) => {
  // Only our own pages and content scripts may talk to the worker.
  if (sender.id !== chrome.runtime.id) return false;
  background
    .handle(msg, { url: sender.tab?.url ?? sender.url })
    .then(sendResponse)
    .catch((err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true;
});

// Keep the dynamic "any site" registration in step with the stored toggle.
async function reconcileAnySite(): Promise<void> {
  try {
    const settings = await background.getSettings();
    await setAnySite(settings.anySite);
  } catch {
    // Permission revoked by the user: leave the toggle for the options page to reflect.
  }
  try {
    // Access to a port revoked: stop the /pair script there (Options asks again).
    await prunePairPorts(pairPortApi);
  } catch {
    // Nothing registered, or the scripting API is unavailable: nothing to undo.
  }
}
chrome.runtime.onInstalled.addListener(() => void reconcileAnySite());
chrome.runtime.onStartup?.addListener(() => void reconcileAnySite());
chrome.permissions?.onRemoved?.addListener(() => void reconcileAnySite());
