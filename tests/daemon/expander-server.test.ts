import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync, symlinkSync, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedLexicon, Lexicon } from '../../src/core/types.js';
import { runDaemonCommand, main as daemonMain } from '../../src/daemon/clipboard.js';
import { createExpanderSession, defaultExpanderSocketPath, prepareSocketPath, runExpanderServer } from '../../src/daemon/expander-server.js';
import type { ExpanderServerOptions } from '../../src/daemon/expander-server.js';

const posix = process.platform !== 'win32';

const lexicon: Lexicon = { version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }] };
const loaded = (lex: Lexicon = lexicon): LoadedLexicon => ({
  merged: lex,
  global: { path: '/g/lexicon.yaml', scope: 'global', lexicon: lex, exists: true },
});

let dir: string;
let home: string;
let savedHome: string | undefined;
let savedLexiconPath: string | undefined;
const running = new Set<() => Promise<unknown>>();

beforeEach(() => {
  // Short: a Unix socket path is limited to 103 bytes on macOS.
  dir = mkdtempSync(path.join(os.tmpdir(), 'lxe-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'lxh-'));
  savedHome = process.env.HOME;
  savedLexiconPath = process.env.LEXICON_PATH;
  // lexiconFilesStamp resolves the real global path: keep it in a temp home.
  process.env.HOME = home;
  process.env.LEXICON_PATH = path.join(home, 'lexicon.yaml');
});

afterEach(async () => {
  for (const stop of running) await stop();
  running.clear();
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedLexiconPath === undefined) delete process.env.LEXICON_PATH;
  else process.env.LEXICON_PATH = savedLexiconPath;
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

interface Running {
  socketPath: string;
  stop: () => Promise<unknown>;
  out: string[];
  err: string[];
}

async function start(extra: Partial<ExpanderServerOptions> = {}): Promise<Running> {
  const socketPath = path.join(dir, 'run', 'x.sock');
  const controller = new AbortController();
  const out: string[] = [];
  const err: string[] = [];
  let listening!: () => void;
  const ready = new Promise<void>((r) => (listening = r));
  const done = runExpanderServer({
    socketPath,
    cwd: dir,
    signal: controller.signal,
    load: async () => loaded(),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    onListening: () => listening(),
    ...extra,
  });
  await Promise.race([ready, done]);
  const stop = async (): Promise<unknown> => {
    controller.abort();
    return done;
  };
  running.add(stop);
  return { socketPath, out, err, stop };
}

/** A client that sends JSON lines and collects the JSON line answers. */
async function connect(socketPath: string): Promise<{ ask: (req: unknown) => Promise<Record<string, unknown>>; raw: (s: string) => Promise<Record<string, unknown>>; close: () => void }> {
  const socket = net.connect(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  socket.setEncoding('utf8');
  let buffered = '';
  const waiting: ((v: Record<string, unknown>) => void)[] = [];
  socket.on('data', (d: string) => {
    buffered += d;
    let nl: number;
    while ((nl = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      waiting.shift()?.(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const raw = (s: string): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      waiting.push(resolve);
      socket.write(s);
    });
  return { raw, ask: (req) => raw(`${JSON.stringify(req)}\n`), close: () => socket.destroy() };
}

describe.skipIf(!posix)('resident expander over a Unix socket', () => {
  it('answers ping, normalize, type and key on one connection, in order', async () => {
    const r = await start();
    expect(r.out.join('')).toContain(`lexicon expander listening on ${r.socketPath} (1 terms)`);
    const c = await connect(r.socketPath);
    expect(await c.ask({ id: 1, op: 'ping' })).toMatchObject({ id: 1, ok: true, terms: 1 });
    expect(await c.ask({ id: 'n', op: 'normalize', text: 'hi Ashler' })).toMatchObject({
      id: 'n',
      ok: true,
      output: 'hi Ashlr.AI',
      changed: true,
      replacements: [{ original: 'Ashler', replacement: 'Ashlr.AI', canonical: 'Ashlr.AI', reason: 'alias', confidence: 1 }],
    });
    for (const ch of 'at Ashler') expect((await c.ask({ op: 'type', text: ch })).action).toBeNull();
    const expand = await c.ask({ op: 'type', text: ' ' });
    expect(expand).toMatchObject({ ok: true, action: { kind: 'expand', backspaces: 7, insert: 'Ashlr.AI ' } });
    expect(await c.ask({ op: 'key', key: 'Backspace' })).toMatchObject({ action: { kind: 'undo', insert: 'Ashler' } });
    expect(await c.ask({ op: 'reset' })).toEqual({ ok: true });
    c.close();
    expect(await r.stop()).toBe('abort');
  });

  it('keeps one buffer per connection', async () => {
    const r = await start();
    const a = await connect(r.socketPath);
    const b = await connect(r.socketPath);
    await a.ask({ op: 'type', text: 'Ashler' });
    expect((await b.ask({ op: 'type', text: ' ' })).action).toBeNull();
    expect((await a.ask({ op: 'type', text: ' ' })).action).toMatchObject({ kind: 'expand' });
    a.close();
    b.close();
    await r.stop();
  });

  it('answers bad requests with an error and keeps the connection', async () => {
    const r = await start();
    const c = await connect(r.socketPath);
    expect(await c.raw('{nope\n')).toEqual({ ok: false, error: 'request is not valid JSON' });
    expect(await c.ask({ id: 2, op: 'launch' })).toMatchObject({ id: 2, ok: false, error: expect.stringContaining('unknown op') });
    expect(await c.ask({ op: 'key', key: 'F13' })).toMatchObject({ ok: false, error: expect.stringContaining('Backspace') });
    expect(await c.ask({ op: 'type', text: 'x'.repeat(5000) })).toMatchObject({ ok: false });
    expect(await c.ask({ op: 'type' })).toMatchObject({ ok: false, error: 'type expects "text" (a string)' });
    expect(await c.ask({ op: 'ping' })).toMatchObject({ ok: true });
    c.close();
    await r.stop();
  });

  it('corrects the clipboard in-process, sharing the resident lexicon', async () => {
    let clip = 'from Ashler';
    const load = vi.fn(async () => loaded());
    const r = await start({
      load,
      read: async () => clip,
      write: async (s) => {
        clip = s;
      },
      platform: 'linux',
    });
    const c = await connect(r.socketPath);
    expect(await c.ask({ op: 'clipboard' })).toEqual({ ok: true, changed: true, written: true, corrections: 1, pasted: false });
    expect(clip).toBe('from Ashlr.AI');
    expect(await c.ask({ op: 'clipboard', paste: 'yes' })).toMatchObject({ ok: false });
    // Loaded once at start; the clipboard request reused it.
    expect(load).toHaveBeenCalledTimes(1);
    c.close();
    await r.stop();
  });

  it('reloads the lexicon when its file changes', async () => {
    let current = loaded({ version: 1, terms: [] });
    writeFileSync(process.env.LEXICON_PATH!, 'v1');
    const r = await start({ load: async () => current });
    const c = await connect(r.socketPath);
    expect(await c.ask({ op: 'normalize', text: 'Ashler' })).toMatchObject({ changed: false });
    current = loaded();
    writeFileSync(process.env.LEXICON_PATH!, 'v2, a different size');
    expect(await c.ask({ op: 'normalize', text: 'Ashler' })).toMatchObject({ changed: true });
    // An open expander picks the new index up at its next word boundary.
    expect((await c.ask({ op: 'type', text: 'Ashler ' })).action).toMatchObject({ kind: 'expand' });
    c.close();
    await r.stop();
  });

  it('fails closed on reload errors and retries until the lexicon recovers', async () => {
    writeFileSync(process.env.LEXICON_PATH!, 'v1');
    let broken = false;
    let current = loaded();
    const r = await start({ load: async () => {
      if (broken) throw new Error('broken lexicon after trust changed');
      return current;
    } });
    const c = await connect(r.socketPath);
    expect((await c.ask({ op: 'type', text: 'Ashler ' })).action).toMatchObject({ kind: 'expand' });
    broken = true;
    writeFileSync(process.env.LEXICON_PATH!, 'v2 has a different stamp');
    expect(await c.ask({ op: 'type', text: 'Ashler ' })).toMatchObject({ ok: false, error: expect.stringContaining('broken lexicon') });
    expect(await c.ask({ op: 'normalize', text: 'Ashler' })).toMatchObject({ ok: false });
    broken = false;
    current = loaded({ version: 1, terms: [] });
    expect(await c.ask({ op: 'type', text: 'Ashler ' })).toEqual({ ok: true, action: null });
    expect(await c.ask({ op: 'normalize', text: 'Ashler' })).toMatchObject({ ok: true, changed: false });
    // A failed boundary refresh must forget the characters already in the
    // field; recovery cannot expand the stale unfinished word.
    current = loaded();
    await c.ask({ op: 'reset' });
    writeFileSync(process.env.LEXICON_PATH!, 'v3');
    expect(await c.ask({ op: 'type', text: 'Ashler' })).toEqual({ ok: true, action: null });
    broken = true;
    writeFileSync(process.env.LEXICON_PATH!, 'v4 different stamp');
    expect(await c.ask({ op: 'type', text: ' ' })).toMatchObject({ ok: false });
    broken = false;
    expect(await c.ask({ op: 'type', text: ' ' })).toEqual({ ok: true, action: null });
    c.close();
  });

  it('closes a connection whose request line never ends', async () => {
    const r = await start();
    const c = await connect(r.socketPath);
    const answer = await c.raw('x'.repeat(100_000));
    expect(answer).toMatchObject({ ok: false, error: expect.stringContaining('longer than') });
    c.close();
    await r.stop();
  });

  it('makes the socket and its directory private, and removes the socket on stop', async () => {
    const r = await start();
    expect(statSync(r.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(r.socketPath)).mode & 0o777).toBe(0o700);
    await r.stop();
    expect(() => statSync(r.socketPath)).toThrow();
  });

  it('refuses a second expander on the same socket, and replaces a stale one', async () => {
    const r = await start();
    await expect(prepareSocketPath(r.socketPath)).rejects.toThrow(/already listening/);
    await r.stop();
    // A stale socket: a process bound it, then was killed before it could remove it.
    const stale = path.join(dir, 'stale.sock');
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(stale)}, () => process.stdout.write('up'))`]);
    await new Promise<void>((res) => child.stdout.once('data', () => res()));
    child.kill('SIGKILL');
    await new Promise<void>((res) => child.once('exit', () => res()));
    expect(statSync(stale).isSocket()).toBe(true);
    await prepareSocketPath(stale);
    expect(() => statSync(stale)).toThrow();
  });

  it('refuses a regular file, symlink parent or shared directory without changing it', async () => {
    const file = path.join(dir, 'plain');
    writeFileSync(file, 'keep me');
    await expect(prepareSocketPath(file)).rejects.toThrow(/not a socket; it was left alone/);
    expect(statSync(file).size).toBe(7);
    const loose = path.join(dir, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o777);
    await expect(prepareSocketPath(path.join(loose, 'x.sock'))).rejects.toThrow(/dedicated directory/);
    expect(statSync(loose).mode & 0o777).toBe(0o777);
    const link = path.join(dir, 'link');
    symlinkSync(loose, link);
    await expect(prepareSocketPath(path.join(link, 'x.sock'))).rejects.toThrow(/not a symlink/);
    expect(statSync(loose).mode & 0o777).toBe(0o777);
    await expect(prepareSocketPath(path.join(dir, 'a'.repeat(120)))).rejects.toThrow(/longer than 103 bytes/);
  });

  it('answers a half-closed client after an asynchronous clipboard request', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const r = await start({
      read: async () => { reading(); await blocked; return 'Ashler'; },
      write: async () => undefined,
    });
    const client = net.connect(r.socketPath);
    client.setEncoding('utf8');
    let output = '';
    client.on('data', (data: string) => { output += data; });
    const ended = new Promise<void>((resolve, reject) => {
      client.once('end', resolve);
      client.once('error', reject);
    });
    client.end('{"op":"clipboard"}\n{"id":2,"op":"ping"}\n');
    await started;
    release();
    await ended;
    expect(output.trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { ok: true, changed: true, written: true, corrections: 1, pasted: false },
      expect.objectContaining({ id: 2, ok: true, terms: 1 }),
    ]);
    await r.stop();
  });

  it('rejects an oversized newline-terminated request before dispatching it', async () => {
    const r = await start();
    const c = await connect(r.socketPath);
    const answer = await c.raw(`${JSON.stringify({ op: 'ping', id: 'x'.repeat(80_001) })}\n`);
    expect(answer).toEqual({ ok: false, error: expect.stringContaining('longer than') });
    c.close();
  });

  it('bounds pipelined requests and sends an ordered error for the excess', async () => {
    const r = await start();
    const client = net.connect(r.socketPath);
    client.setEncoding('utf8');
    let output = '';
    client.on('data', (data: string) => { output += data; });
    const ended = new Promise<void>((resolve, reject) => {
      client.once('end', resolve);
      client.once('error', reject);
    });
    client.end(Array.from({ length: 100 }, (_, id) => `${JSON.stringify({ op: 'ping', id })}\n`).join(''));
    await ended;
    const answers = output.trim().split('\n').map((line) => JSON.parse(line));
    expect(answers).toHaveLength(65);
    expect(answers.slice(0, -1).map((answer) => answer.id)).toEqual(Array.from({ length: 64 }, (_, i) => i));
    expect(answers.at(-1)).toEqual({ ok: false, error: expect.stringContaining('too many queued requests') });
  });

  it('bounds responses when a short input expands into a huge output', async () => {
    const lex: Lexicon = { version: 1, terms: [{ canonical: 'LongName'.repeat(100), aliases: ['Ashler'] }] };
    const r = await start({ load: async () => loaded(lex) });
    const c = await connect(r.socketPath);
    expect(await c.ask({ op: 'normalize', text: 'Ashler '.repeat(1300) })).toEqual({
      ok: false, error: 'response is too large; normalize a smaller text',
    });
    c.close();
  });

  it.each(['chmod', 'onListening'] as const)('closes its listener after a %s startup failure', async (where) => {
    const socketPath = path.join(dir, 'fail.sock');
    const sigint = process.listenerCount('SIGINT');
    const sigterm = process.listenerCount('SIGTERM');
    if (where === 'chmod') vi.spyOn(fs, 'chmod').mockRejectedValueOnce(new Error('chmod failed'));
    await expect(runExpanderServer({
      socketPath, cwd: dir, load: async () => loaded(), quiet: true,
      onListening: where === 'onListening' ? () => { throw new Error('onListening failed'); } : undefined,
    })).rejects.toThrow(`${where} failed`);
    expect(() => statSync(socketPath)).toThrow();
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
    // A new server can take the same path immediately after rejection.
    const controller = new AbortController();
    expect(await runExpanderServer({
      socketPath, cwd: dir, load: async () => loaded(), quiet: true,
      signal: controller.signal, onListening: () => controller.abort(),
    })).toBe('abort');
  });

  it('finishes active clipboard work and cancels queued requests before shutdown resolves', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let reading!: () => void;
    const started = new Promise<void>((resolve) => { reading = resolve; });
    const read = vi.fn(async () => { reading(); await blocked; return 'Ashler'; });
    const write = vi.fn(async () => undefined);
    const r = await start({ read, write });
    const client = net.connect(r.socketPath);
    client.on('error', () => undefined);
    client.end('{"op":"clipboard"}\n{"op":"clipboard"}\n');
    await started;
    let finished = false;
    const stopping = r.stop().then(() => { finished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release();
    await stopping;
    expect(write).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('fails before listening when the lexicon will not load', async () => {
    await expect(start({ load: async () => Promise.reject(new Error('broken yaml')) })).rejects.toThrow('broken yaml');
  });
});

describe('expander session (no socket)', () => {
  it('reports the term count and version on ping', async () => {
    const handle = createExpanderSession({
      lexicon: { get: async () => ({ loaded: loaded(), index: (await import('../../src/core/index.js')).buildIndex(lexicon), generation: 1 }) },
      expanderOptions: {},
      version: '9.9.9',
      clipboard: async () => ({ changed: false, written: false, corrections: 0, pasted: false }),
    });
    expect(await handle({ op: 'ping' })).toEqual({ version: '9.9.9', terms: 1 });
    await expect(handle('ping')).rejects.toThrow(/JSON object/);
  });
});

describe('defaultExpanderSocketPath', () => {
  it('prefers an absolute XDG_RUNTIME_DIR, else the XDG state home', () => {
    expect(defaultExpanderSocketPath({ XDG_RUNTIME_DIR: '/run/user/501' }, 'linux', '/h')).toBe(path.join('/run/user/501', 'lexicon', 'expander.sock'));
    expect(defaultExpanderSocketPath({ XDG_RUNTIME_DIR: 'relative' }, 'linux', '/h')).toBe(path.join('/h', '.local', 'state', 'lexicon', 'expander.sock'));
    expect(defaultExpanderSocketPath({ XDG_STATE_HOME: '/s' }, 'darwin', '/h')).toBe(path.join('/s', 'lexicon', 'expander.sock'));
  });

  it('uses a per-user named pipe on Windows', () => {
    expect(defaultExpanderSocketPath({}, 'win32', '/h')).toMatch(/^\\\\\.\\pipe\\lexicon-expander-[\w.-]+$/);
  });
});

describe('daemon --expander flag', () => {
  it('refuses Windows before loading or exposing a named pipe', async () => {
    const load = vi.fn(async () => loaded());
    await expect(runExpanderServer({ platform: 'win32', load })).rejects.toThrow(/private named-pipe ACLs/);
    expect(load).not.toHaveBeenCalled();
  });
  it('is refused with the clipboard-only flags and --socket alone', async () => {
    await expect(runDaemonCommand({ expander: true, once: true })).rejects.toThrow('--once cannot be combined with --expander');
    await expect(runDaemonCommand({ expander: true, paste: true })).rejects.toThrow('--paste cannot be combined with --expander');
    await expect(runDaemonCommand({ socketPath: '/tmp/x.sock' })).rejects.toThrow('--socket works only with --expander');
  });

  it('parses --expander and --socket in the standalone entry', async () => {
    await expect(daemonMain(['--socket'])).rejects.toThrow('--socket expects a path');
    await expect(daemonMain(['--socket', '--once'])).rejects.toThrow('--socket expects a path');
    await expect(daemonMain(['--expander', '--which'])).rejects.toThrow('--which cannot be combined with --expander');
  });

  it.skipIf(!posix)('runs the server and exits 0 when aborted', async () => {
    const controller = new AbortController();
    const socketPath = path.join(dir, 'cmd.sock');
    const out: string[] = [];
    const code = runDaemonCommand({
      expander: true,
      socketPath,
      cwd: dir,
      signal: controller.signal,
      out: (s) => {
        out.push(s);
        controller.abort();
      },
      err: () => undefined,
    });
    expect(await code).toBe(0);
    expect(out.join('')).toContain('lexicon expander listening on');
  });
});
