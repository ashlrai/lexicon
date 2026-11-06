/** Review declarations must reflect actual API payloads, including loopback traffic. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBackground, type KeyValueStore } from '../extension/src/background-core.js';

const root = process.cwd();
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Record<string, unknown>;

describe('Firefox review data disclosure', () => {
  it('builds an accurate declaration without changing the Chromium manifest', async () => {
    execFileSync(process.execPath, ['scripts/build-extension.mjs'], { cwd: root, stdio: 'pipe' });
    const firefox = readJson('extension/dist-firefox/manifest.json');
    const gecko = (firefox.browser_specific_settings as { gecko: Record<string, unknown> }).gecko;
    expect(gecko.data_collection_permissions).toEqual({
      required: ['personalCommunications', 'websiteContent', 'authenticationInfo'],
    });
    expect(Number(String(gecko.strict_min_version).split('.')[0])).toBeGreaterThanOrEqual(140);
    const chromium = readJson('extension/dist/manifest.json');
    const pkg = readJson('package.json');
    expect(chromium).toEqual({ ...readJson('extension/manifest.json'), version: String(pkg.version).replace(/-.*$/, ''), version_name: pkg.version });
    expect(chromium).not.toHaveProperty('browser_specific_settings');

    const data: Record<string, unknown> = { settings: { token: 'a'.repeat(32) } };
    const store: KeyValueStore = {
      async get() { return data; },
      async set(items) { Object.assign(data, items); },
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const body = url.endsWith('/health') ? { ok: true, version: '1.0.0', terms: 1 }
        : url.endsWith('/normalize') ? { input: 'hello', output: 'hello', changed: false, replacements: [] }
        : { term: { canonical: 'Ashlr.AI' }, created: true };
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    const bg = createBackground({ fetch: fetchMock, store, defaultYaml: 'version: 1\nterms: []\n' });
    expect(await bg.handle({ type: 'normalize', text: 'hello' })).toMatchObject({ ok: true, mode: 'api' });
    expect(await bg.handle({ type: 'learn', heard: 'Ashler', meant: 'Ashlr.AI' })).toMatchObject({ ok: true, mode: 'api' });
    const posts = requests.filter(r => r.init?.method === 'POST');
    expect(posts.map(r => [r.url, JSON.parse(String(r.init?.body))])).toEqual([
      ['http://127.0.0.1:41733/normalize', { text: 'hello' }],
      ['http://127.0.0.1:41733/learn', { heard: 'Ashler', meant: 'Ashlr.AI' }],
    ]);
    for (const request of posts) expect(request.init?.headers).toMatchObject({ Authorization: `Bearer ${'a'.repeat(32)}` });
    // Local storage and embedded normalization do not justify declaring "none"
    // for the extension as a whole: API mode above sends all three categories.
    requests.length = 0;
    await bg.saveSettings({ mode: 'embedded' });
    expect(await bg.handle({ type: 'normalize', text: 'hello' })).toMatchObject({ ok: true, mode: 'embedded' });
    expect(requests).toEqual([]);
  });
});
