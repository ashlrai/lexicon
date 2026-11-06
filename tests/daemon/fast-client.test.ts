import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { cliReadContext, defaultExpanderSocketPath, isFastRead, tryFastRead } from '../../src/daemon/fast-client.js';
import { bundleChildEntry } from '../helpers.js';
import { runExpanderServer } from '../../src/daemon/expander-server.js';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
let bundleDir: string;
beforeAll(async () => {
  // Keep the real package version discoverable, using the existing child bundler.
  bundleDir = await fs.mkdtemp(path.join(root, 'node_modules/.lexicon-fast-'));
  await Promise.all(['index', 'run'].map((entry) => bundleChildEntry(
    `import './src/cli/${entry}.js';`, path.join(bundleDir, `${entry}.mjs`))));
});
afterAll(async () => { await fs.rm(bundleDir, { recursive: true, force: true }); });
let dir: string;
let cleanup: (() => Promise<unknown>)[];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lxf-'));
  cleanup = [];
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) vi.stubEnv(key, dir);
  vi.stubEnv('LEXICON_PATH', path.join(dir, 'config', 'lexicon.yaml'));
  vi.stubEnv('LEXICON_TRUST_ALL', '0');
  vi.stubEnv('NO_COLOR', '1');
  await fs.mkdir(path.dirname(process.env.LEXICON_PATH!), { recursive: true });
  await fs.writeFile(process.env.LEXICON_PATH!, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
});
afterEach(async () => {
  for (const stop of cleanup.reverse()) await stop();
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

async function resident(): Promise<void> {
  const controller = new AbortController();
  let ready!: () => void;
  const listening = new Promise<void>((resolve) => { ready = resolve; });
  const done = runExpanderServer({ signal: controller.signal, quiet: true, onListening: ready });
  cleanup.push(async () => { controller.abort(); await done; });
  await Promise.race([listening, done]);
}

async function cli(entry: 'index' | 'run', args: string[], env = process.env) {
  try {
    const result = await exec(process.execPath, [path.join(bundleDir, `${entry}.mjs`), ...args], { env });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (e) {
    const failure = e as { stdout: string; stderr: string; code: number };
    return { stdout: failure.stdout, stderr: failure.stderr, code: failure.code };
  }
}

it.each([['list'], ['ls', '--json'], ['list', '--full', '--offset', '1'],
  ['list', '--query', 'Ash', '--category', 'other', '--limit', '1'], ['path', '--json'], ['stats', '--json'],
  ['export', 'espanso'], ['export', 'json', '--json'], ['list', '--limit', 'bad', '--json'], ['list', '--unknown']]
  .map((args) => [args]))('preserves direct bytes and status for %j with daemon absent and present', async (args) => {
  const direct = await cli('run', args);
  expect(await cli('index', args)).toEqual(direct);
  await resident();
  if (!args.includes('bad') && !args.includes('--unknown')) expect(await tryFastRead(args, undefined, 1000)).toBeDefined();
  expect(await cli('index', args)).toEqual(direct);
});

it('uses fresh files and caller cwd, leaving untrusted projects unparsed', async () => {
  await fs.writeFile(path.join(dir, '.lexicon.yaml'), 'invalid: [');
  await resident();
  const args = ['list', '--cwd', dir, '--full'];
  const first = await tryFastRead(args, undefined, 1000);
  expect(first).toBeDefined();
  expect(first).toEqual(await cli('run', args));
  expect(first!.stderr).toContain('untrusted project lexicon skipped');
  await fs.writeFile(process.env.LEXICON_PATH!, 'version: 1\nterms: []\n');
  expect(await tryFastRead(args, undefined, 1000)).toEqual(await cli('run', args));
  await fs.writeFile(process.env.LEXICON_PATH!, 'broken: [');
  expect(await cli('index', args)).toEqual(await cli('run', args));
});

it('declines different configuration and never dispatches mutations', async () => {
  await resident();
  const other = path.join(dir, 'other.yaml');
  await fs.writeFile(other, 'version: 1\nterms: []\n');
  const env = { ...process.env, LEXICON_PATH: other };
  expect(await cli('index', ['list', '--json'], env)).toEqual(await cli('run', ['list', '--json'], env));
  for (const args of [['add', 'X'], ['normalize', 'Ashler'], ['export', 'json', '--out=x'], ['list', '--help']]) {
    expect(isFastRead(args)).toBe(false);
    expect(await tryFastRead(args)).toBeUndefined();
  }
  const output = path.join(dir, 'export.json');
  // A raw peer cannot bypass the parsed --out guard either.
  const peer = net.connect(defaultExpanderSocketPath());
  const reply = new Promise<string>((resolve) => peer.once('data', (data) => resolve(String(data))));
  peer.write(JSON.stringify({ op: 'cli-read', context: cliReadContext(), argv: ['export', 'json', '--out', output] }) + '\n');
  expect(JSON.parse(await reply).ok).toBe(false);
  peer.destroy();
  await expect(fs.stat(output)).rejects.toThrow();
});

it.each(['missing', 'closed', 'stall', 'malformed', 'old', 'shape', 'partial', 'oversized', 'success'])('handles %s peer responses', async (kind) => {
  const socketPath = defaultExpanderSocketPath();
  if (kind !== 'missing') {
    if (process.platform !== 'win32') await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('data', () => {
        const responses: Record<string, string> = { malformed: '{\n', old: '{"ok":false,"error":"unknown op"}\n',
          shape: '{"ok":true,"stdout":"partial","stderr":"","code":999}\n', success: '{"ok":true,"stdout":"daemon output\\n","stderr":"daemon diagnostic\\n","code":3}\n', partial: '{"ok":true', oversized: 'x'.repeat(8 * 1024 * 1024 + 1) };
        if (kind === 'closed') socket.end();
        else if (responses[kind]) socket.write(responses[kind]);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  }
  if (kind === 'success') {
    expect(await cli('index', ['list'])).toEqual({ stdout: 'daemon output\n', stderr: 'daemon diagnostic\n', code: 3 });
    return;
  }
  expect(await tryFastRead(['list'], socketPath, 30)).toBeUndefined();
  expect(await cli('index', ['list', '--json'])).toEqual(await cli('run', ['list', '--json']));
});

it('treats synchronous transport failures as misses', async () => {
  expect(await tryFastRead(['list'], '\0')).toBeUndefined();
});

it('keeps invalid CLI request diagnostics off daemon streams', async () => {
  await resident();
  const stdout = vi.spyOn(process.stdout, 'write');
  const stderr = vi.spyOn(process.stderr, 'write');
  try {
    expect(await tryFastRead(['list', '--unknown'], undefined, 1000)).toBeUndefined();
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
});
