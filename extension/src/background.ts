/// <reference types="chrome" />
/**
 * MV3 service worker (module). Holds the API token, does every fetch, and
 * answers the content script, popup and options page.
 */
import { BUILTIN_MATCHES } from './adapters.js';
import { createBackground } from './background-core.js';
import { chromeStore } from './chrome-store.js';
import defaultYaml from '../../examples/lexicon.example.yaml';
import type { Request } from './shared.js';

const ANY_SITE_SCRIPT_ID = 'lexicon-any-site';

async function setAnySite(enabled: boolean): Promise<void> {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [ANY_SITE_SCRIPT_ID] });
  if (!enabled) {
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [ANY_SITE_SCRIPT_ID] });
    return;
  }
  const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  if (!granted) throw new Error('The "any site" permission was not granted.');
  if (registered.length) return;
  await chrome.scripting.registerContentScripts([
    {
      id: ANY_SITE_SCRIPT_ID,
      matches: ['<all_urls>'],
      excludeMatches: [...BUILTIN_MATCHES],
      js: ['content.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

const background = createBackground({
  fetch: (input, init) => fetch(input, init),
  store: chromeStore,
  defaultYaml,
  setAnySite,
});

chrome.runtime.onMessage.addListener((msg: Request, sender, sendResponse) => {
  // Only our own pages and content scripts may talk to the worker.
  if (sender.id !== chrome.runtime.id) return false;
  background
    .handle(msg)
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
}
chrome.runtime.onInstalled.addListener(() => void reconcileAnySite());
chrome.runtime.onStartup?.addListener(() => void reconcileAnySite());
chrome.permissions?.onRemoved?.addListener(() => void reconcileAnySite());
