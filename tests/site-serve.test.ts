import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// site/serve.mjs is the `npm run dev:site` static server for site/dist.
const serveScript = fileURLToPath(new URL('../site/serve.mjs', import.meta.url));
let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<number> {
  const port = await freePort();
  const proc = spawn(process.execPath, [serveScript], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = proc;
  await new Promise<void>((resolve, reject) => {
    let out = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('serving ')) resolve();
    });
    proc.once('exit', (code) => reject(new Error(`site/serve.mjs exited ${code} before listening`)));
  });
  return port;
}

describe('site dev server', () => {
  it('answers a malformed percent escape with 400 and keeps serving', async () => {
    const port = await startServer();
    const bad = await fetch(`http://127.0.0.1:${port}/%E0`);
    expect(bad.status).toBe(400);
    const next = await fetch(`http://127.0.0.1:${port}/no-such-file.txt`);
    expect(next.status).toBe(404);
  });
});
