import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, DEFAULT_HOST, DEFAULT_PORT, ServerInfoSchema } from '../src/serve/index.js';
import type { LexiconHttpServer, ServerInfoResponse, ServeStartInfo } from '../src/serve/index.js';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/server-info/default.json', import.meta.url), 'utf8')) as unknown;
const invalid = JSON.parse(await fs.readFile(new URL('./fixtures/server-info/invalid.json', import.meta.url), 'utf8')) as unknown[];
let home: string;
let server: LexiconHttpServer;
let info: ServeStartInfo;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-info-'));
  server = createServer({ port: 0, cwd: home, globalPath: path.join(home, 'lexicon.yaml'), quiet: true, version: '9.9.9' });
  info = await server.start();
});
afterAll(async () => {
  await server?.stop();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

function get(route = '/info', init: RequestInit = {}) {
  return fetch(`${info.url}${route}`, { ...init, headers: { Authorization: `Bearer ${info.token}`, ...init.headers } });
}

describe('server info contract', () => {
  it('accepts the ecosystem fixture and rejects malformed fixtures', () => {
    const parsed: ServerInfoResponse = ServerInfoSchema.parse(fixture);
    expect(parsed.host).toBe(DEFAULT_HOST);
    expect(parsed.port).toBe(DEFAULT_PORT);
    for (const raw of invalid) expect(ServerInfoSchema.safeParse(raw).success).toBe(false);
  });

  it('matches the fixture on the wire and binds only IPv4 loopback by default', async () => {
    const address = server.server.address();
    expect(address).toEqual({ address: '127.0.0.1', family: 'IPv4', port: info.port });
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body: unknown = await response.json();
    expect(ServerInfoSchema.parse(body)).toEqual({ ...ServerInfoSchema.parse(fixture), port: info.port });
    expect(info.port).toBeGreaterThan(0);
  });

  it('reports discovery metadata even when the lexicon cannot be parsed', async () => {
    await fs.writeFile(path.join(home, 'lexicon.yaml'), 'terms: [broken');
    const response = await get();
    expect(response.status).toBe(200);
    expect(ServerInfoSchema.parse(await response.json()).version).toBe('9.9.9');
  });

  it('keeps bearer authentication, method and query checks', async () => {
    expect((await fetch(`${info.url}/info`)).status).toBe(401);
    expect((await get('/info', { method: 'POST' })).status).toBe(405);
    expect((await get('/info?cwd=anything')).status).toBe(400);
    const head = await get('/info', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});
