/**
 * Browser extension: a site reached through "Any site" is listed in Options
 * with its switch (adapters.ts siteRows, the background's anySiteHosts list).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADAPTERS, siteRows } from '../extension/src/adapters.js';
import { createBackground } from '../extension/src/background-core.js';
import type { KeyValueStore } from '../extension/src/background-core.js';
import { ANY_SITE_HOSTS_LIMIT, STORAGE_KEYS, coerceHostList } from '../extension/src/shared.js';

const EXAMPLE_YAML = readFileSync(resolve(process.cwd(), 'examples/lexicon.example.yaml'), 'utf8');

function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore & { data: Record<string, unknown>; writes: number } {
  const data = { ...initial };
  const store = {
    data,
    writes: 0,
    get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    set: async (items: Record<string, unknown>) => {
      store.writes++;
      Object.assign(data, items);
    },
  };
  return store;
}

function background(store: KeyValueStore) {
  return createBackground({ fetch: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });
}

describe('Options lists a site reached through "Any site"', () => {
  it('siteRows lists built-in sites, stored switches, then hosts seen through "Any site", once each', () => {
    const rows = siteRows({ 'notes.example.com': false, 'claude.ai': true }, ['docs.example.org', 'notes.example.com', 'chatgpt.com']);
    const builtIn = ADAPTERS.flatMap((a) => a.hosts);
    expect(rows.slice(0, builtIn.length).map((r) => r.host)).toEqual(builtIn);
    expect(rows.slice(builtIn.length)).toEqual([
      { label: 'notes.example.com', host: 'notes.example.com', anySite: true },
      { label: 'docs.example.org', host: 'docs.example.org', anySite: true },
    ]);
  });

  it('the background remembers the tab host of a check on a page that is not built in', async () => {
    const store = memoryStore({ [STORAGE_KEYS.settings]: { mode: 'embedded' } });
    const bg = background(store);
    await bg.handle({ type: 'normalize', text: 'ping ashler', dryRun: true }, { url: 'https://www.Docs.Example.org/page?q=1' });
    await bg.handle({ type: 'normalize', text: 'ping ashler' }, { url: 'https://chatgpt.com/c/1' });
    await bg.handle({ type: 'normalize', text: 'ping ashler' }, { url: 'https://x.com/i/grok' });
    await bg.handle({ type: 'normalize', text: 'ping ashler' }, { url: 'chrome-extension://abc/options.html' });
    await bg.handle({ type: 'normalize', text: 'ping ashler' });
    expect(store.data[STORAGE_KEYS.anySiteHosts]).toEqual(['docs.example.org']);
    await bg.handle({ type: 'normalize', text: 'ping ashler' }, { url: 'http://localhost:3000/app' });
    expect(store.data[STORAGE_KEYS.anySiteHosts]).toEqual(['localhost', 'docs.example.org']);
    // A host already remembered is not written again on every check.
    const writes = store.writes;
    for (let i = 0; i < 5; i++) await bg.handle({ type: 'normalize', text: 'ping', dryRun: true }, { url: 'https://docs.example.org/x' });
    expect(store.writes).toBe(writes);
    expect(siteRows({}, coerceHostList(store.data[STORAGE_KEYS.anySiteHosts])).filter((r) => r.anySite).map((r) => r.host)).toEqual(['localhost', 'docs.example.org']);
  });

  it('keeps the list bounded and drops entries that are not hosts', () => {
    const many = Array.from({ length: ANY_SITE_HOSTS_LIMIT + 10 }, (_, i) => `h${i}.example.com`);
    expect(coerceHostList(many)).toHaveLength(ANY_SITE_HOSTS_LIMIT);
    expect(coerceHostList(['ok.example.com', '<b>x</b>', 42, 'ok.example.com', 'UPPER.example.com'])).toEqual(['ok.example.com']);
    expect(coerceHostList('nope')).toEqual([]);
  });
});
