/**
 * The local API's request URL parsing and its lexicon cache: a request
 * target starting with `//`, a load that races a write's invalidation, and
 * file identity on case-insensitive filesystems (win32, darwin), simulated by
 * passing the platform.
 */
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** When set, the next loadLexicon call reads the files, then waits for this before returning. */
const gate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined, loaded: undefined as (() => void) | undefined }));

vi.mock('../src/core/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/index.js')>();
  return {
    ...real,
    loadLexicon: async (...args: Parameters<typeof real.loadLexicon>) => {
      const hold = gate.hold;
      gate.hold = undefined;
      const result = await real.loadLexicon(...args);
      if (hold) {
        gate.loaded?.();
        await hold;
      }
      return result;
    },
  };
});

import { addTerm } from '../src/core/index.js';
import { createServer, requestUrl } from '../src/serve/server.js';
import type { LexiconHttpServer, ServeStartInfo } from '../src/serve/server.js';

let home: string;
let globalPath: string;
let srv: LexiconHttpServer;
let info: ServeStartInfo;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-cache-')));
  globalPath = path.join(home, '.config', 'lexicon', 'lexicon.yaml');
  const cwd = path.join(home, 'work');
  await fs.mkdir(cwd, { recursive: true });
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'LEXICON_PATH', 'LEXICON_TRUST_ALL']) savedEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.LEXICON_PATH = globalPath;
  delete process.env.LEXICON_TRUST_ALL;
  await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand' }, { globalPath });
  // A long reload interval, so whatever is cached is what the next request sees.
  srv = createServer({ port: 0, cwd, globalPath, quiet: true, version: '9.9.9', reloadMs: 60_000 });
  info = await srv.start();
});

afterAll(async () => {
  await srv.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function api(method: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`${info.url}${route}`, {
    method,
    headers: { Authorization: `Bearer ${info.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** A raw request, so the target goes out exactly as written (fetch would normalise `//`). */
function rawGet(target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: info.port, path: target, method: 'GET', headers: { Authorization: `Bearer ${info.token}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('requestUrl', () => {
  it('keeps a path that starts with // as the path, not a host', () => {
    expect(new URL('//health', 'http://localhost').pathname).toBe('/'); // the bug: host "health"
    const url = requestUrl('//health?cwd=/x');
    expect(url.host).toBe('localhost');
    expect(url.pathname).toBe('//health');
    expect(url.searchParams.get('cwd')).toBe('/x');
    expect(requestUrl('//evil.example/terms').host).toBe('localhost');
    expect(requestUrl('//evil.example/terms').pathname).toBe('//evil.example/terms');
  });

  it('reads an ordinary target, an absolute-form one, and falls back to / for anything else', () => {
    expect(requestUrl('/health').pathname).toBe('/health');
    expect(requestUrl(undefined).pathname).toBe('/');
    const abs = requestUrl('http://other.example/lexicon?x=1');
    expect(abs.host).toBe('localhost');
    expect(abs.pathname).toBe('/lexicon');
    expect(abs.search).toBe('?x=1');
    expect(requestUrl('*').pathname).toBe('/');
    expect(requestUrl('health').pathname).toBe('/');
  });

  it('answers GET //health as an unknown path, not as GET /', async () => {
    const r = await rawGet('//health');
    expect(r.status).toBe(404);
    const ok = await rawGet('/health');
    expect(ok.status).toBe(200);
  });
});

describe('lexicon cache', () => {
  it('does not cache a load that started before a write and finished after its invalidation', async () => {
    // A cwd nothing has loaded yet, so the first request misses the cache.
    const cwd = path.join(home, 'race');
    await fs.mkdir(cwd, { recursive: true });
    const health = `/health?cwd=${encodeURIComponent(cwd)}`;
    let release!: () => void;
    gate.hold = new Promise<void>((r) => (release = r));
    const started = new Promise<void>((r) => (gate.loaded = r));
    // A load reads the one-term lexicon, then is held.
    const stale = api('GET', health);
    await started;
    gate.loaded = undefined;
    // The write lands and clears the cache while that load is in flight.
    const add = await api('POST', '/add', { canonical: 'Vercel', aliases: ['versel'], cwd });
    expect(add.status).toBe(200);
    release();
    const staleBody = (await (await stale).json()) as { terms: number };
    expect(staleBody.terms).toBe(1);
    // The next request sees the write, not the old lexicon the held load read.
    const fresh = (await (await api('GET', health)).json()) as { terms: number };
    expect(fresh.terms).toBe(2);
  });
});
