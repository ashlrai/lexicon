import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

async function withServer(check: (server: ReturnType<typeof startServer>) => Promise<void>, keepAlive = false): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'lexicon-mcp-eof-'));
  const server = startServer(home, keepAlive);
  try {
    await check(server);
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill('SIGKILL');
    await server.exited;
    await rm(home, { recursive: true, force: true });
  }
}

function startServer(home: string, keepAlive: boolean) {
  // Model outstanding work so natural event-loop exhaustion cannot hide a
  // missing EOF handler. The real server must explicitly finish shutdown.
  const preload = keepAlive ? ['--import', 'data:text/javascript,setInterval(() => {}, 60000)'] : [];
  const child = spawn(process.execPath, [...preload, '--import', 'tsx', 'src/mcp/server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      LEXICON_PATH: join(home, '.config/lexicon/lexicon.yaml'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let stderr = '';
  const ready = new Promise<void>((resolve, reject) => {
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes('server started (stdio)')) resolve();
    });
    exited.then(() => reject(new Error(`Server exited before startup: ${stderr}`)), reject);
  });
  child.stdout.resume();
  return { child, exited, ready };
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('MCP stdin lifecycle', () => {
  it('exits successfully within 5s when the host closes stdin', async () => {
    await withServer(async ({ child, ready, exited }) => {
      await within(ready, 20_000);
      child.stdin.end();
      expect(await within(exited, 5000)).toEqual({ code: 0, signal: null });
    });
  });

  it('exits on EOF even when outstanding work keeps the event loop alive', async () => {
    await withServer(async ({ child, ready, exited }) => {
      await within(ready, 20_000);
      child.stdin.end();
      expect(await within(exited, 5000)).toEqual({ code: 0, signal: null });
    }, true);
  });

  it('stays alive for 2s while stdin is open, then exits on EOF', async () => {
    await withServer(async ({ child, ready, exited }) => {
      await within(ready, 20_000);
      expect(await Promise.race([exited.then(() => 'exited'), delay(2000, 'alive')])).toBe('alive');
      child.stdin.end();
      expect(await within(exited, 5000)).toEqual({ code: 0, signal: null });
    });
  });
});
