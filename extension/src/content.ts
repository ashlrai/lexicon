/// <reference types="chrome" />
/**
 * Content script entry: wires the composer guard to chrome.runtime messaging
 * and chrome.storage. Never sees the API token.
 */
import { installContent } from './content-core.js';
import { sendToBackground } from './chrome-store.js';
import { coerceSettings, siteEnabled, STORAGE_KEYS } from './shared.js';
import type { NormalizeReply, Request } from './shared.js';

declare global {
  interface Window {
    __lexiconExtension?: boolean;
  }
}

if (!window.__lexiconExtension && window === window.top) {
  window.__lexiconExtension = true;

  const hostname = location.hostname;

  void chrome.storage.local.get([STORAGE_KEYS.settings]).then((raw) => {
    const settings = coerceSettings(raw[STORAGE_KEYS.settings], '');
    const handle = installContent({
      doc: document,
      hostname,
      send: (req: Request) => sendToBackground<NormalizeReply>(req),
      settings: { enabled: siteEnabled(settings, hostname), live: settings.live },
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STORAGE_KEYS.settings]) return;
      const next = coerceSettings(changes[STORAGE_KEYS.settings].newValue, '');
      handle.update({ enabled: siteEnabled(next, hostname), live: next.live });
    });
  });
}
