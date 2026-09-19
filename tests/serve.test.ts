/**
 * Local HTTP API tests: an in-process `createServer()` on port 0 against a
 * throwaway HOME/LEXICON_PATH, driven with fetch. Nothing here mocks the core.
 * The CLI handlers (`--show`, `--status`, `--install`, `--uninstall`) run with
 * injected deps so no launchctl/systemctl is ever spawned.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addTerm, readLexiconFile } from '../src/core/index.js';
import type { LexiconStats, NormalizeResult } from '../src/core/index.js';
import { createServer, getServePath, isOriginAllowed, readServeConfig, DEFAULT_PORT } from '../src/serve/index.js';
import type { LexiconHttpServer, ServeStartInfo } from '../src/serve/index.js';
import {
  launchAgentPath,
  launchAgentLogPath,
  runServe,
  systemdUnitPath,
  LAUNCH_AGENT_LABEL,
  SYSTEMD_UNIT_NAME,
} from '../src/cli/cmd-serve.js';
import type { ExecResult, ServeExec } from '../src/cli/cmd-serve.js';
import type { IO } from '../src/cli/commands.js';

interface Env {
  home: string;
  globalPath: string;
  /** A cwd with no .lexicon.yaml anywhere above it (inside the temp HOME). */
  cwd: string;
  /** A fake git repo carrying an untrusted .lexicon.yaml. */
  untrustedProject: string;
}

const savedEnv: Record<string, string | undefined> = {};
let env: Env;
let srv: LexiconHttpServer;
let info: ServeStartInfo;

function memIO(): IO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
}

function fakeExec(calls: string[][], code = 0): ServeExec {
  return async (cmd, args): Promise<ExecResult> => {
    calls.push([cmd, ...args]);
    return { code, stdout: '', stderr: code === 0 ? '' : 'nope' };
  };
}

async function api(method: string, route: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${info.token}`, ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${info.url}${route}`, {
    method,
    headers,
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-')));
  const configHome = path.join(home, '.config');
  const globalPath = path.join(configHome, 'lexicon', 'lexicon.yaml');
  const cwd = path.join(home, 'work');
  const untrustedProject = path.join(home, 'hostile');
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(untrustedProject, '.git'), { recursive: true });
  await fs.writeFile(
    path.join(untrustedProject, '.lexicon.yaml'),
    'version: 1\nterms:\n  - canonical: HostileCorp\n    aliases: [hostyle]\n',
    'utf8',
  );
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'LEXICON_PATH', 'LEXICON_TRUST_ALL']) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.LEXICON_PATH = globalPath;
  delete process.env.LEXICON_TRUST_ALL;
  env = { home, globalPath, cwd, untrustedProject };

  await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar'], category: 'brand' }, { globalPath });

  srv = createServer({ port: 0, cwd, globalPath, quiet: true, version: '9.9.9' });
  info = await srv.start();
});

