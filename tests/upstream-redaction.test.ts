// No credential reaches an error, a reply the popup shows, or the CLI's
// output, whatever an upstream answers. Each credential gets a distinctive
// canary: the extension's bearer token, the token `lexicon serve --status`
// sends, and a registry URL's query token and password. Every caller is
// driven against bodies that quote the request back, non-2xx statuses and
// bad URLs, and no 8-character run of any canary may appear.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBackground } from '../extension/src/background-core.js';
import type { KeyValueStore } from '../extension/src/background-core.js';
import { loadRegistryIndex } from '../src/core/registry.js';
import { probeHealth } from '../src/serve/config.js';

const EXT_TOKEN = 'c4a7e1d29b3f80a65e7c41d2b98f3a06';
const SERVE_TOKEN = 'e8b2f61c03d94a7b5c1e2f8d6a09b47c';
const QUERY_TOKEN = 'qtCANARYr5T1y8U2i6P0aS';
const URL_PASSWORD = 'pwCANARYd3F7g1H9j5K2lQ';
const SECRETS: Record<string, string> = {
  'extension token': EXT_TOKEN,
  'serve token': SERVE_TOKEN,
  'registry query token': QUERY_TOKEN,
  'registry URL password': URL_PASSWORD,
};

function leaks(label: string, text: string): string[] {
  const out: string[] = [];
  for (const [name, s] of Object.entries(SECRETS)) {
    let n = 0;
    for (let i = 0; i + 8 <= s.length; i++) if (text.includes(s.slice(i, i + 8))) n++;
    if (n > 0) out.push(`${label}: ${name} (${n} windows)`);
  }
  return out;
}

/** Run `fn`, returning its result or error and everything written to the console or stderr, as one string. */
async function observe(fn: () => Promise<unknown>): Promise<string> {
  const seen: string[] = [];
  const grab = (...a: unknown[]) => {
    seen.push(a.map(String).join(' '));
  };
  const spies = [
    vi.spyOn(console, 'error').mockImplementation(grab),
    vi.spyOn(console, 'warn').mockImplementation(grab),
    vi.spyOn(console, 'log').mockImplementation(grab),
    vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      seen.push(String(c));
      return true;
    }),
  ];
  try {
    seen.push(JSON.stringify(await fn()) ?? 'undefined');
  } catch (e) {
    const err = e as Error;
    seen.push(String(err), err?.message ?? '', err?.stack ?? '');
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return seen.join('\n');
}

/** The request's auth header and URL, quoted back the way a foreign server might. */
function quoteRequest(url: string, init?: RequestInit): string {
  const h = (init?.headers ?? {}) as Record<string, string>;
  return `rejected ${h.Authorization ?? h.authorization ?? '(no auth)'} for ${url}`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function memoryStore(initial: Record<string, unknown> = {}): KeyValueStore {
  const data = { ...initial };
  return {
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]])),
    set: async (items) => {
      Object.assign(data, items);
    },
  };
}

describe('extension: an API error never carries the bearer token', () => {
  for (const status of [400, 403, 500]) {
    it(`HTTP ${status} quoting the request`, async () => {
      let reached = 0;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/health')) return jsonResponse(200, { ok: true, version: '1', terms: 1 });
        reached++;
        return jsonResponse(status, { error: quoteRequest(url, init) });
      });
      const bg = createBackground({
        fetch: fetchMock as unknown as typeof fetch,
        store: memoryStore({ settings: { token: EXT_TOKEN, mode: 'api' } }),
        defaultYaml: 'terms: []\n',
      });
      const found: string[] = [];
      for (const req of [
        { type: 'sync' },
        { type: 'learn', heard: 'Ashler', meant: 'Ashley' },
        { type: 'normalize', text: 'hello Ashler', dryRun: true },
      ]) {
        found.push(...leaks(req.type, await observe(() => bg.handle(req as never))));
      }
      expect(reached).toBeGreaterThan(0);
      expect(found).toEqual([]);
    });
  }
});

describe('serve --status: a failing /health never carries the token', () => {
  for (const status of [401, 500, 503]) {
    it(`HTTP ${status} quoting the request`, async () => {
      let reached = false;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        reached = true;
        return jsonResponse(status, { error: quoteRequest(url, init) });
      });
      const text = await observe(() =>
        probeHealth('http://127.0.0.1:1', { token: SERVE_TOKEN, fetch: fetchMock as unknown as typeof fetch }),
      );
      expect(reached).toBe(true);
      expect(leaks(`HTTP ${status}`, text)).toEqual([]);
    });
  }
});

describe('registry: an index fetch error never carries URL credentials or query tokens', () => {
  let server: http.Server;
  let root = '';
  let hits = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits++;
      const status = req.url?.startsWith('/401') ? 401 : req.url?.startsWith('/500') ? 500 : 404;
      res.writeHead(status, { 'content-type': 'text/plain' });
      res.end(`no: ${req.url} ${req.headers.authorization ?? ''}`);
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it('401, 500, 404, a closed port and a URL with a password', async () => {
    const closed = await new Promise<string>((ok) => {
      const s = http.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => ok(`http://127.0.0.1:${p}`));
      });
    });
    const cases: Array<[string, string]> = [
      ['401', `${root}/401/index.yaml?token=${QUERY_TOKEN}`],
      ['500', `${root}/500/index.yaml?token=${QUERY_TOKEN}`],
      ['404', `${root}/404/index.yaml?token=${QUERY_TOKEN}`],
      ['closed port', `${closed}/index.yaml?token=${QUERY_TOKEN}`],
      ['URL password', `${root.replace('http://', `http://reg:${URL_PASSWORD}@`)}/401/index.yaml?token=${QUERY_TOKEN}`],
      ['malformed URL', `https://exa mple.com/index.yaml?token=${QUERY_TOKEN}`],
    ];
    const found: string[] = [];
    for (const [label, url] of cases) {
      found.push(...leaks(label, await observe(() => loadRegistryIndex(url))));
    }
    expect(hits).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });
});

describe('redactSecrets and safeUrlLabel', () => {
  it('redacts whole and partial echoes, and leaves short overlaps alone', async () => {
    const { redactSecrets } = await import('../src/core/redact.js');
    const s = ['abcdEFGH1234ijklMNOP'];
    expect(redactSecrets('bad key abcdEFGH1234ijklMNOP!', s)).toBe('bad key [redacted]!');
    expect(redactSecrets('got ...1234ijklMN', s)).toBe('got ...[redacted]');
    expect(redactSecrets('abcdEFG and MNOP', s)).toBe('abcdEFG and MNOP');
    expect(redactSecrets('a b c', ['a', undefined, null])).toBe('a b c');
  });

  it('drops credentials, query and fragment and never echoes an unparseable URL', async () => {
    const { safeUrlLabel } = await import('../src/core/redact.js');
    expect(safeUrlLabel('https://u:p@reg.example.com:8443/packs/index.yaml?token=x#y')).toBe(
      'https://reg.example.com:8443/packs/index.yaml (query omitted)',
    );
    expect(safeUrlLabel('https://reg.example.com/index.yaml')).toBe('https://reg.example.com/index.yaml');
    expect(safeUrlLabel('https://exa mple.com/?token=secret')).toBe('(unparseable URL)');
  });
});
