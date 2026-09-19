/// <reference types="chrome" />
/** chrome.storage.local wrapped in the KeyValueStore the background core expects. */
import type { KeyValueStore } from './background-core.js';

export const chromeStore: KeyValueStore = {
  get: (keys) => chrome.storage.local.get(keys) as Promise<Record<string, unknown>>,
  set: (items) => chrome.storage.local.set(items),
};

/** Promise wrapper around runtime.sendMessage that surfaces lastError. */
export function sendToBackground<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (reply: T) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message ?? 'extension messaging failed'));
        else resolve(reply);
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
