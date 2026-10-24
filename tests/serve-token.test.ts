/**
 * The bearer check in the local HTTP API (`tokenMatches` in
 * src/serve/server.ts), driven through a real server on port 0 against a
 * throwaway HOME. `node:crypto` is the real module with `timingSafeEqual`
 * counted, so a test can see what the comparison was given.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const compared = vi.hoisted(() => ({ lengths: [] as Array<[number, number]> }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.lengths.push([a.byteLength, b.byteLength]);
      return real.timingSafeEqual(a, b);
    },
  };
});
import { createServer, getServePath } from '../src/serve/index.js';

let dir: string;
let globalPath: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-token-')));
  globalPath = path.join(dir, 'lexicon.yaml');
  await fs.writeFile(globalPath, 'version: 1\nterms: []\n');
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'LEXICON_PATH']) saved[key] = process.env[key];
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
  process.env.LEXICON_PATH = globalPath;
  compared.lengths = [];
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('bearer token check', () => {
  // Catches: tokenMatches returned early when the given token's length
  // differed from the real one, before timingSafeEqual ran, so a caller could
  // learn the token's length from the timing. Both sides are now compared as
  // fixed-length digests, whatever was sent.
  it('compares fixed-length values for a token of any length, and still takes only the exact token', async () => {
    const token = 'ab'.repeat(16);
    await fs.writeFile(getServePath({ globalPath }), JSON.stringify({ port: 41733, token, createdAt: '2026-01-01T00:00:00.000Z' }), { mode: 0o600 });
    const server = createServer({ port: 0, globalPath, cwd: dir, quiet: true, log: () => {} });
    const info = await server.start();
    try {
      const get = (t: string): Promise<number> => fetch(`${info.url}/stats`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.status);
      compared.lengths = [];
      expect(await get('a')).toBe(401);
      expect(await get(token + 'cd')).toBe(401);
      expect(await get('cd'.repeat(16))).toBe(401);
      expect(await get(token)).toBe(200);
      expect(compared.lengths.length).toBeGreaterThanOrEqual(4);
      for (const [a, b] of compared.lengths) {
        expect(a).toBe(32);
        expect(b).toBe(32);
      }
    } finally {
      await server.stop();
    }
  });
});