afterAll(async () => {
  await srv.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(env.home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// serve.json
// ---------------------------------------------------------------------------

describe('serve.json', () => {
  it('is created next to the global lexicon with mode 0600 and a 32-hex token', async () => {
    const servePath = getServePath({ globalPath: env.globalPath });
    expect(servePath).toBe(path.join(path.dirname(env.globalPath), 'serve.json'));
    expect(info.configPath).toBe(servePath);
    const stat = await fs.stat(servePath);
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    const config = await readServeConfig({ globalPath: env.globalPath });
    expect(config?.token).toMatch(/^[0-9a-f]{32}$/);
    expect(config?.token).toBe(info.token);
    expect(config?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The live port is recorded so --show/--status find a --port 0 server.
    expect(config?.port).toBe(info.port);
    expect(info.port).toBeGreaterThan(0);
  });

  it('is reused on a second start', async () => {
    const again = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true });
    const second = await again.start();
    try {
      expect(second.token).toBe(info.token);
    } finally {
      await again.stop();
    }
  });

  it('isOriginAllowed accepts extensions and listed origins only, never *', () => {
    expect(isOriginAllowed('chrome-extension://abc')).toBe(true);
    expect(isOriginAllowed('moz-extension://abc')).toBe(true);
    expect(isOriginAllowed('safari-web-extension://abc')).toBe(true);
    expect(isOriginAllowed('https://evil.example')).toBe(false);
    expect(isOriginAllowed('https://ok.example', ['https://ok.example'])).toBe(true);
    expect(isOriginAllowed('https://evil.example', ['*'])).toBe(false);
    expect(isOriginAllowed(undefined)).toBe(false);
  });

  it('exposes the fixed default port', () => {
    expect(DEFAULT_PORT).toBe(41733);
  });
});

// ---------------------------------------------------------------------------
// auth + health
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('GET /health needs no token', async () => {
    const res = await fetch(`${info.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string; terms: number; port: number; projectTrust?: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('9.9.9');
    expect(body.terms).toBe(1);
    expect(body.port).toBe(info.port);
    expect(body.projectTrust).toBeUndefined();
  });

  it('401 without a token and with a wrong token', async () => {
    const none = await fetch(`${info.url}/stats`);
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: expect.stringContaining('bearer token') });
    const wrong = await fetch(`${info.url}/stats`, { headers: { Authorization: `Bearer ${'0'.repeat(32)}` } });
    expect(wrong.status).toBe(401);
    const post = await fetch(`${info.url}/normalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'ping ashler' }),
    });
    expect(post.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

describe('POST /normalize', () => {
  it('corrects "ping ashler" and returns a summary', async () => {
    const res = await api('POST', '/normalize', { text: 'ping ashler' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as NormalizeResult & { summary: string };
    expect(body.output).toBe('ping Ashlr.AI');
    expect(body.changed).toBe(true);
    expect(body.replacements).toHaveLength(1);
    expect(body.replacements[0].canonical).toBe('Ashlr.AI');
    expect(body.summary).toContain('"ashler" -> "Ashlr.AI"');
  });

  it('dryRun does not bump hits; a real run does', async () => {
    const hitsOf = async (): Promise<number> => {
      const file = await readLexiconFile(env.globalPath, 'global');
      return file.lexicon.terms.find((t) => t.canonical === 'Ashlr.AI')?.hits ?? 0;
    };
    const before = await hitsOf();
    const dry = await api('POST', '/normalize', { text: 'ping ashlar', dryRun: true });
    const dryBody = (await dry.json()) as NormalizeResult;
    expect(dryBody.changed).toBe(false);
    expect(dryBody.output).toBe('ping ashlar');
    expect(dryBody.replacements).toHaveLength(1);
    expect(await hitsOf()).toBe(before);

    const real = await api('POST', '/normalize', { text: 'ping ashlar' });
    expect(((await real.json()) as NormalizeResult).output).toBe('ping Ashlr.AI');
    expect(await hitsOf()).toBe(before + 1);
  });

  it('400 on a missing text field', async () => {
    const res = await api('POST', '/normalize', { dryRun: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('text');
  });
});

describe('POST /learn and POST /add', () => {
  it('learn adds an alias to the existing term and the server sees it at once', async () => {
    const res = await api('POST', '/learn', { heard: 'Ashlur', meant: 'Ashlr.AI' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { term: { canonical: string; aliases: string[] }; created: boolean; aliasAdded: boolean; path: string };
    expect(body.created).toBe(false);
    expect(body.aliasAdded).toBe(true);
    expect(body.term.aliases).toContain('Ashlur');
    expect(body.path).toBe(env.globalPath);
    const check = await api('POST', '/normalize', { text: 'Ashlur rocks', dryRun: true });
    expect(((await check.json()) as NormalizeResult).replacements[0]?.reason).toBe('alias');
  });

  it('learn rejects identical spellings with 400', async () => {
    const res = await api('POST', '/learn', { heard: 'Ashlr.AI', meant: 'Ashlr.AI' });
    expect(res.status).toBe(400);
    expect(typeof ((await res.json()) as { error: string }).error).toBe('string');
  });

  it('add creates a term with the MCP add_term shape', async () => {
    const res = await api('POST', '/add', { canonical: 'Entire.io', aliases: ['entire io'], category: 'product' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { term: { canonical: string; aliases: string[]; category?: string }; path: string; created: boolean };
    expect(body).toEqual({
      term: expect.objectContaining({ canonical: 'Entire.io', aliases: ['entire io'], category: 'product' }),
      path: env.globalPath,
      created: true,
    });
    const health = (await (await fetch(`${info.url}/health`)).json()) as { terms: number };
    expect(health.terms).toBe(2);
  });

  it('add validates the category', async () => {
    const res = await api('POST', '/add', { canonical: 'X', category: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('GET /lexicon, /export/:format, /stats', () => {
  it('/lexicon returns the merged lexicon and paths', async () => {
    const res = await api('GET', '/lexicon');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lexicon: { version: number; terms: unknown[] }; paths: { global: string; project?: string }; projectTrust?: string; skippedProject?: string };
    expect(body.lexicon.version).toBe(1);
    expect(body.lexicon.terms.length).toBe(2);
    expect(body.paths.global).toBe(env.globalPath);
    expect(body.paths.project).toBeUndefined();
    expect(body.skippedProject).toBeUndefined();
  });

  it('/export/<format> serves the exporter content type', async () => {
    const csv = await api('GET', '/export/csv');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(await csv.text()).toContain('Ashlr.AI');
    const json = await api('GET', '/export/json');
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const md = await api('GET', '/export/claude-md');
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    const plist = await api('GET', '/export/macos');
    expect(plist.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const yaml = await api('GET', '/export/espanso');
    expect(yaml.headers.get('content-type')).toBe('application/yaml; charset=utf-8');
    const txt = await api('GET', '/export/text');
    expect(txt.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const unknown = await api('GET', '/export/nope');
    expect(unknown.status).toBe(404);
  });

  it('/stats returns LexiconStats', async () => {
    const res = await api('GET', '/stats');
    expect(res.status).toBe(200);
    const body = (await res.json()) as LexiconStats;
    expect(body.termCount).toBe(2);
    expect(body.totalHits).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.topTerms)).toBe(true);
    expect(body.files[0]?.scope).toBe('global');
  });
});

// ---------------------------------------------------------------------------
// CORS, limits, errors
// ---------------------------------------------------------------------------

describe('CORS', () => {
  it('answers a chrome-extension preflight and echoes the origin', async () => {
    const res = await fetch(`${info.url}/normalize`, {
      method: 'OPTIONS',
      headers: { Origin: 'chrome-extension://abcdef', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('chrome-extension://abcdef');
    expect(res.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST');
    const real = await api('POST', '/normalize', { text: 'hi', dryRun: true }, { Origin: 'moz-extension://xyz' });
    expect(real.headers.get('access-control-allow-origin')).toBe('moz-extension://xyz');
  });

  it('sets no CORS headers for a web origin', async () => {
    const pre = await fetch(`${info.url}/normalize`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    const res = await fetch(`${info.url}/health`, { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

describe('limits and errors', () => {
  it('413 on a 2 MB body', async () => {
    const res = await api('POST', '/normalize', JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain('exceeds');
  });

  it('404 on an unknown route', async () => {
    const res = await api('GET', '/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.stringContaining('no route') });
  });

  it('400 on bad JSON and on a non-object body', async () => {
    const bad = await api('POST', '/normalize', '{"text": ');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('not valid JSON');
    const list = await api('POST', '/normalize', '[1]');
    expect(list.status).toBe(400);
  });

  it('405 on the wrong method', async () => {
    const res = await api('GET', '/normalize');
    expect(res.status).toBe(405);
  });

  it('503 once the concurrency cap is reached', async () => {
    const tiny = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true, maxConcurrent: 0 });
    const t = await tiny.start();
    try {
      const res = await fetch(`${t.url}/health`);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
    } finally {
      await tiny.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// trust gate
// ---------------------------------------------------------------------------

describe('trust gate', () => {
  it('never merges an untrusted project file and reports it by path only', async () => {
    const cwd = env.untrustedProject;
    const norm = await api('POST', '/normalize', { text: 'ping hostyle', cwd });
    const body = (await norm.json()) as NormalizeResult;
    expect(body.output).toBe('ping hostyle');
    expect(body.changed).toBe(false);

    const health = await fetch(`${info.url}/health?cwd=${encodeURIComponent(cwd)}`);
    expect(((await health.json()) as { projectTrust?: string }).projectTrust).toBe('untrusted');

    const lex = await api('GET', `/lexicon?cwd=${encodeURIComponent(cwd)}`);
    const lexBody = (await lex.json()) as { projectTrust?: string; skippedProject?: string; lexicon: { terms: { canonical: string }[] } };
    expect(lexBody.projectTrust).toBe('untrusted');
    expect(lexBody.skippedProject).toBe(path.join(cwd, '.lexicon.yaml'));
    expect(lexBody.lexicon.terms.map((t) => t.canonical)).not.toContain('HostileCorp');
    expect(JSON.stringify(lexBody)).not.toContain('hostyle');
  });

  it('refuses a project-scope write into an untrusted file with 403', async () => {
    const res = await api('POST', '/add', { canonical: 'Foo', aliases: ['fooo'], scope: 'project', cwd: env.untrustedProject });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('untrusted');
  });
});

// ---------------------------------------------------------------------------
// CLI handlers
// ---------------------------------------------------------------------------

describe('lexicon serve (CLI)', () => {
  it('--show prints the URL and token', async () => {
    const io = memIO();
    const code = await runServe({ show: true, port: info.port, globalPath: env.globalPath }, io, { home: env.home });
    expect(code).toBe(0);
    const text = io.out.join('');
    expect(text).toContain(`url:    http://127.0.0.1:${info.port}`);
    expect(text).toContain(`token:  ${info.token}`);
    expect(text).toContain('config: ~/.config/lexicon/serve.json');

    const json = memIO();
    await runServe({ show: true, json: true, port: info.port, globalPath: env.globalPath }, json);
    expect(JSON.parse(json.out.join(''))).toEqual({
      url: `http://127.0.0.1:${info.port}`,
      port: info.port,
      token: info.token,
      configPath: info.configPath,
    });
  });

  it('--status reports up against the running server and down otherwise', async () => {
    const up = memIO();
    expect(await runServe({ status: true, port: info.port, globalPath: env.globalPath }, up)).toBe(0);
    expect(up.out.join('')).toContain(`lexicon serve is up at http://127.0.0.1:${info.port} (version 9.9.9, 2 terms)`);

    const closed = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true });
    const c = await closed.start();
    await closed.stop();
    const down = memIO();
    expect(await runServe({ status: true, port: c.port, globalPath: env.globalPath }, down)).toBe(1);
    expect(down.out.join('')).toContain(`lexicon serve is down at http://127.0.0.1:${c.port}`);
  });

  it('--status --json', async () => {
    const io = memIO();
    expect(await runServe({ status: true, json: true, port: info.port, globalPath: env.globalPath }, io)).toBe(0);
    const parsed = JSON.parse(io.out.join('')) as { up: boolean; health: { ok: boolean } };
    expect(parsed.up).toBe(true);
    expect(parsed.health.ok).toBe(true);
  });

  it('refuses two modes at once', async () => {
    const io = memIO();
    expect(await runServe({ show: true, status: true, globalPath: env.globalPath }, io)).toBe(1);
    expect(io.err.join('')).toContain('only one of');
  });

  it('runs in the foreground until the signal fires and prints the listening line', async () => {
    const io = memIO();
    const controller = new AbortController();
    let seen: { port: number; url: string; token: string } | undefined;
    const run = runServe({ port: 0, quiet: true, cwd: env.cwd, globalPath: env.globalPath }, io, {
      home: env.home,
      signal: controller.signal,
      onListening: (i) => {
        seen = i;
      },
    });
    // Wait for the listening callback, then confirm the server answers, then stop it.
    for (let i = 0; i < 200 && !seen; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toBeDefined();
    const health = await fetch(`${seen!.url}/health`);
    expect(health.status).toBe(200);
    controller.abort();
    expect(await run).toBe(0);
    expect(io.out.join('')).toContain(`lexicon serve listening on ${seen!.url} (token in ~/.config/lexicon/serve.json)`);
    expect(io.err.join('')).not.toContain('warning');
  });

  it('warns in red-or-plain when --host is not loopback, and reports a busy port', async () => {
    const io = memIO();
    const controller = new AbortController();
    controller.abort();
    // 0.0.0.0 with an already-aborted signal: starts, warns, stops immediately.
    const code = await runServe({ port: 0, host: '0.0.0.0', quiet: true, cwd: env.cwd, globalPath: env.globalPath }, io, {
      home: env.home,
      signal: controller.signal,
    });
    expect(code).toBe(0);
    expect(io.err.join('')).toContain('exposes the lexicon API to the network');

    const busy = memIO();
    const c2 = new AbortController();
    const code2 = await runServe({ port: info.port, quiet: true, cwd: env.cwd, globalPath: env.globalPath }, busy, {
      home: env.home,
      signal: c2.signal,
    });
    expect(code2).toBe(1);
    expect(busy.err.join('')).toContain('already in use');
  });

  it('--install on macOS writes the LaunchAgent and bootstraps it', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-home-'));
    try {
      const calls: string[][] = [];
      const io = memIO();
      const code = await runServe({ install: true, globalPath: env.globalPath }, io, {
        platform: 'darwin',
        home,
        exec: fakeExec(calls),
        cliPath: '/opt/lexicon/dist/cli/index.js',
        nodePath: '/usr/local/bin/node',
        uid: 501,
      });
      expect(code).toBe(0);
      const plistPath = launchAgentPath(home);
      const plist = await fs.readFile(plistPath, 'utf8');
      expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
      expect(plist).toContain('<string>/usr/local/bin/node</string>\n    <string>/opt/lexicon/dist/cli/index.js</string>\n    <string>serve</string>');
      expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
      expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
      expect(plist).toContain(`<string>${launchAgentLogPath(home)}</string>`);
      expect((await fs.stat(path.dirname(launchAgentLogPath(home)))).isDirectory()).toBe(true);
      expect(calls).toEqual([
        ['launchctl', 'bootout', `gui/501/${LAUNCH_AGENT_LABEL}`],
        ['launchctl', 'bootstrap', 'gui/501', plistPath],
      ]);
      const text = io.out.join('');
      expect(text).toContain(`wrote ${plistPath}`);
      expect(text).toContain('ran: launchctl bootstrap gui/501');

      // bootstrap failing falls back to launchctl load
      const calls2: string[][] = [];
      const io2 = memIO();
      const exec2: ServeExec = async (cmd, args) => {
        calls2.push([cmd, ...args]);
        return args[0] === 'bootstrap' ? { code: 5, stdout: '', stderr: 'Input/output error' } : { code: 0, stdout: '', stderr: '' };
      };
      expect(await runServe({ install: true, globalPath: env.globalPath }, io2, { platform: 'darwin', home, exec: exec2, cliPath: '/x', uid: 501 })).toBe(0);
      expect(calls2[2]).toEqual(['launchctl', 'load', plistPath]);

      // uninstall
      const calls3: string[][] = [];
      const io3 = memIO();
      expect(await runServe({ uninstall: true, globalPath: env.globalPath }, io3, { platform: 'darwin', home, exec: fakeExec(calls3), uid: 501 })).toBe(0);
      expect(calls3[0]).toEqual(['launchctl', 'bootout', `gui/501/${LAUNCH_AGENT_LABEL}`]);
      await expect(fs.access(plistPath)).rejects.toThrow();
      expect(io3.out.join('')).toContain(`removed ${plistPath}`);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('--install on Linux writes the systemd user unit', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-home-'));
    try {
      const calls: string[][] = [];
      const io = memIO();
      const code = await runServe({ install: true, globalPath: env.globalPath }, io, {
        platform: 'linux',
        home,
        env: {},
        exec: fakeExec(calls),
        cliPath: '/opt/lexicon/dist/cli/index.js',
        nodePath: '/usr/bin/node',
      });
      expect(code).toBe(0);
      const unitPath = systemdUnitPath(home, {});
      expect(unitPath).toBe(path.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME));
      const unit = await fs.readFile(unitPath, 'utf8');
      expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/lexicon/dist/cli/index.js" serve');
      expect(unit).toContain('WantedBy=default.target');
      expect(calls).toEqual([
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
      ]);
      expect(io.out.join('')).toContain(`wrote ${unitPath}`);

      const failing = memIO();
      expect(await runServe({ install: true, globalPath: env.globalPath }, failing, { platform: 'linux', home, env: {}, exec: fakeExec([], 1), cliPath: '/x' })).toBe(1);

      const calls2: string[][] = [];
      expect(await runServe({ uninstall: true, globalPath: env.globalPath }, memIO(), { platform: 'linux', home, env: {}, exec: fakeExec(calls2) })).toBe(0);
      expect(calls2[0]).toEqual(['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT_NAME]);
      await expect(fs.access(unitPath)).rejects.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('--install on Windows prints Scheduled Task instructions and writes nothing', async () => {
    const calls: string[][] = [];
    const io = memIO();
    const code = await runServe({ install: true, globalPath: env.globalPath }, io, {
      platform: 'win32',
      home: 'C:\\Users\\me',
      exec: fakeExec(calls),
      cliPath: 'C:\\lexicon\\dist\\cli\\index.js',
      nodePath: 'C:\\node\\node.exe',
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    const text = io.out.join('');
    expect(text).toContain('schtasks /Create /SC ONLOGON');
    expect(text).toContain('Nothing was written.');
  });
});
