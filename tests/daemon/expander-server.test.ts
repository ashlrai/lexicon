import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
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

beforeEach(() => {
  // Short: a Unix socket path is limited to 103 bytes on macOS.
  dir = mkdtempSync(path.join(os.tmpdir(), 'lxe-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'lxh-'));
  savedHome = process.env.HOME;
  // lexiconFilesStamp resolves the real global path: keep it in a temp home.
  process.env.HOME = home;
  process.env.LEXICON_PATH = path.join(home, 'lexicon.yaml');
});

afterEach(() => {
  process.env.HOME = savedHome;
  delete process.env.LEXICON_PATH;
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
  return {
    socketPath,
    out,
    err,
    stop: async () => {
      controller.abort();
      return done;
    },
  };
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

describe('issue #220 contract scope', () => {
  it('distinguishes the proposed system-wide surface from the existing server', () => {
    const contract = readFileSync(new URL('../../docs/CONTRACT.md', import.meta.url), 'utf8');
    const section = contract.split('### Separate-process boundary (issue #220)')[1]?.split('## src/serve')[0];
    expect(section).toBeDefined();
    expect(section).toMatch(/Proposed surface:[\s\S]*system-wide text expander, separate from the CLI and\s+agent integrations/);
    expect(section).toMatch(/any focused text\s+field without an agent in the loop/);
    expect(section).toMatch(/complete surface is not implemented/);
    expect(section).toMatch(/existing expansion core and socket server do not capture system-wide input\s+or apply changes to a focused field/);
  });
});

describe.skipIf(!posix)('resident expander over a Unix socket', () => {
  it('answers the normalization example in the separate-process contract', async () => {
    const contract = readFileSync(new URL('../../docs/CONTRACT.md', import.meta.url), 'utf8');
    const section = contract.split('### Separate-process boundary (issue #220)')[1]?.split('## src/serve')[0];
    const examples = [...(section ?? '').matchAll(/```json\s*\n([^\n]+)\n```/g)].map((match) => JSON.parse(match[1]));
    expect(examples).toHaveLength(2);
    const r = await start();
    const c = await connect(r.socketPath);
    try {
      expect(await c.ask(examples[0])).toEqual(examples[1]);
    } finally {
      c.close();
      await r.stop();
    }
  });

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

  it('refuses a socket path that is a regular file, and tightens a loose directory', async () => {
    const file = path.join(dir, 'plain');
    writeFileSync(file, 'keep me');
    await expect(prepareSocketPath(file)).rejects.toThrow(/not a socket; it was left alone/);
    expect(statSync(file).size).toBe(7);
    const loose = path.join(dir, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o777);
    await prepareSocketPath(path.join(loose, 'x.sock'));
    expect(statSync(loose).mode & 0o777).toBe(0o700);
    await expect(prepareSocketPath(path.join(dir, 'a'.repeat(120)))).rejects.toThrow(/longer than 103 bytes/);
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
