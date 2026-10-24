// @vitest-environment jsdom
/**
 * The background's view of the local API over time: the /health cache, a
 * rejected token, request timeouts and which servers count as lexicon serve.
 * A fake fetch stands in for the server; nothing listens on a port.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackground } from '../extension/src/background-core.js';
import type { KeyValueStore } from '../extension/src/background-core.js';
import { FETCH_TIMEOUT_MS, LEXICON_TIMEOUT_MS, TOKEN_BACKOFF_MS, WRITE_TIMEOUT_MS, connectionTestLine, statusView } from '../extension/src/shared.js';
import type { NormalizeReply, StatusReply } from '../extension/src/shared.js';

const EXAMPLE_YAML = readFileSync(resolve(process.cwd(), 'examples/lexicon.example.yaml'), 'utf8');
const TOKEN = 'a'.repeat(32);
const HEALTH = { ok: true, version: '9.9.9', terms: 3, port: 41733 };

function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
  };
}

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const normalized = (text: string): unknown => ({ input: text, output: text, changed: false, replacements: [], summary: '' });

afterEach(() => {
  vi.useRealTimers();
});

describe('extension health cache', () => {
  // Catches: only saveSettings cleared the /health cache, so a server that
  // went away (or came back with another token) under a Sync or a Learn was
  // trusted for the rest of the 10 s TTL.
  it('drops the cached /health when a request finds the server gone or answering 401/403', async () => {
    let down = false;
    let learnStatus = 200;
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (down) throw new TypeError('Failed to fetch');
      if (url.endsWith('/health')) return json(HEALTH);
      if (url.endsWith('/normalize')) return json(normalized(String(JSON.parse(String(init.body)).text)));
      if (url.endsWith('/learn')) return json({ error: 'project lexicon is untrusted' }, learnStatus);
      return json({ error: 'nope' }, 404);
    });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token: TOKEN } }), defaultYaml: EXAMPLE_YAML });
    const healthCalls = (): number => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/health')).length;

    expect(((await bg.handle({ type: 'normalize', text: 'hi' })) as NormalizeReply & { ok: true }).mode).toBe('api');
    expect(healthCalls()).toBe(1);

    // A Sync that finds nothing listening: the next normalize asks /health again.
    down = true;
    expect(await bg.handle({ type: 'sync' })).toMatchObject({ ok: false });
    down = false;
    expect(((await bg.handle({ type: 'normalize', text: 'hi' })) as NormalizeReply & { ok: true }).mode).toBe('api');
    expect(healthCalls()).toBe(2);

    // A 403 from /learn: the server may have restarted on another lexicon.
    learnStatus = 403;
    expect(await bg.handle({ type: 'learn', heard: 'quorbix', meant: 'Quorbyx' })).toMatchObject({ ok: false });
    await bg.handle({ type: 'normalize', text: 'hi' });
    expect(healthCalls()).toBe(3);
  });

  // Catches: Options stores the connection fields itself, not through the
  // background, so a /health cached for the old base URL answered for the new one.
  it('does not reuse a /health cached for another base URL', async () => {
    const fetchMock = vi.fn(async (url: string) => (url.endsWith('/health') ? json(HEALTH) : json(normalized('hi'))));
    const store = memoryStore({ settings: { token: TOKEN } });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store, defaultYaml: EXAMPLE_YAML });
    await bg.handle({ type: 'normalize', text: 'hi' });
    store.data.settings = { token: TOKEN, baseUrl: 'http://127.0.0.1:41800' };
    await bg.handle({ type: 'normalize', text: 'hi' });
    const probed = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.endsWith('/health'));
    expect(probed).toEqual(['http://127.0.0.1:41733/health', 'http://127.0.0.1:41800/health']);
  });
});

describe('extension rejected-token backoff', () => {
  // Catches: after a 401 every normalize (and every Learn, Sync and popup
  // open) sent the same rejected token again, and nothing said the extension
  // had stopped trying until the settings changed.
  it('stops sending a rejected token until it backs off or the token changes, and says so', async () => {
    let clock = 1_000_000;
    let goodToken = 'f'.repeat(32);
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/health')) return json(HEALTH);
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth !== `Bearer ${goodToken}`) return json({ error: 'missing or invalid bearer token' }, 401);
      if (url.endsWith('/stats')) return json({ termCount: 3 });
      return json(normalized('ping ashler'));
    });
    const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token: TOKEN } }), defaultYaml: EXAMPLE_YAML, now: () => clock });
    const bearerCalls = (): number => fetchMock.mock.calls.filter(([u]) => !String(u).endsWith('/health')).length;

    for (let i = 0; i < 5; i++) {
      const reply = (await bg.handle({ type: 'normalize', text: 'ping ashler' })) as NormalizeReply & { ok: true };
      expect(reply.mode).toBe('embedded');
      expect(reply.fallback).toMatch(/rejected the token \(401\)/);
    }
    expect(bearerCalls()).toBe(1);
    expect(await bg.handle({ type: 'learn', heard: 'quorbix', meant: 'Quorbyx' })).toMatchObject({ ok: true, mode: 'embedded' });
    expect(await bg.handle({ type: 'sync' })).toMatchObject({ ok: false, error: expect.stringMatching(/rejected the token/) });
    expect(bearerCalls()).toBe(1);

    // The popup's status reads the backoff without asking the server again, and says it.
    const status = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(bearerCalls()).toBe(1);
    expect(status.tokenError).toMatch(/rejected the token/);
    expect(status.tokenRetryAt).toBe(1_000_000 + TOKEN_BACKOFF_MS);
    expect(statusView(status, clock).line).toContain('The extension will not send this token again for 30 s; pairing or saving another token retries at once.');
    expect(connectionTestLine(status, clock)).toContain('will not send this token again for 30 s');

    // Test connection asks anyway; a second 401 doubles the wait.
    const probed = (await bg.handle({ type: 'status', probe: true })) as StatusReply;
    expect(bearerCalls()).toBe(2);
    expect(probed.tokenRetryAt).toBe(1_000_000 + 2 * TOKEN_BACKOFF_MS);

    // Once the backoff is over, one request tries again.
    clock += 2 * TOKEN_BACKOFF_MS + 1;
    await bg.handle({ type: 'normalize', text: 'ping ashler' });
    await bg.handle({ type: 'normalize', text: 'ping ashler' });
    expect(bearerCalls()).toBe(3);

    // A new token is tried at once and, accepted, clears the backoff.
    goodToken = 'e'.repeat(32);
    await bg.saveSettings({ token: goodToken });
    expect(((await bg.handle({ type: 'normalize', text: 'ping ashler' })) as NormalizeReply & { ok: true }).mode).toBe('api');
    const ok = (await bg.handle({ type: 'status' })) as StatusReply;
    expect(ok.tokenError).toBeUndefined();
    expect(ok.tokenRetryAt).toBeUndefined();
    expect(ok.activeMode).toBe('api');
  });
});

describe('extension request timeouts', () => {
  /** A fetch whose bearer routes answer after `delayMs` (fake timers), or reject with AbortError when aborted first. */
  function slowFetch(delayMs: number): typeof fetch {
    return (async (url: string, init: RequestInit) => {
      if (url.endsWith('/health')) return json(HEALTH);
      const body = url.endsWith('/learn')
        ? { term: { canonical: 'Quorbyx' }, created: true, aliasAdded: true, path: '/g/lexicon.yaml' }
        : url.endsWith('/lexicon')
          ? { lexicon: { version: 1, terms: [{ canonical: 'Entire.io', aliases: [] }] } }
          : normalized('hi');
      return new Promise<Response>((resolveFetch, reject) => {
        const t = setTimeout(() => resolveFetch(json(body)), delayMs);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }) as unknown as typeof fetch;
  }

  // Catches: /learn and /lexicon shared the 1.5 s timeout of /normalize, so a
  // Learn the server was still writing (it waits up to 10 s for the file lock)
  // and a Sync of a large lexicon were reported as timed out.
  it('gives /learn and /lexicon longer than the quick reads', async () => {
    expect(WRITE_TIMEOUT_MS).toBeGreaterThan(10_000);
    expect(LEXICON_TIMEOUT_MS).toBeGreaterThan(FETCH_TIMEOUT_MS);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const bg = createBackground({ fetch: slowFetch(3000), store: memoryStore({ settings: { token: TOKEN } }), defaultYaml: EXAMPLE_YAML });
    const learn = bg.handle({ type: 'learn', heard: 'quorbix', meant: 'Quorbyx' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await learn).toMatchObject({ ok: true, mode: 'api' });
    const sync = bg.handle({ type: 'sync' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await sync).toMatchObject({ ok: true, terms: 1 });
    // A normalize keeps the short timeout: the user is waiting on the send.
    const norm = bg.handle({ type: 'normalize', text: 'hi' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await norm).toMatchObject({ ok: true, mode: 'embedded', fallback: `API /normalize timed out after ${FETCH_TIMEOUT_MS} ms; run \`lexicon serve --status\` to check the server` });
  });
});

describe('extension /health identity', () => {
  // Catches: any 2xx `{ ok: true }` counted as lexicon serve, so another
  // program on the port read as Connected and every correction was posted to it.
  it('counts only a /health with lexicon serve fields as the server', async () => {
    for (const body of [{ ok: true }, { ok: true, version: '', terms: 1 }, { ok: true, version: '1', terms: '3' }, { ok: true, status: 'UP' }, null, [], 'ok']) {
      const fetchMock = vi.fn(async (url: string) => (url.endsWith('/health') ? json(body) : json(normalized('ping ashler'))));
      const bg = createBackground({ fetch: fetchMock as unknown as typeof fetch, store: memoryStore({ settings: { token: TOKEN } }), defaultYaml: EXAMPLE_YAML });
      const status = (await bg.handle({ type: 'status' })) as StatusReply;
      expect(status.server, JSON.stringify(body)).toBeNull();
      expect(status.activeMode).toBe('embedded');
      expect(status.serverError).toBe(
        'something answered http://127.0.0.1:41733/health, but not as lexicon serve does; another program may hold the port. Run `lexicon serve --status` to check, or point Options at the port lexicon serve uses',
      );
      const reply = (await bg.handle({ type: 'normalize', text: 'ping ashler' })) as NormalizeReply & { ok: true };
      expect(reply.mode).toBe('embedded');
      // Nothing was posted to the other program.
      expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/normalize'))).toBe(false);
    }
    // The real shape (src/serve/server.ts HealthResponse) still counts.
    const real = vi.fn(async (url: string) => (url.endsWith('/health') ? json(HEALTH) : json({ termCount: 3 })));
    const ok = (await createBackground({ fetch: real as unknown as typeof fetch, store: memoryStore({ settings: { token: TOKEN } }), defaultYaml: EXAMPLE_YAML }).handle({ type: 'status' })) as StatusReply;
    expect(ok.server).toEqual({ ok: true, version: '9.9.9', terms: 3 });
  });
});
