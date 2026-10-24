// @vitest-environment jsdom
/// <reference path="../extension/src/modules.d.ts" />
/**
 * Options' Save and the popup's site switch when the browser refuses the
 * settings write (chrome.storage.local.set rejects, as over its quota). The
 * pages are loaded as they ship, against their own HTML and a mocked chrome.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function loadBody(page: string): void {
  const html = readFileSync(resolve(process.cwd(), `extension/static/${page}`), 'utf8');
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
}

function mockChrome(set: () => Promise<void>): void {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      id: 'ext-test',
      lastError: undefined,
      getManifest: () => ({ version: '0.0.0' }),
      sendMessage: (_msg: unknown, cb: (r: unknown) => void) => cb({ ok: false, error: 'not in this test' }),
      openOptionsPage: () => undefined,
    },
    tabs: { query: async () => [{ url: 'https://chatgpt.com/c/1' }], create: async () => undefined },
    permissions: { request: async () => true, remove: async () => true },
    storage: {
      local: { get: async () => ({}), set },
      onChanged: { addListener: () => undefined },
    },
  };
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  document.body.innerHTML = '';
  vi.resetModules();
});

describe('a refused settings write is shown', () => {
  // Catches: the rejected write was not caught, so Save said nothing (no
  // "Saved.", no error) and the settings were silently not stored.
  it('Options Save says the settings were not saved and why', async () => {
    loadBody('options.html');
    mockChrome(() => Promise.reject(new Error('QUOTA_BYTES quota exceeded')));
    await import('../extension/src/options.js');
    await flush();
    (document.getElementById('save') as HTMLButtonElement).click();
    await flush();
    const msg = document.getElementById('save-msg')!.textContent ?? '';
    expect(msg).toContain('Not saved: QUOTA_BYTES quota exceeded.');
    expect(msg).not.toContain('Saved.');
  });

  // Catches: the switch stayed flipped although nothing was stored, so the
  // popup showed a site paused that was still corrected (or the reverse).
  it('the popup puts the site switch back and says why', async () => {
    loadBody('popup.html');
    mockChrome(() => Promise.reject(new Error('QUOTA_BYTES quota exceeded')));
    await import('../extension/src/popup.js');
    await flush();
    const box = document.getElementById('site-enabled') as HTMLInputElement;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await flush();
    expect(box.checked).toBe(true);
    expect(document.getElementById('site-note')!.textContent).toContain('Not saved: QUOTA_BYTES quota exceeded.');
  });
});
