/// <reference types="chrome" />
/**
 * Content script entry: wires the composer guard to chrome.runtime messaging
 * and chrome.storage. Never sees the API token. It runs in every frame the
 * manifest (or the "any site" registration) reaches; `bootContent` decides
 * which frames it covers.
 */
import { bootContent } from './content-boot.js';
import { sendToBackground } from './chrome-store.js';
import { STORAGE_KEYS } from './shared.js';
import type { NormalizeReply, Request } from './shared.js';

declare global {
  interface Window {
    __lexiconExtension?: boolean;
  }
}

if (!window.__lexiconExtension) {
  window.__lexiconExtension = true;

  void bootContent({
    win: window,
    doc: document,
    loadSettings: async () => (await chrome.storage.local.get([STORAGE_KEYS.settings]))[STORAGE_KEYS.settings],
    onSettings: (fn) => {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[STORAGE_KEYS.settings]) return;
        fn(changes[STORAGE_KEYS.settings].newValue);
      });
    },
    send: (req: Request) => sendToBackground<NormalizeReply>(req),
  });
}
