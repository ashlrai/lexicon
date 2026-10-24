/**
 * Local HTTP API at the protocol level: what a client gets for a body it
 * announces as too large before sending it (`Expect: 100-continue`), and for
 * a request the HTTP parser cannot read. An in-process `createServer()` on
 * port 0 against a throwaway HOME/LEXICON_PATH.
 */
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addTerm } from '../src/core/index.js';
import { createServer, MAX_BODY_BYTES } from '../src/serve/index.js';
import type { LexiconHttpServer, ServeStartInfo } from '../src/serve/index.js';

let home: string;
let srv: LexiconHttpServer;
let info: ServeStartInfo;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-protocol-')));
  const globalPath = path.join(home, '.config', 'lexicon', 'lexicon.yaml');
  const cwd = path.join(home, 'work');
  await fs.mkdir(cwd, { recursive: true });
  for (const k of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'LEXICON_PATH']) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.LEXICON_PATH = globalPath;
  await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler'] }, { globalPath });
  srv = createServer({ port: 0, cwd, globalPath, quiet: true, version: '9.9.9' });
  info = await srv.start();
});

afterAll(async () => {
  await srv.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A POST that announces `length` bytes with `Expect: 100-continue` and sends `body` only once the server says continue. */
function expectContinue(length: number, body: () => Buffer): Promise<{ continued: boolean; status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    let continued = false;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.port,
        path: '/normalize',
        method: 'POST',
        headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json', 'Content-Length': String(length), Expect: '100-continue' },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => {
          text += d;
        });
        res.on('end', () => resolve({ continued, status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as unknown) : null }));
      },
    );
    req.on('continue', () => {
      continued = true;
      req.end(body());
    });
    req.on('error', reject);
  });
}

/** Writes `raw` to the port and reads everything back until the server closes. */
function rawExchange(raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.port, '127.0.0.1', () => socket.write(raw));
    let out = '';
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      out += d;
    });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}

function bodyOf(response: string): unknown {
  const at = response.indexOf('\r\n\r\n');
  return JSON.parse(response.slice(at + 4)) as unknown;
}

describe('Expect: 100-continue', () => {
  // Catches: Node answered 100 Continue to every request, so a client
  // announcing a 20 MB body uploaded it, and past 16 MB the server cut the
  // connection: the client saw a reset instead of the 413.
  it('answers 413 to an announced body over the limit without inviting it', async () => {
    const big = MAX_BODY_BYTES * 20;
    const res = await expectContinue(big, () => Buffer.alloc(big, 0x20));
    expect(res.continued).toBe(false);
    expect(res.status).toBe(413);
    expect(res.json).toEqual({ error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
  });

  it('still invites a body within the limit', async () => {
    const body = Buffer.from(JSON.stringify({ text: 'ping ashler', dryRun: true }));
    const res = await expectContinue(body.length, () => body);
    expect(res.continued).toBe(true);
    expect(res.status).toBe(200);
    expect((res.json as { replacements: Array<{ canonical: string }> }).replacements.map((r) => r.canonical)).toEqual(['Ashlr.AI']);
  });
});

describe('requests the HTTP parser cannot read', () => {
  // Catches: Node's default answer to a malformed request is a bare status
  // line with no body, where every other error of the API is `{ error }`.
  it('answer 400 with the API\'s { error } body', async () => {
    const res = await rawExchange('NOT A REQUEST\r\n\r\n');
    expect(res.startsWith('HTTP/1.1 400 ')).toBe(true);
    expect(res).toMatch(/content-type: application\/json; charset=utf-8/i);
    expect(bodyOf(res)).toEqual({ error: expect.stringContaining('malformed HTTP request') });
  });

  it('answer 431 with { error } to headers over the limit', async () => {
    const res = await rawExchange(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${info.port}\r\nX-Big: ${'a'.repeat(64 * 1024)}\r\n\r\n`);
    expect(res.startsWith('HTTP/1.1 431 ')).toBe(true);
    expect(bodyOf(res)).toEqual({ error: expect.stringContaining('request headers are too large') });
  });
});
