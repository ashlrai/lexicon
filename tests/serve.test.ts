/**
 * Local HTTP API tests: an in-process `createServer()` on port 0 against a
 * throwaway HOME/LEXICON_PATH, driven with fetch. Nothing here mocks the core.
 * The CLI handlers (`--show`, `--status`, `--install`, `--uninstall`) run with
 * injected deps so no launchctl/systemctl is ever spawned.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The real schema module with `parseLexicon` counted, so the trust gate tests
 * can tell whether an untrusted project file was parsed at all. Behaviour is
 * unchanged: every call goes to the real validator.
 */
const schemaParses = vi.hoisted(() => ({ canonicals: [] as string[] }));
vi.mock('../src/core/schema.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/schema.js')>();
  return {
    ...real,
    parseLexicon: (raw: unknown) => {
      const terms = (raw as { terms?: unknown } | null)?.terms;
      if (Array.isArray(terms)) {
        for (const t of terms) if (typeof (t as { canonical?: unknown })?.canonical === 'string') schemaParses.canonicals.push((t as { canonical: string }).canonical);
      }
      return real.parseLexicon(raw);
    },
  };
});
import { EXPORT_FORMATS, addTerm, exportLexicon, loadLexicon, readLexiconFile, suggestAliases, trustProject, untrustProject } from '../src/core/index.js';
import type { LexiconStats, NormalizeResult } from '../src/core/index.js';
import {
  createServer,
  ensureServeConfig,
  errorStatus,
  getServePath,
  isLoopbackAddress,
  isAllowedHost,
  isOriginAllowed,
  isPairHost,
  pairPageHtml,
  readServeConfig,
  DEFAULT_PORT,
  EXPORT_NOTE_HEADER,
  NORMALIZE_BUDGET_MS,
  PAIR_HEADERS,
  PAIR_META,
} from '../src/serve/index.js';
import type { LexiconHttpServer, ServeStartInfo } from '../src/serve/index.js';
import {
  browserOpenCommand,
  launchAgentPath,
  launchAgentLogPath,
  pairUrl,
  programPathFromTaskXml,
  runServe,
  scheduledTaskName,
  scheduledTaskXml,
  serveEnvFile,
  nodeSupportsEnvFile,
  systemdUnit,
  systemdUnitPath,
  taskUserId,
  LAUNCH_AGENT_LABEL,
  SCHEDULED_TASK_NAME,
  SERVE_LABEL_ENV_VAR,
  SYSTEMD_UNIT_NAME,
  SERVE_ENV_FILE_NAME,
} from '../src/cli/cmd-serve.js';
import { programPathFromPlist, programPathFromUnit } from '../src/cli/serve-paths.js';
import type { ExecResult, ServeExec } from '../src/cli/cmd-serve.js';
import type { IO } from '../src/cli/commands.js';
import { FileLockError } from '../src/util/atomic.js';
import { InputError } from '../src/util/errors.js';

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

/** A CLI entry file that exists, so --install accepts it (it refuses paths that do not). */
async function fakeCli(home: string, rel = 'opt/lexicon/dist/cli/index.js'): Promise<string> {
  const file = path.join(home, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '#!/usr/bin/env node\n', 'utf8');
  return file;
}

/** Raw GET with an arbitrary Host header (undici's fetch silently replaces Host). */
function rawGet(
  route: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: info.port, path: route, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        body += d;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
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
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'LEXICON_PATH', 'LEXICON_TRUST_ALL']) {
    savedEnv[key] = process.env[key];
  }
  process.env.HOME = home;
  // os.homedir() reads USERPROFILE on Windows and ignores HOME.
  process.env.USERPROFILE = home;
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
  await fs.rm(env.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

  // Catches: an existing serve.json was reused with whatever mode it had
  // (restored from a backup, synced, copied, hand-written: usually 0644), and
  // only a port change rewrote it, so the token stayed readable by any local
  // account for as long as the server ran.
  it.skipIf(process.platform === 'win32')('an existing serve.json readable by others is put back to 0600 when it is reused', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-mode-'));
    try {
      const gp = path.join(dir, 'lexicon.yaml');
      const servePath = getServePath({ globalPath: gp });
      const token = 'ab'.repeat(16);
      await fs.writeFile(servePath, JSON.stringify({ port: 41733, token, createdAt: '2026-01-01T00:00:00.000Z' }), { mode: 0o644 });
      await fs.chmod(servePath, 0o644);
      expect((await ensureServeConfig({ globalPath: gp })).token).toBe(token);
      expect((await fs.stat(servePath)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

  /**
   * Catches: `ensureServeConfig` reading and then creating without a lock,
   * and `writeServeConfig` sharing a temp file name with every other writer.
   *
   * serve.json holds the bearer token for the local API, so the loser of that
   * race walks away with a token the server answers 401 to: the browser
   * extension, Shortcuts, Raycast and the menu bar app all find the server
   * and are all refused, with nothing saying why. It is the same gap
   * `trust.json` had, and the sidecar added in 0.5.3 was correctly locked,
   * which is what made these two the odd ones out.
   *
   * Real processes, because that is the case: several clients starting
   * `lexicon serve` at login.
   */
  it('mints one token when six processes reach first run together', async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-token-')));
    try {
      const globalPath = path.join(home, 'config', 'lexicon.yaml');
      const script = path.join(home, 'ensure.mts');
      const configModule = new URL('../src/serve/config.ts', import.meta.url).href;
      await fs.writeFile(
        script,
        [
          `import { ensureServeConfig } from ${JSON.stringify(configModule)};`,
          'const [globalPath] = process.argv.slice(2);',
          'const config = await ensureServeConfig({ globalPath, cwd: process.cwd() });',
          'process.stdout.write(config.token);',
        ].join('\n'),
      );

      const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
      const run = (): Promise<string> =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--import', 'tsx', script, globalPath], {
            cwd: repoRoot,
            env: { ...process.env, LEXICON_PATH: '', XDG_CONFIG_HOME: '' },
          });
          let out = '';
          let err = '';
          child.stdout.on('data', (d: Buffer) => (out += d.toString()));
          child.stderr.on('data', (d: Buffer) => (err += d.toString()));
          child.once('error', reject);
          child.once('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err || out))));
        });

      const tokens = await Promise.all(Array.from({ length: 6 }, () => run()));
      const stored = await readServeConfig({ globalPath });
      expect(stored?.token).toMatch(/^[0-9a-f]{32}$/);
      // Every client believes the token that is actually on disk.
      expect(new Set([...tokens, stored?.token]).size).toBe(1);
    } finally {
      await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// auth + health
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('a wrong method on /health is 405, not 401, without a token', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`${info.url}/health`, { method });
      expect(res.status).toBe(405);
      expect(((await res.json()) as { error: string }).error).toBe('use GET');
    }
  });

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
    // Catches: the 401 named only `lexicon serve --show`, not `--pair`,
    // which is how a browser extension user gets the token.
    expect(await none.json()).toEqual({
      error: 'missing or invalid bearer token (pair the browser extension with: lexicon serve --pair; for any other client, copy the token from: lexicon serve --show)',
    });
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

/**
 * Catches: only /pair checking Host. Through DNS rebinding a page on
 * evil.example resolves its own name to 127.0.0.1, so its requests reach the
 * server with `Host: evil.example:<port>`; /health?cwd= then told it whether
 * any directory has a .lexicon.yaml and whether it is trusted.
 */
describe('Host guard (DNS rebinding)', () => {
  it('refuses a foreign Host on every route, with or without the token', async () => {
    const routes: [string, string][] = [
      ['GET', '/health'],
      ['GET', `/health?cwd=${encodeURIComponent(env.untrustedProject)}`],
      ['GET', '/stats'],
      ['GET', '/lexicon'],
      ['POST', '/normalize'],
      ['OPTIONS', '/normalize'],
      ['GET', '/nope'],
    ];
    for (const [method, route] of routes) {
      for (const host of ['evil.example', `evil.example:${info.port}`, `127.0.0.1.evil.example:${info.port}`]) {
        const res = await rawGet(route, { Host: host, Authorization: `Bearer ${info.token}` }, method);
        expect(res.status, `${method} ${route} Host ${host}`).toBe(403);
        expect(res.body).not.toContain('projectTrust');
        expect((JSON.parse(res.body) as { error: string }).error).toContain('Host');
      }
    }
  });

  it('accepts 127.0.0.1, localhost and [::1] on the bound port only', async () => {
    for (const host of [`127.0.0.1:${info.port}`, `localhost:${info.port}`, `LocalHost:${info.port}`, `[::1]:${info.port}`]) {
      const res = await rawGet('/health', { Host: host });
      expect(res.status, host).toBe(200);
    }
    for (const host of ['127.0.0.1', `127.0.0.1:${info.port + 1}`, `[::1]:${info.port + 1}`]) {
      const res = await rawGet('/health', { Host: host });
      expect(res.status, host).toBe(403);
    }
  });

  it('isAllowedHost accepts the bound IP for a non-loopback --host, never a name', () => {
    expect(isAllowedHost('192.168.1.5:41733', 41733, '192.168.1.5')).toBe(true);
    expect(isAllowedHost('192.168.1.6:41733', 41733, '192.168.1.5')).toBe(false);
    expect(isAllowedHost('192.168.1.6:41733', 41733, '0.0.0.0')).toBe(true);
    expect(isAllowedHost('[fe80::1]:41733', 41733, '::')).toBe(true);
    expect(isAllowedHost('evil.example:41733', 41733, '0.0.0.0')).toBe(false);
    expect(isAllowedHost('192.168.1.5:41733', 41733)).toBe(false);
    expect(isAllowedHost(undefined, 41733)).toBe(false);
  });

  it('/health takes ?cwd= only with the bearer token', async () => {
    const q = `/health?cwd=${encodeURIComponent(env.untrustedProject)}`;
    const anon = await fetch(`${info.url}${q}`);
    expect(anon.status).toBe(401);
    // Catches: this 401 named only `lexicon serve --show` after the main 401
    // learned `--pair`, how an extension user gets the token.
    expect(await anon.json()).toEqual({
      error:
        '/health?cwd= needs the bearer token, which plain /health does not (pair the browser extension with: lexicon serve --pair; for any other client, copy the token from: lexicon serve --show)',
    });
    const authed = await api('GET', q);
    expect(authed.status).toBe(200);
    expect(((await authed.json()) as { projectTrust?: string }).projectTrust).toBe('untrusted');
  });

  // Catches: /health was the one GET route without strictQuery, so a typo
  // such as `?cdw=` answered 200 for the server's own directory.
  it('/health refuses an unknown or repeated query parameter, with or without the token', async () => {
    for (const res of [await fetch(`${info.url}/health?cdw=x`), await api('GET', '/health?cdw=x')]) {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('unknown query parameter "cdw" (GET /health takes cwd)');
    }
    const twice = await api('GET', `/health?cwd=${encodeURIComponent(env.cwd)}&cwd=${encodeURIComponent(env.cwd)}`);
    expect(twice.status).toBe(400);
    expect((await fetch(`${info.url}/health`)).status).toBe(200);
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
      // Counts live in the hits.json sidecar; the merged view adds them up.
      const loaded = await loadLexicon({ globalPath: env.globalPath });
      return loaded.merged.terms.find((t) => t.canonical === 'Ashlr.AI')?.hits ?? 0;
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

  it('stops matching once its time budget is spent, so one huge paste cannot stall the server', async () => {
    // A 1 MB body against a large lexicon took many seconds of a single-threaded
    // server: every other client waited, and the extension (1.5 s timeout) fell
    // back while its send hung. Same contract as the hook: the corrections
    // found before the budget ran out, never a stall.
    expect(NORMALIZE_BUDGET_MS).toBeGreaterThan(0);
    expect(NORMALIZE_BUDGET_MS).toBeLessThan(1500);
    const tight = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true, normalizeBudgetMs: 0 });
    const t = await tight.start();
    try {
      const call = async (text: string): Promise<NormalizeResult> =>
        (await (
          await fetch(`${t.url}/normalize`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, dryRun: true }),
          })
        ).json()) as NormalizeResult;
      // The first token is always matched; the budget is checked before each later one.
      expect((await call('ashler hello')).replacements).toHaveLength(1);
      const cut = (await call('hello ashler')) as NormalizeResult & { incomplete?: { reasons: string[]; totalChars: number; note: string } };
      expect(cut.replacements).toHaveLength(0);
      // Without this the cut-short body reads as fully checked.
      expect(cut.incomplete).toMatchObject({ reasons: ['time'], totalChars: 12 });
      expect(cut.incomplete?.note).toMatch(/0 ms budget/);
      // A one-token body never polls the budget, so it is complete.
      expect((await call('ashler')) as object).not.toHaveProperty('incomplete');
    } finally {
      await tight.stop();
    }
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

  // Catches: POST /learn of a spelling the term already held answered only
  // created: false and aliasAdded: false, with no word that nothing was
  // written, while POST /add and MCP learn_correction say so.
  it('learn of a spelling the term already has says nothing was added', async () => {
    const first = await api('POST', '/learn', { heard: 'Ashlurr', meant: 'Ashlr.AI' });
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody).toMatchObject({ aliasAdded: true });
    expect(firstBody).not.toHaveProperty('unchanged');
    expect(firstBody).not.toHaveProperty('note');
    const before = await fs.readFile(env.globalPath, 'utf8');
    const again = await api('POST', '/learn', { heard: 'Ashlurr', meant: 'Ashlr.AI' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({
      created: false,
      aliasAdded: false,
      unchanged: true,
      note: 'Nothing was added: "Ashlurr" was already an alias of "Ashlr.AI".',
    });
    // The canonical itself in another case: also nothing to write.
    const casing = await api('POST', '/learn', { heard: 'ashlr.ai', meant: 'Ashlr.AI' });
    expect(await casing.json()).toMatchObject({
      created: false,
      aliasAdded: false,
      unchanged: true,
      note: 'Nothing was added: "Ashlr.AI" is already the canonical spelling; "ashlr.ai" is corrected to it.',
    });
    expect(await fs.readFile(env.globalPath, 'utf8')).toBe(before);
  });

  it('add over the schema cap is a 400 naming the field, not an index into the lexicon file', async () => {
    const res = await api('POST', '/add', { canonical: 'Zed', aliases: ['x'.repeat(81)] });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^term not added: aliases\[0\] \("x{24}\.\.\."\): must be at most 80 characters\. Nothing was written/);
    expect(error).not.toContain('terms[');
    expect((await api('GET', '/stats')).status).toBe(200);
  });

  // Catches: over the 60-character cap the 400 said only the cap, though the
  // usual cause is a whole phrase sent as heard (MCP learn_correction says so).
  it('learn over the length cap is a 400 that says to send only the name', async () => {
    const res = await api('POST', '/learn', { heard: 'so I was saying that we should deploy the thing to Hetsner tomorrow', meant: 'Hetzner' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      'heard must be at most 60 characters; nothing was written. Pass only the misspelled name as heard and the name the user wants as meant, not the sentence around them.',
    );
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

  it('add with only never on an existing term appends no generated aliases', async () => {
    const before = (await (await api('GET', '/lexicon')).json()) as { lexicon: { terms: { canonical: string; aliases: string[] }[] } };
    const existing = before.lexicon.terms.find((t) => t.canonical === 'Ashlr.AI');
    expect(existing).toBeDefined();
    const res = await api('POST', '/add', { canonical: 'Ashlr.AI', never: ['ashes'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { term: { aliases: string[]; never?: string[] }; created: boolean };
    expect(body.created).toBe(false);
    expect(body.term.aliases).toEqual(existing?.aliases);
    expect(body.term.never).toContain('ashes');
  });

  // Catches: POST /add answered a bare success for an alias another term
  // already holds, while MCP add_term and `lexicon add --json` report it as
  // `conflicts`; the alias may keep correcting to the other term.
  it('add reports an alias another term already holds as conflicts, as MCP add_term does', async () => {
    // A trusted project file of its own, so the shared global lexicon other cases count stays as it is.
    const repo = path.join(env.home, 'add-conflict-repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const file = path.join(repo, '.lexicon.yaml');
    await fs.writeFile(file, 'version: 1\nterms: []\n', 'utf8');
    await trustProject(file, { globalPath: env.globalPath });
    try {
      const res = await api('POST', '/add', { canonical: 'Ashley', aliases: ['Ashler', 'ashleigh'], scope: 'project', cwd: repo });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { created: boolean; path: string; conflicts?: unknown };
      expect(body.created).toBe(true);
      expect(body.path).toBe(file);
      expect(body.conflicts).toEqual([{ canonical: 'Ashlr.AI', scope: 'global', as: 'alias', spelling: 'Ashler' }]);
      // No conflict, no key: the documented shape is unchanged.
      const clean = (await (await api('POST', '/add', { canonical: 'Zorkmid', aliases: ['zork mid'], scope: 'project', cwd: repo })).json()) as Record<string, unknown>;
      expect(clean).not.toHaveProperty('conflicts');
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  // Catches: POST /learn answered `conflict` alone while `lexicon learn
  // --json` pairs it with a `note` naming the scoped remove command, so a
  // serve client had to build that command itself.
  it('learn pairs a conflict with the note naming the scoped lexicon remove command', async () => {
    const repo = path.join(env.home, 'learn-conflict-repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const file = path.join(repo, '.lexicon.yaml');
    await fs.writeFile(file, 'version: 1\nterms: []\n', 'utf8');
    await trustProject(file, { globalPath: env.globalPath });
    try {
      const res = await api('POST', '/learn', { heard: 'Ashler', meant: 'Ashley', scope: 'project', cwd: repo });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { conflict?: unknown; note?: string };
      expect(body.conflict).toEqual({ canonical: 'Ashlr.AI', scope: 'global', as: 'alias', spelling: 'Ashler' });
      expect(body.note).toContain('lexicon remove "Ashlr.AI" --alias "Ashler" --global');
      // No conflict, no note.
      const clean = (await (await api('POST', '/learn', { heard: 'zork mid', meant: 'Zorkmid', scope: 'project', cwd: repo })).json()) as Record<string, unknown>;
      expect(clean).not.toHaveProperty('conflict');
      expect(clean).not.toHaveProperty('note');
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  // Catches: POST /add of an alias the term already has answered 200 with
  // created: false and nothing else, though nothing was written, while
  // `lexicon add --json` and MCP add_term say unchanged.
  it('add of an alias the term already has says nothing was added', async () => {
    const repo = path.join(env.home, 'add-unchanged-repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const file = path.join(repo, '.lexicon.yaml');
    await fs.writeFile(file, 'version: 1\nterms: []\n', 'utf8');
    await trustProject(file, { globalPath: env.globalPath });
    try {
      const add = { canonical: 'Quuxly', aliases: ['cooks lee'], scope: 'project', cwd: repo };
      const first = (await (await api('POST', '/add', add)).json()) as Record<string, unknown>;
      expect(first).toMatchObject({ created: true });
      expect(first).not.toHaveProperty('unchanged');
      expect(first).not.toHaveProperty('note');
      const before = await fs.readFile(file, 'utf8');
      const res = await api('POST', '/add', add);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ created: false, unchanged: true, note: 'Nothing was added: "Quuxly" already has every alias and field given.' });
      expect(await fs.readFile(file, 'utf8')).toBe(before);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
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

  // Catches: paths.project named the skipped (untrusted) file while MCP list_terms listed only loaded files.
  it('/lexicon paths lists the files merged, as MCP list_terms does', async () => {
    const skipped = (await (await api('GET', `/lexicon?cwd=${encodeURIComponent(env.untrustedProject)}`)).json()) as {
      paths: { global: string; project?: string };
      skippedProject?: string;
    };
    expect(skipped.paths).toEqual({ global: env.globalPath });
    expect(skipped.skippedProject).toBe(path.join(env.untrustedProject, '.lexicon.yaml'));

    const repo = path.join(env.home, 'trusted-repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const file = path.join(repo, '.lexicon.yaml');
    await fs.writeFile(file, 'version: 1\nterms:\n  - canonical: TrustedCorp\n    aliases: [trustcorp]\n', 'utf8');
    await trustProject(file, { globalPath: env.globalPath });
    try {
      const trusted = (await (await api('GET', `/lexicon?cwd=${encodeURIComponent(repo)}`)).json()) as {
        paths: { global: string; project?: string };
        projectTrust?: string;
        skippedProject?: string;
      };
      expect(trusted.paths).toEqual({ global: env.globalPath, project: file });
      expect(trusted.projectTrust).toBe('trusted');
      expect(trusted.skippedProject).toBeUndefined();
    } finally {
      await untrustProject(file, { globalPath: env.globalPath });
    }
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
    // Format names resolve like the CLI's: any case, aliases included.
    const upper = await api('GET', '/export/Wispr-Flow');
    expect(upper.status).toBe(200);
    expect(upper.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const unknown = await api('GET', '/export/nope');
    expect(unknown.status).toBe(404);
    // Catches: the 404 named the bad format but not the ones to choose from, as MCP export_lexicon does.
    expect(((await unknown.json()) as { error: string }).error).toBe(`unknown export format "nope" (one of: ${EXPORT_FORMATS.join(', ')})`);
  });

  // Catches: /export ignored ?category= and ?limit= (which `lexicon export`
  // and MCP export_lexicon take) and returned every term with 200, and every
  // GET route dropped an unknown query parameter, so a typo such as ?cdw=
  // answered for the server's own directory as if nothing were wrong.
  it('/export/<format> applies ?category= and ?limit=, and refuses bad values', async () => {
    const lines = async (route: string): Promise<string[]> => {
      const res = await api('GET', route);
      expect(res.status).toBe(200);
      return (await res.text()).split('\n').filter((l) => l !== '');
    };
    // The lexicon holds Ashlr.AI (brand) and Entire.io (product, added by the /add test above).
    const canonicals = async (route: string): Promise<string[]> => (await lines(route)).map((l) => l.split(':')[0]);
    expect(await canonicals('/export/text')).toEqual(['Ashlr.AI', 'Entire.io']);
    expect(await canonicals('/export/text?category=brand')).toEqual(['Ashlr.AI']);
    expect(await canonicals('/export/text?category=Product')).toEqual(['Entire.io']);
    expect(await canonicals('/export/text?category=brand,product')).toEqual(['Ashlr.AI', 'Entire.io']);
    expect(await canonicals('/export/text?category=brand&category=product')).toEqual(['Ashlr.AI', 'Entire.io']);
    expect(await canonicals('/export/text?category=person')).toEqual([]);
    expect(await lines('/export/text?limit=1')).toHaveLength(1);

    const badCategory = await api('GET', '/export/text?category=nope');
    expect(badCategory.status).toBe(400);
    expect(((await badCategory.json()) as { error: string }).error).toBe(
      'unknown category "nope" (one of: brand, person, product, acronym, identifier, place, other)',
    );
    for (const limit of ['0', '-1', 'abc', '1.5']) {
      const res = await api('GET', `/export/text?limit=${limit}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(`limit must be a positive integer, got "${limit}"`);
    }
  });

  it('GET routes refuse an unknown or repeated query parameter', async () => {
    const cases: [string, string][] = [
      ['/export/csv?categories=brand', 'unknown query parameter "categories" (GET /export/:format takes cwd, category, limit)'],
      ['/lexicon?cdw=/tmp', 'unknown query parameter "cdw" (GET /lexicon takes cwd)'],
      ['/stats?verbose=1', 'unknown query parameter "verbose" (GET /stats takes cwd)'],
      ['/packs?registry=x', 'unknown query parameter "registry" (GET /packs takes cwd)'],
      ['/aliases?canonical=Vercel&limit=3', 'unknown query parameter "limit" (GET /aliases takes canonical)'],
      [`/lexicon?cwd=${encodeURIComponent(env.cwd)}&cwd=${encodeURIComponent(env.cwd)}`, 'query parameter "cwd" given more than once'],
      ['/export/text?limit=1&limit=2', 'query parameter "limit" given more than once'],
    ];
    for (const [route, error] of cases) {
      const res = await api('GET', route);
      expect(res.status, route).toBe(400);
      expect(((await res.json()) as { error: string }).error, route).toBe(error);
    }
    // The parameters each route does take still work.
    expect((await api('GET', `/stats?cwd=${encodeURIComponent(env.cwd)}`)).status).toBe(200);
    expect((await api('GET', '/aliases?canonical=Vercel')).status).toBe(200);
  });

  it('/stats returns LexiconStats', async () => {
    const res = await api('GET', '/stats');
    expect(res.status).toBe(200);
    const body = (await res.json()) as LexiconStats;
    expect(body.termCount).toBe(2);
    expect(body.totalHits).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.topTerms)).toBe(true);
    expect(body.files[0]?.scope).toBe('global');
    expect(body).not.toHaveProperty('skippedProject');
  });

  // Catches: /stats counted without a skipped (untrusted) project file and
  // said nothing, while /lexicon, /packs and `stats --json` name it.
  it('/stats names a skipped project file, path only, as /lexicon does', async () => {
    const res = await api('GET', `/stats?cwd=${encodeURIComponent(env.untrustedProject)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as LexiconStats & { projectTrust?: string; skippedProject?: string };
    expect(body.projectTrust).toBe('untrusted');
    expect(body.skippedProject).toBe(path.join(env.untrustedProject, '.lexicon.yaml'));
    expect(body.files.map((f) => f.scope)).toEqual(['global']);
  });
});

// ---------------------------------------------------------------------------
// GET /pair (extension pairing page)
// ---------------------------------------------------------------------------

describe('GET /pair', () => {
  it('serves the token in a <meta> tag to a loopback Host, with the hardening headers and no bearer', async () => {
    const res = await fetch(`${info.url}/pair`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    for (const [name, value] of Object.entries(PAIR_HEADERS)) expect(res.headers.get(name)).toBe(value);
    const html = await res.text();
    expect(html).toContain(`<meta name="${PAIR_META.token}" content="${info.token}">`);
    expect(html).toContain(`<meta name="${PAIR_META.port}" content="${info.port}">`);
    expect(html).toContain(`<meta name="${PAIR_META.version}" content="9.9.9">`);
    expect(html).toContain('Pairing Lexicon');
    expect(html).toContain('id="status"');
    expect(html).toContain('id="install"');
    // No script and no external request: the CSP forbids both.
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('accepts Host localhost:<port> and refuses any other Host with 403', async () => {
    const ok = await rawGet('/pair', { Host: `localhost:${info.port}` });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain(info.token);
    for (const host of ['evil.example', `evil.example:${info.port}`, '127.0.0.1:1', 'localhost', `[::1]:${info.port}`]) {
      const res = await rawGet('/pair', { Host: host });
      expect(res.status, host).toBe(403);
      const body = JSON.parse(res.body) as { error: string };
      expect(body.error).toContain('Host');
      expect(res.body).not.toContain(info.token);
    }
    // With the token the Host rule still applies: the page is not a bearer route.
    const withToken = await rawGet('/pair', { Host: 'evil.example', Authorization: `Bearer ${info.token}` });
    expect(withToken.status).toBe(403);
    // Only GET.
    expect((await fetch(`${info.url}/pair`, { method: 'POST' })).status).toBe(405);
  });

  it('never hands the token to another origin: no CORS headers, and 403 to a cross-origin fetch', async () => {
    // CORS is granted to every browser-extension origin for the API routes,
    // which are useless without the token. /pair carries the token, so any
    // installed extension (or an allowedOrigins page) that could read it
    // cross-origin would get the whole API. The extension reads the page
    // through a content script on a navigation, which sends no Origin.
    for (const origin of ['chrome-extension://someoneelse', 'moz-extension://other', 'https://evil.example', 'null']) {
      const res = await rawGet('/pair', { Host: `127.0.0.1:${info.port}`, Origin: origin });
      expect(res.status, origin).toBe(403);
      expect(res.headers['access-control-allow-origin'], origin).toBeUndefined();
      expect(res.body).not.toContain(info.token);
    }
    const pre = await fetch(`${info.url}/pair`, {
      method: 'OPTIONS',
      headers: { Origin: 'chrome-extension://someoneelse', 'Access-Control-Request-Method': 'GET' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    // Its own origin (a same-origin request that carries one) is still served.
    const same = await rawGet('/pair', { Host: `127.0.0.1:${info.port}`, Origin: `http://127.0.0.1:${info.port}` });
    expect(same.status).toBe(200);
    expect(same.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('isPairHost / isLoopbackAddress / pairPageHtml', () => {
    expect(isPairHost('127.0.0.1:41733', 41733)).toBe(true);
    expect(isPairHost('LOCALHOST:41733 ', 41733)).toBe(true);
    expect(isPairHost('127.0.0.1:41733', 41734)).toBe(false);
    expect(isPairHost('127.0.0.1', 41733)).toBe(false);
    expect(isPairHost('evil.example:41733', 41733)).toBe(false);
    expect(isPairHost(undefined, 41733)).toBe(false);
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    // Attribute values are escaped, so a hostile version string cannot break out of the tag.
    const html = pairPageHtml({ token: 'abc', port: 1, version: '1"><script>' });
    expect(html).toContain('content="1&quot;&gt;&lt;script&gt;"');
    expect(html).not.toContain('<script>');
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
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE');
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

  it('the unknown-route 404 lists every route, method and path', async () => {
    const res = await api('POST', '/normalise');
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    // Same shape as every other error: one `error` string.
    expect(Object.keys(body)).toEqual(['error']);
    // Catches: the 404 said only "no route for POST /normalise", so a client
    // that guessed a path had to go read the docs for the real ones.
    expect(body.error).toBe(
      'no route for POST /normalise (routes: GET /health, GET /pair, POST /normalize, POST /learn, POST /add, ' +
        'GET /lexicon, GET /stats, GET /packs, POST /packs/:name, DELETE /packs/:name, GET /aliases, GET /export/:format)',
    );
  });

  it('400 on bad JSON and on a non-object body', async () => {
    const bad = await api('POST', '/normalize', '{"text": ');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('not valid JSON');
    const list = await api('POST', '/normalize', '[1]');
    expect(list.status).toBe(400);
  });

  // Catches: a body 400 named what was wrong but not the fields the route
  // takes: `{}` to /normalize read "text: Invalid input: expected string,
  // received undefined", an empty body only "must be a JSON object", so a
  // first request built by guesswork had to go read the docs.
  it('every body 400 names the fields its route takes', async () => {
    const cases: [string, unknown, string][] = [
      ['/normalize', {}, 'POST /normalize takes { text, dryRun?, minConfidence?, cwd? }'],
      ['/normalize', '{"text": ', 'POST /normalize takes { text, dryRun?, minConfidence?, cwd? }'],
      ['/learn', '[1]', 'POST /learn takes { heard, meant, scope?, cwd? }'],
      ['/learn', { heard: 'x' }, 'POST /learn takes { heard, meant, scope?, cwd? }'],
      ['/add', { name: 'Zed' }, 'POST /add takes { canonical, aliases?, phonetic?, category?, notes?, never?, scope?, cwd? }'],
      ['/packs/developer', { scop: 'project' }, 'POST /packs/:name takes { scope?, cwd? } or an empty body'],
    ];
    for (const [route, body, takes] of cases) {
      const res = await api('POST', route, body);
      expect(res.status, route).toBe(400);
      expect(((await res.json()) as { error: string }).error, route).toContain(`(${takes})`);
    }
    const empty = await fetch(`${info.url}/normalize`, { method: 'POST', headers: { Authorization: `Bearer ${info.token}` } });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'request body must be a JSON object (POST /normalize takes { text, dryRun?, minConfidence?, cwd? })' });
  });

  /**
   * Catches: every plain Error mapped to 400. A broken lexicon file or a lock
   * that never frees is the server's problem, not the request's, and a 400
   * told clients (the extension, the menu bar app) to stop retrying and blame
   * their own input.
   */
  it('500 with a readable message for a broken lexicon file; 400 stays for bad input', async () => {
    const dir = await fs.mkdtemp(path.join(env.home, 'broken-'));
    const globalPath = path.join(dir, 'lexicon.yaml');
    await fs.writeFile(globalPath, 'version: 1\nterms: [\n', 'utf8');
    const broken = createServer({ port: 0, cwd: env.cwd, globalPath, quiet: true });
    const t = await broken.start();
    try {
      const auth = { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' };
      const stats = await fetch(`${t.url}/stats`, { headers: auth });
      expect(stats.status).toBe(500);
      const msg = ((await stats.json()) as { error: string }).error;
      expect(msg).toContain('Failed to parse lexicon YAML');
      expect(msg).toContain(globalPath);
      const norm = await fetch(`${t.url}/normalize`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'x' }) });
      expect(norm.status).toBe(500);
      // Without the token the detail (a file path) stays in the server log.
      const health = await fetch(`${t.url}/health`);
      expect(health.status).toBe(500);
      expect(await health.text()).not.toContain(globalPath);
    } finally {
      await broken.stop();
    }
    for (const body of [{ heard: 'same', meant: 'same' }, { heard: '', meant: 'Foo' }]) {
      const res = await api('POST', '/learn', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await api('POST', '/add', { canonical: '   ' })).status).toBe(400);
  });

  // Catches: a lock another writer still held at the timeout mapped to 500,
  // which tells a client to report rather than to retry.
  it('errorStatus: a lock another writer holds is 503, other lock failures and fs errors 500, input errors 400', () => {
    expect(errorStatus(new FileLockError('/x/lexicon.yaml', '/x/lexicon.yaml.lock', 'still held after 5000ms', { held: true }))).toBe(503);
    expect(errorStatus(new FileLockError('/x/lexicon.yaml', '/x/lexicon.yaml.lock', '/x is not a directory'))).toBe(500);
    expect(errorStatus(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))).toBe(500);
    expect(errorStatus(new Error('Invalid lexicon at /x: bad'))).toBe(500);
    expect(errorStatus(new TypeError('x is undefined'))).toBe(500);
    expect(errorStatus(new InputError('canonical must not be empty'))).toBe(400);
  });

  // Catches: a write that waited out the lock another lexicon process held
  // answered 500 "internal error", with no Retry-After and no word to retry.
  it('a write while another writer holds the lexicon lock is a 503 that says to retry', async () => {
    const dir = await fs.mkdtemp(path.join(env.home, 'locked-'));
    const globalPath = path.join(dir, 'lexicon.yaml');
    await fs.writeFile(globalPath, 'version: 1\nterms: []\n', 'utf8');
    const locked = createServer({ port: 0, cwd: env.cwd, globalPath, quiet: true });
    const t = await locked.start();
    // A live pid on this host with a token that is not the server's: what a
    // second lexicon process mid-write looks like.
    const lockPath = `${globalPath}.lock`;
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'someone-else', at: new Date().toISOString() }));
    try {
      const res = await fetch(`${t.url}/add`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonical: 'Lockly', aliases: ['lock lee'] }),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      const { error } = (await res.json()) as { error: string };
      expect(error).toMatch(/^another writer is still using the lexicon file: could not lock .* for writing: still held after \d+ms by .*; retry after 1 second \(Retry-After\)$/);
      expect(error).toContain(globalPath);
      expect(await fs.readFile(globalPath, 'utf8')).toBe('version: 1\nterms: []\n');
    } finally {
      await fs.rm(lockPath, { force: true });
      await locked.stop();
    }
  }, 60_000);

  it('405 on the wrong method', async () => {
    const res = await api('GET', '/normalize');
    expect(res.status).toBe(405);
  });

  // Catches: a 405 carried no `Allow` header (RFC 9110 requires one), so a
  // client could only learn the right method by parsing the message.
  it('every 405 names the allowed methods in Allow, and the JSON error is unchanged', async () => {
    const cases: [string, string, string, string][] = [
      ['GET', '/normalize', 'POST', 'use POST'],
      ['GET', '/learn', 'POST', 'use POST'],
      ['GET', '/add', 'POST', 'use POST'],
      ['POST', '/lexicon', 'GET, HEAD', 'use GET'],
      ['POST', '/stats', 'GET, HEAD', 'use GET'],
      ['POST', '/packs', 'GET, HEAD', 'use GET'],
      ['PUT', '/packs/developer', 'POST, DELETE', 'use POST to install or DELETE to remove'],
      ['POST', '/aliases', 'GET, HEAD', 'use GET'],
      ['POST', '/export/json', 'GET, HEAD', 'use GET'],
      ['POST', '/health', 'GET, HEAD', 'use GET'],
      ['POST', '/pair', 'GET, HEAD', 'use GET'],
    ];
    for (const [method, route, allow, error] of cases) {
      const res = await api(method, route, method === 'GET' ? undefined : {});
      expect(res.status, `${method} ${route}`).toBe(405);
      expect(res.headers.get('allow'), `${method} ${route}`).toBe(allow);
      expect(await res.json()).toEqual({ error });
    }
    // Other errors carry no Allow.
    expect((await api('GET', '/nope')).headers.get('allow')).toBeNull();
  });

  // Catches: HEAD on a GET route (`curl -I /health`) answered 405, so a
  // probe that checks liveness with HEAD read the server as broken.
  it('HEAD answers a GET route like GET, with its headers and no body', async () => {
    const auth = { Authorization: `Bearer ${info.token}` };
    const getHealth = await rawGet('/health', {});
    const headHealth = await rawGet('/health', {}, 'HEAD');
    expect(headHealth.status).toBe(200);
    expect(headHealth.body).toBe('');
    expect(headHealth.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(headHealth.headers['content-length']).toBe(String(Buffer.byteLength(getHealth.body)));
    expect(headHealth.headers['cache-control']).toBe('no-store');
    const csv = await rawGet('/export/csv', auth, 'HEAD');
    expect(csv.status).toBe(200);
    expect(csv.body).toBe('');
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
    // The same gates as GET: the token, strict query strings.
    const anon = await rawGet('/lexicon', {}, 'HEAD');
    expect(anon.status).toBe(401);
    expect(anon.headers['www-authenticate']).toBe('Bearer');
    expect(anon.body).toBe('');
    expect((await rawGet('/stats?cdw=x', auth, 'HEAD')).status).toBe(400);
    // A POST route still refuses HEAD, naming POST.
    const post = await rawGet('/normalize', auth, 'HEAD');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('POST');
  });

  // Catches: /pair before start() had read serve.json answered 503 "server
  // is starting" with no Retry-After and no word to retry.
  it('503 while the server is starting carries Retry-After and says to retry', async () => {
    const early = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true });
    await new Promise<void>((resolve) => early.server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = early.server.address() as net.AddressInfo;
      const get = (path: string, extra: Record<string, string> = {}) =>
        new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
          // Host names port 0: start() has not run, so that is the port the server believes it has.
          const req = http.request({ host: '127.0.0.1', port: address.port, path, headers: { Host: '127.0.0.1:0', ...extra } }, (r) => {
            let body = '';
            r.setEncoding('utf8');
            r.on('data', (d: string) => {
              body += d;
            });
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body, headers: r.headers }));
          });
          req.on('error', reject);
          req.end();
        });
      const res = await get('/pair');
      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(JSON.parse(res.body)).toEqual({ error: 'server is starting; retry after 1 second (Retry-After)' });
      // Catches: a bearer route (and /health?cwd=) answered 401 "missing or
      // invalid bearer token" here, though no token could be checked yet.
      for (const path of ['/stats', `/health?cwd=${encodeURIComponent(env.cwd)}`]) {
        const bearer = await get(path, { Authorization: `Bearer ${'0'.repeat(32)}` });
        expect(bearer.status).toBe(503);
        expect(bearer.headers['retry-after']).toBe('1');
        expect(JSON.parse(bearer.body)).toEqual({ error: 'server is starting; retry after 1 second (Retry-After)' });
      }
    } finally {
      await new Promise<void>((resolve) => {
        early.server.close(() => resolve());
        early.server.closeAllConnections();
      });
    }
  });

  it('503 once the concurrency cap is reached', async () => {
    const tiny = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true, maxConcurrent: 0 });
    const t = await tiny.start();
    try {
      const res = await fetch(`${t.url}/health`);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      // Catches: the error said only "too many concurrent requests", with no
      // word that the request was not run or when to send it again.
      expect(await res.json()).toEqual({
        error: 'too many concurrent requests (0 already in flight), so this one was not run; retry it after 1 second (Retry-After)',
      });
    } finally {
      await tiny.stop();
    }
  });
});

describe('request log', () => {
  // Catches: a client that hung up before the response finished left no log line at all.
  it('logs one line for a finished request and one for a request the client aborted', async () => {
    const lines: string[] = [];
    const logged = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, log: (l) => lines.push(l) });
    const t = await logged.start();
    try {
      await (await fetch(`${t.url}/health`)).text();
      await waitFor(() => lines.some((l) => l.startsWith('[serve] GET /health 200 ')));

      const socket = net.connect(t.port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(
        `POST /normalize HTTP/1.1\r\nHost: 127.0.0.1:${t.port}\r\nAuthorization: Bearer ${t.token}\r\n` +
          'Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{"text":',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.destroy();
      await waitFor(() => lines.some((l) => l.includes('aborted')));
      const aborted = lines.filter((l) => l.startsWith('[serve] POST /normalize'));
      expect(aborted).toHaveLength(1);
      expect(aborted[0]).toMatch(/^\[serve\] POST \/normalize aborted by the client before a response was sent \d+ms$/);
    } finally {
      await logged.stop();
    }
  });
});

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out waiting for the log line');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// trust gate
// ---------------------------------------------------------------------------

describe('the load cache after POST /normalize records hits', () => {
  // Catches: a hit-counting /normalize called invalidate(), which dropped the
  // cached load (and matcher index) of every cwd, though only the hit counts
  // of the terms it matched had changed.
  it('drops only the cached loads holding a matched term', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-hitcache-')));
    const globalPath = path.join(dir, 'config', 'lexicon.yaml');
    const repo = path.join(dir, 'repo');
    const other = path.join(dir, 'other');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(other, { recursive: true });
    await addTerm({ canonical: 'Ashlr.AI', aliases: ['ashler'] }, { globalPath, cwd: other });
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: Projy\n    aliases: [projee]\n');
    await trustProject(path.join(repo, '.lexicon.yaml'), { globalPath });
    // A long reload interval: only an invalidation makes the server re-read.
    const srv = createServer({ port: 0, cwd: other, globalPath, quiet: true, reloadMs: 60_000 });
    const started = await srv.start();
    const call = async (method: string, route: string, body?: unknown): Promise<Response> =>
      fetch(`${started.url}${route}`, {
        method,
        headers: { Authorization: `Bearer ${started.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const stats = async (cwd: string): Promise<LexiconStats> => (await (await call('GET', `/stats?cwd=${encodeURIComponent(cwd)}`)).json()) as LexiconStats;
    try {
      expect((await stats(other)).termCount).toBe(1);
      expect((await stats(repo)).termCount).toBe(2);
      // Behind the server's back: a reload of either cwd would now see a third term.
      await addTerm({ canonical: 'Laterly', aliases: ['laterlee'] }, { globalPath, cwd: other });

      // A hit on the repo's own term: only the repo's load holds it.
      const first = await call('POST', '/normalize', { text: 'ping projee', cwd: repo });
      expect(((await first.json()) as NormalizeResult).output).toBe('ping Projy');
      expect((await stats(other)).termCount).toBe(1);
      const repoStats = await stats(repo);
      expect(repoStats.termCount).toBe(3);
      expect(repoStats.topTerms).toEqual([{ canonical: 'Projy', hits: 1 }]);

      // A hit on a global term every load holds: both are re-read.
      await call('POST', '/normalize', { text: 'ping ashler', cwd: repo });
      const otherStats = await stats(other);
      expect(otherStats.termCount).toBe(2);
      expect(otherStats.topTerms).toEqual([{ canonical: 'Ashlr.AI', hits: 1 }]);
      expect((await stats(repo)).totalHits).toBe(2);
    } finally {
      await srv.stop();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('the load cache after a write', () => {
  // Catches: /learn, /add and pack install and uninstall cleared the cached
  // load of every cwd, though a project-scope write changes only the loads
  // that read that project file.
  it('a project write drops only the loads that used that file; a global write drops them all', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-writecache-')));
    const globalPath = path.join(dir, 'config', 'lexicon.yaml');
    const repoA = path.join(dir, 'a');
    const repoB = path.join(dir, 'b');
    const repoC = path.join(dir, 'c');
    const subC = path.join(repoC, 'src');
    const other = path.join(dir, 'other');
    for (const r of [repoA, repoB, repoC]) await fs.mkdir(path.join(r, '.git'), { recursive: true });
    await fs.mkdir(subC, { recursive: true });
    await fs.mkdir(other, { recursive: true });
    await addTerm({ canonical: 'Ashlr.AI', aliases: ['ashler'] }, { globalPath, cwd: other });
    for (const [r, name] of [[repoA, 'Alpha'], [repoB, 'Bravo']] as const) {
      await fs.writeFile(path.join(r, '.lexicon.yaml'), `version: 1\nterms:\n  - canonical: ${name}\n    aliases: [${name.toLowerCase()}o]\n`);
      await trustProject(path.join(r, '.lexicon.yaml'), { globalPath });
    }
    // A long reload interval: only an invalidation makes the server re-read.
    const srv = createServer({ port: 0, cwd: other, globalPath, quiet: true, reloadMs: 60_000 });
    const started = await srv.start();
    const call = async (method: string, route: string, body?: unknown): Promise<Response> =>
      fetch(`${started.url}${route}`, {
        method,
        headers: { Authorization: `Bearer ${started.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    const count = async (cwd: string): Promise<number> =>
      ((await (await call('GET', `/stats?cwd=${encodeURIComponent(cwd)}`)).json()) as LexiconStats).termCount;
    const counts = async (): Promise<number[]> => [await count(repoA), await count(repoB), await count(subC), await count(other)];
    const ok = async (res: Promise<Response>): Promise<void> => {
      const r = await res;
      expect(r.status, await r.clone().text()).toBe(200);
    };
    try {
      expect(await counts()).toEqual([2, 2, 1, 1]);
      // Behind the server's back: any reload now sees one more global term.
      await addTerm({ canonical: 'Laterly', aliases: ['laterlee'] }, { globalPath, cwd: other });

      await ok(call('POST', '/add', { canonical: 'Alpine', aliases: ['alpeen'], scope: 'project', cwd: repoA }));
      expect(await counts()).toEqual([4, 2, 1, 1]);
      await ok(call('POST', '/learn', { heard: 'bravvo', meant: 'Bravo', scope: 'project', cwd: repoB }));
      expect(await counts()).toEqual([4, 3, 1, 1]);
      const packTerms = (await (await call('POST', '/packs/voice-tools', { scope: 'project', cwd: repoA })).json()) as { added: number; path: string };
      expect(packTerms.path).toBe(path.join(repoA, '.lexicon.yaml'));
      expect(await count(repoA)).toBe(4 + packTerms.added);
      expect((await counts()).slice(1)).toEqual([3, 1, 1]);
      await ok(call('DELETE', `/packs/voice-tools?scope=project&cwd=${encodeURIComponent(repoA)}`));
      expect(await counts()).toEqual([4, 3, 1, 1]);

      // A write that creates a repo's .lexicon.yaml drops the loads of the
      // cwds that now resolve to it, though their cached load had no project file.
      await ok(call('POST', '/add', { canonical: 'Charlie', aliases: ['charlee'], scope: 'project', cwd: repoC }));
      expect(await counts()).toEqual([4, 3, 3, 1]);

      // A global write drops every load.
      await ok(call('POST', '/add', { canonical: 'Globo', aliases: ['globoh'], cwd: other }));
      expect(await counts()).toEqual([5, 4, 4, 3]);
    } finally {
      await srv.stop();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('trust gate', () => {
  it('never merges an untrusted project file and reports it by path only', async () => {
    const cwd = env.untrustedProject;
    const norm = await api('POST', '/normalize', { text: 'ping hostyle', cwd });
    const body = (await norm.json()) as NormalizeResult & { projectTrust?: string; skippedProject?: string };
    expect(body.output).toBe('ping hostyle');
    expect(body.changed).toBe(false);
    // An unchanged result says why a repo name was left alone, as /stats and
    // MCP normalize_transcript do: the repo lexicon was skipped, by path only.
    expect(body.projectTrust).toBe('untrusted');
    expect(body.skippedProject).toBe(path.join(cwd, '.lexicon.yaml'));
    expect(JSON.stringify(body)).not.toContain('HostileCorp');
    // No project file: neither key.
    const plain = (await (await api('POST', '/normalize', { text: 'ping hostyle', cwd: env.cwd })).json()) as Record<string, unknown>;
    expect(plain).not.toHaveProperty('projectTrust');
    expect(plain).not.toHaveProperty('skippedProject');

    const health = await api('GET', `/health?cwd=${encodeURIComponent(cwd)}`);
    expect(((await health.json()) as { projectTrust?: string }).projectTrust).toBe('untrusted');

    const lex = await api('GET', `/lexicon?cwd=${encodeURIComponent(cwd)}`);
    const lexBody = (await lex.json()) as { projectTrust?: string; skippedProject?: string; lexicon: { terms: { canonical: string }[] } };
    expect(lexBody.projectTrust).toBe('untrusted');
    expect(lexBody.skippedProject).toBe(path.join(cwd, '.lexicon.yaml'));
    expect(lexBody.lexicon.terms.map((t) => t.canonical)).not.toContain('HostileCorp');
    expect(JSON.stringify(lexBody)).not.toContain('hostyle');
  });

  it('never parses an untrusted project file, on a normalize that records hits or on a read', async () => {
    const cwd = env.untrustedProject;
    await addTerm({ canonical: 'Ashlr.AI', aliases: ['ashler'] }, { globalPath: env.globalPath });
    schemaParses.canonicals.length = 0;
    // Records a hit (so recordHits runs and the cache is dropped), then reloads.
    const norm = await api('POST', '/normalize', { text: 'ping ashler and hostyle', cwd });
    expect(norm.status).toBe(200);
    const body = (await norm.json()) as NormalizeResult;
    expect(body.output).toBe('ping Ashlr.AI and hostyle');
    for (const route of ['/lexicon', '/stats', '/packs', '/export/csv']) {
      expect((await api('GET', `${route}?cwd=${encodeURIComponent(cwd)}`)).status).toBe(200);
    }
    // The file is still reported by path; it was simply never read as YAML.
    const lex = (await (await api('GET', `/lexicon?cwd=${encodeURIComponent(cwd)}`)).json()) as { skippedProject?: string };
    expect(lex.skippedProject).toBe(path.join(cwd, '.lexicon.yaml'));
    expect(schemaParses.canonicals).not.toContain('HostileCorp');
  });

  it('refuses a project-scope write into an untrusted file with 403', async () => {
    const res = await api('POST', '/add', { canonical: 'Foo', aliases: ['fooo'], scope: 'project', cwd: env.untrustedProject });
    expect(res.status).toBe(403);
    // Catches: the 403 ended "or write to the global lexicon instead", which
    // says nothing about how a request does that.
    expect(((await res.json()) as { error: string }).error).toBe(
      `project lexicon at ${path.join(env.untrustedProject, '.lexicon.yaml')} is untrusted, so nothing was written. ` +
        'Review it and run `lexicon trust`, then retry; or retry with "scope": "global" in the body to use the global lexicon instead',
    );
  });
});

// ---------------------------------------------------------------------------
// requests that used to succeed while doing something else
// ---------------------------------------------------------------------------

describe('requests that used to succeed while doing something else', () => {
  // A server of its own, so these writes cannot shift another suite's counts.
  let home3: string;
  let global3: string;
  let cwd3: string;
  let srv3: LexiconHttpServer;
  let info3: ServeStartInfo;
  const api = (method: string, route: string, body?: unknown): Promise<Response> =>
    fetch(`${info3.url}${route}`, {
      method,
      headers: { Authorization: `Bearer ${info3.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  beforeAll(async () => {
    home3 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-strict-')));
    global3 = path.join(home3, 'lexicon', 'lexicon.yaml');
    cwd3 = path.join(home3, 'work');
    await fs.mkdir(cwd3, { recursive: true });
    srv3 = createServer({ port: 0, cwd: cwd3, globalPath: global3, quiet: true, reloadMs: 0 });
    info3 = await srv3.start();
  });
  afterAll(async () => {
    await srv3.stop();
    await fs.rm(home3, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Catches: `dry_run` (for dryRun) was dropped, so the "dry run" recorded hits and answered 200.
  it('an unknown body key is a 400 naming it, on every POST route, and nothing is written', async () => {
    await addTerm({ canonical: 'Strictly', aliases: ['strictlee'] }, { globalPath: global3, cwd: cwd3 });
    const before = await fs.readFile(global3, 'utf8');
    const routes: [string, Record<string, unknown>][] = [
      ['/normalize', { text: 'ping strictlee', dry_run: true }],
      ['/learn', { heard: 'strictlea', meant: 'Strictly', scop: 'global' }],
      ['/add', { canonical: 'Typo', alias: ['typoo'] }],
      ['/packs/developer', { scpe: 'project' }],
    ];
    for (const [route, body] of routes) {
      const res = await api('POST', route, body);
      expect(res.status, route).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toMatch(/invalid request body/);
      expect(error).toMatch(/dry_run|scop|alias|scpe/);
    }
    expect(await fs.readFile(global3, 'utf8')).toBe(before);
    const stats = (await (await api('GET', '/stats')).json()) as LexiconStats;
    expect(stats.topTerms.find((t) => t.canonical === 'Strictly')).toBeUndefined();
  });

  // Catches: a typo'd cwd fell back to the global lexicon alone and answered 200 for a project nobody looked at.
  it('a cwd that is empty or not an existing directory is a 400, on GET and POST', async () => {
    const missing = path.join(home3, 'no-such-dir');
    const file = global3;
    for (const cwd of [missing, file]) {
      const post = await api('POST', '/normalize', { text: 'hello', cwd });
      expect(post.status).toBe(400);
      expect(((await post.json()) as { error: string }).error).toContain('cwd is not an existing directory');
      for (const route of ['/lexicon', '/stats', '/packs', '/export/json', '/health']) {
        const res = await api('GET', `${route}?cwd=${encodeURIComponent(cwd)}`);
        expect(res.status, route).toBe(400);
      }
      expect((await api('DELETE', `/packs/developer?cwd=${encodeURIComponent(cwd)}`)).status).toBe(400);
    }
    const empty = await api('GET', '/lexicon?cwd=');
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain('cwd must not be empty');
    // Without the token /health?cwd= is still a 401, so it cannot probe which directories exist.
    expect((await fetch(`${info3.url}/health?cwd=${encodeURIComponent(missing)}`)).status).toBe(401);
    // An existing directory works as before.
    expect((await api('GET', `/lexicon?cwd=${encodeURIComponent(cwd3)}`)).status).toBe(200);
  });

  // Catches: DELETE ignored its body, so { scope: 'project' } removed the pack from the global lexicon.
  it('DELETE /packs/:name with a body is a 400 that points at the query string', async () => {
    const res = await api('DELETE', '/packs/developer', { scope: 'project' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('query string');
    expect((await api('DELETE', '/packs/developer')).status).toBe(200);
  });

  // Catches: DELETE read only scope and cwd from the query and ignored any
  // other key, so a typo (?scop=project) removed the pack from the global
  // lexicon and answered 200, the lie the strict body fixed for POST.
  it('DELETE /packs/:name refuses an unknown or repeated query parameter and removes nothing', async () => {
    expect((await api('POST', '/packs/developer', {})).status).toBe(200);
    const before = await fs.readFile(global3, 'utf8');
    const typo = await api('DELETE', '/packs/developer?scop=project');
    expect(typo.status).toBe(400);
    expect(((await typo.json()) as { error: string }).error).toContain('unknown query parameter "scop"');
    const twice = await api('DELETE', '/packs/developer?scope=project&scope=global');
    expect(twice.status).toBe(400);
    expect(await fs.readFile(global3, 'utf8')).toBe(before);
    expect((await api('DELETE', '/packs/developer?scope=global')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// CLI handlers
// ---------------------------------------------------------------------------

describe('lexicon serve (CLI)', () => {
  // Catches: a refused `serve --json` printed its reason on stderr only, leaving stdout empty;
  // then the document had no nextStep, unlike every other refusal, and never named the flags that collided.
  it('--json prints { ok: false, error, nextStep } naming the flags when two modes are combined', async () => {
    const error = 'use only one of --show, --status, --pair, --install, --uninstall';
    const io = memIO();
    expect(await runServe({ show: true, status: true, json: true, globalPath: env.globalPath }, io)).toBe(1);
    expect(JSON.parse(io.out.join(''))).toEqual({ ok: false, error, nextStep: 'pass only one of --show, --status (see lexicon serve --help)' });
    expect(io.err.join('')).toContain('lexicon: pass only one of --show, --status');
    // --install takes --json too, so its refusal is a document as well.
    const install = memIO();
    expect(await runServe({ install: true, uninstall: true, json: true, globalPath: env.globalPath }, install)).toBe(1);
    expect(JSON.parse(install.out.join(''))).toEqual({ ok: false, error, nextStep: 'pass only one of --install, --uninstall (see lexicon serve --help)' });
  });

  // Catches: `serve --status --quiet` (and every other one-shot mode) dropped
  // --quiet without a word, as if it did something there.
  it('refuses --quiet with a one-shot mode, naming the mode, with and without --json', async () => {
    const io = memIO();
    expect(await runServe({ status: true, quiet: true, json: true, globalPath: env.globalPath }, io)).toBe(1);
    expect(JSON.parse(io.out.join(''))).toEqual({
      ok: false,
      error: '--quiet only applies to a running server; --status logs no requests',
      nextStep: 'drop --quiet, or run lexicon serve --quiet to start the server without request logs',
    });
    const text = memIO();
    expect(await runServe({ show: true, quiet: true, globalPath: env.globalPath }, text)).toBe(1);
    expect(text.out.join('')).toBe('');
    expect(text.err.join('')).toContain('lexicon: --quiet only applies to a running server; --show logs no requests');
  });

  // Catches: `serve --install --json` and `--uninstall --json` printed the
  // prose transcript on stdout, so a script that asked for JSON parsed text.
  it('--install --json and --uninstall --json print one document, success or failure', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-home-'));
    try {
      const cli = await fakeCli(home);
      const unitPath = systemdUnitPath(home, {});
      const ok = memIO();
      expect(await runServe({ install: true, json: true, globalPath: env.globalPath }, ok, { platform: 'linux', home, env: {}, exec: fakeExec([]), cliPath: cli, nodePath: '/usr/bin/node' })).toBe(0);
      const installed = JSON.parse(ok.out.join(''));
      expect(installed).toMatchObject({ ok: true, action: 'install', platform: 'linux' });
      expect(installed.output).toContain(`wrote ${unitPath}`);
      expect(installed.output).toContain(`installed ${SYSTEMD_UNIT_NAME}`);
      expect(installed).not.toHaveProperty('error');

      const failing = memIO();
      expect(await runServe({ install: true, json: true, globalPath: env.globalPath }, failing, { platform: 'linux', home, env: {}, exec: fakeExec([], 1), cliPath: cli })).toBe(1);
      expect(JSON.parse(failing.out.join(''))).toMatchObject({
        ok: false,
        action: 'install',
        error: expect.stringContaining('could not enable the unit'),
        nextStep: 'fix the problem in error, then run lexicon serve --install --json again',
      });
      // The commands it ran and how they failed stay on stderr.
      expect(failing.err.join('')).toContain('exit 1: nope');

      const blocked = memIO();
      expect(await runServe({ install: true, json: true, globalPath: env.globalPath }, blocked, { platform: 'linux', home, env: {}, exec: fakeExec([]), cliPath: path.join(home, 'missing.js') })).toBe(1);
      expect(JSON.parse(blocked.out.join(''))).toMatchObject({ ok: false, action: 'install', error: expect.stringContaining('refusing to install the login service') });

      const removed = memIO();
      expect(await runServe({ uninstall: true, json: true, globalPath: env.globalPath }, removed, { platform: 'linux', home, env: {}, exec: fakeExec([]) })).toBe(0);
      expect(JSON.parse(removed.out.join(''))).toMatchObject({ ok: true, action: 'uninstall', output: expect.stringContaining(`removed ${unitPath}`) });

      await fs.mkdir(unitPath, { recursive: true });
      const stuck = memIO();
      expect(await runServe({ uninstall: true, json: true, globalPath: env.globalPath }, stuck, { platform: 'linux', home, env: {}, exec: fakeExec([]) })).toBe(1);
      expect(JSON.parse(stuck.out.join(''))).toMatchObject({ ok: false, action: 'uninstall', error: expect.stringContaining(`could not remove ${unitPath}`) });

      // Without --json the transcript is unchanged.
      await fs.rm(unitPath, { recursive: true, force: true });
      const text = memIO();
      expect(await runServe({ uninstall: true, globalPath: env.globalPath }, text, { platform: 'linux', home, env: {}, exec: fakeExec([]) })).toBe(0);
      expect(text.out.join('')).toContain(`${unitPath} was not installed\n`);
      expect(() => JSON.parse(text.out.join(''))).toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

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
    // Catches: the --show success object had no `ok`, though a failure leads with `ok: false`.
    expect(Object.keys(JSON.parse(json.out.join('')))[0]).toBe('ok');
    expect(JSON.parse(json.out.join(''))).toEqual({
      ok: true,
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

  // Catches: --status created serve.json (and minted a token) when it was missing; a status query must write nothing.
  it('--status writes nothing and says serve is not configured when serve.json is missing', async () => {
    const dir = await fs.mkdtemp(path.join(env.home, 'status-unconfigured-'));
    const globalPath = path.join(dir, 'lexicon.yaml');
    const servePath = getServePath({ globalPath });
    const closed = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true });
    const c = await closed.start();
    await closed.stop();

    const text = memIO();
    expect(await runServe({ status: true, port: c.port, globalPath }, text, { home: env.home })).toBe(1);
    expect(text.out.join('')).toContain('serve is not configured:');
    expect(text.out.join('')).toContain('does not exist; lexicon serve creates it');
    expect(text.out.join('')).toContain(`lexicon serve is down at http://127.0.0.1:${c.port}`);

    const json = memIO();
    expect(await runServe({ status: true, json: true, port: c.port, globalPath }, json)).toBe(1);
    expect(JSON.parse(json.out.join(''))).toMatchObject({ up: false, configured: false, configPath: servePath, note: expect.stringContaining('not configured') });
    await expect(fs.stat(servePath)).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual([]);

    // A configured one carries no configured/note keys.
    const configured = memIO();
    await runServe({ status: true, json: true, port: c.port, globalPath: env.globalPath }, configured);
    expect(JSON.parse(configured.out.join(''))).not.toHaveProperty('configured');
  });

  /**
   * Catches: --status treating any non-2xx /health as "down" and telling the
   * user to start a server that is already running. A broken lexicon file
   * makes /health answer 500; the useful output is what is broken.
   */
  it('--status names the error when the server is running but /health fails', async () => {
    const dir = await fs.mkdtemp(path.join(env.home, 'status-broken-'));
    const globalPath = path.join(dir, 'lexicon.yaml');
    await fs.writeFile(globalPath, 'version: 1\nterms: [\n', 'utf8');
    const broken = createServer({ port: 0, cwd: env.cwd, globalPath, quiet: true });
    const t = await broken.start();
    try {
      const io = memIO();
      expect(await runServe({ status: true, port: t.port, globalPath }, io)).toBe(1);
      const out = io.out.join('');
      expect(out).toContain(`lexicon serve is running at http://127.0.0.1:${t.port} but /health failed (HTTP 500`);
      expect(out).toContain('Failed to parse lexicon YAML');
      expect(out).not.toContain('start it with');

      const json = memIO();
      expect(await runServe({ status: true, json: true, port: t.port, globalPath }, json)).toBe(1);
      expect(JSON.parse(json.out.join(''))).toMatchObject({
        up: false,
        running: true,
        status: 500,
        reason: expect.stringContaining('Failed to parse'),
        error: expect.stringContaining('Failed to parse'),
        hint: expect.stringContaining('Starting another server will not help'),
      });
    } finally {
      await broken.stop();
    }
  });

  // Catches: the error going through `safe`, which caps at 200 characters,
  // so a long lexicon path was cut off before the part that names the file.
  it('--status keeps the whole path of a broken lexicon file, and every line of the error', async () => {
    const dir = path.join(await fs.mkdtemp(path.join(env.home, 'status-long-')), 'a-rather-long-directory-name-'.repeat(6));
    await fs.mkdir(dir, { recursive: true });
    const globalPath = path.join(dir, 'lexicon.yaml');
    await fs.writeFile(globalPath, 'version: 1\nterms:\n  - aliases: [x]\n  - canonical: B\n    aliases: 7\n', 'utf8');
    const broken = createServer({ port: 0, cwd: env.cwd, globalPath, quiet: true });
    const t = await broken.start();
    try {
      const io = memIO();
      expect(await runServe({ status: true, port: t.port, globalPath }, io)).toBe(1);
      const out = io.out.join('');
      expect(globalPath.length).toBeGreaterThan(200);
      expect(out).toContain(`/health failed (HTTP 500): internal error: Invalid lexicon at ${globalPath}:`);
      expect(out).toContain('terms[0].canonical');
      expect(out).toContain('terms[1].aliases');
    } finally {
      await broken.stop();
    }
  });

  // Catches: a 200 from another program on the port read as "down" with
  // "start it" advice that fails with EADDRINUSE, and the JSON lacked the
  // `error` and `hint` keys MCP serve_status returns.
  it('--status names another program on the port, and --json carries error and hint', async () => {
    const other = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"fine"}');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const port = (other.address() as net.AddressInfo).port;
    try {
      const io = memIO();
      expect(await runServe({ status: true, port, globalPath: env.globalPath }, io)).toBe(1);
      const out = io.out.join('');
      expect(out).toContain(`something answered at http://127.0.0.1:${port}, but it is not lexicon serve`);
      expect(out).toContain('lexicon serve --port <n>');
      expect(out).not.toContain('start it with');

      const json = memIO();
      expect(await runServe({ status: true, json: true, port, globalPath: env.globalPath }, json)).toBe(1);
      expect(JSON.parse(json.out.join(''))).toEqual({
        ok: false,
        up: false,
        url: `http://127.0.0.1:${port}`,
        reason: 'unexpected /health response',
        error: 'unexpected /health response (not lexicon serve)',
        hint: expect.stringContaining('lexicon serve --port <n>'),
        nextStep: expect.stringContaining('lexicon serve --port <n>'),
      });
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }

    const closed = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true });
    const c = await closed.start();
    await closed.stop();
    const down = memIO();
    expect(await runServe({ status: true, json: true, port: c.port, globalPath: env.globalPath }, down)).toBe(1);
    const d = JSON.parse(down.out.join('')) as Record<string, unknown>;
    expect(d).toMatchObject({ up: false, hint: expect.stringContaining('lexicon serve') });
    expect(d.error).toBe(d.reason);
  });

  it('--status --json', async () => {
    const io = memIO();
    expect(await runServe({ status: true, json: true, port: info.port, globalPath: env.globalPath }, io)).toBe(0);
    const parsed = JSON.parse(io.out.join('')) as { up: boolean; health: { ok: boolean } };
    expect(parsed.up).toBe(true);
    expect(parsed.health.ok).toBe(true);
  });

  // Catches: --status --json had no top-level `ok`, though every other --json
  // document leads with it; a script had to know to read `up` here only.
  it('--status --json leads with ok equal to up (and to exit code 0)', async () => {
    const first = (out: string): [string, unknown] => Object.entries(JSON.parse(out) as Record<string, unknown>)[0]!;
    const io = memIO();
    expect(await runServe({ status: true, json: true, port: info.port, globalPath: env.globalPath }, io)).toBe(0);
    expect(first(io.out.join(''))).toEqual(['ok', true]);
    expect(JSON.parse(io.out.join(''))).toMatchObject({ ok: true, up: true });

    const closed = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true });
    const c = await closed.start();
    await closed.stop();
    const down = memIO();
    expect(await runServe({ status: true, json: true, port: c.port, globalPath: env.globalPath }, down)).toBe(1);
    expect(first(down.out.join(''))).toEqual(['ok', false]);
    expect(JSON.parse(down.out.join(''))).toMatchObject({ ok: false, up: false, error: expect.any(String), hint: expect.any(String) });
  });

  // Catches: a failing --status --json had `hint` but no `nextStep`, the key
  // every other failing --json document of the CLI uses for what to do next.
  it('--status --json carries nextStep, equal to hint, whenever the server is not up', async () => {
    const closed = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true });
    const c = await closed.start();
    await closed.stop();
    const down = memIO();
    expect(await runServe({ status: true, json: true, port: c.port, globalPath: env.globalPath }, down)).toBe(1);
    const d = JSON.parse(down.out.join('')) as Record<string, unknown>;
    expect(d).toMatchObject({ ok: false, error: expect.any(String), nextStep: 'Start it with `lexicon serve`, or `lexicon serve --install` to keep it running at login.' });
    expect(d.nextStep).toBe(d.hint);

    const io = memIO();
    expect(await runServe({ status: true, json: true, port: info.port, globalPath: env.globalPath }, io)).toBe(0);
    expect(JSON.parse(io.out.join(''))).not.toHaveProperty('nextStep');
  });

  it('refuses two modes at once', async () => {
    const io = memIO();
    expect(await runServe({ show: true, status: true, globalPath: env.globalPath }, io)).toBe(1);
    expect(io.err.join('')).toContain('only one of');
    const io2 = memIO();
    expect(await runServe({ pair: true, status: true, globalPath: env.globalPath }, io2)).toBe(1);
    expect(io2.err.join('')).toContain('--pair');
  });

  it('--pair opens /pair in the default browser once /health answers', async () => {
    const calls: string[][] = [];
    const io = memIO();
    const code = await runServe({ pair: true, port: info.port, globalPath: env.globalPath }, io, {
      platform: 'darwin',
      exec: fakeExec(calls),
    });
    expect(code).toBe(0);
    const url = `http://127.0.0.1:${info.port}/pair`;
    expect(pairUrl(info.port)).toBe(url);
    expect(calls).toEqual([['open', url]]);
    expect(io.out.join('')).toContain(`opening ${url} in your browser`);
    expect(io.err.join('')).toBe('');

    // Linux and Windows openers, no shell interpolation of the URL.
    const linux: string[][] = [];
    expect(await runServe({ pair: true, port: info.port, globalPath: env.globalPath }, memIO(), { platform: 'linux', exec: fakeExec(linux) })).toBe(0);
    expect(linux).toEqual([['xdg-open', url]]);
    const win: string[][] = [];
    expect(await runServe({ pair: true, port: info.port, globalPath: env.globalPath }, memIO(), { platform: 'win32', exec: fakeExec(win) })).toBe(0);
    expect(win).toEqual([['cmd', '/c', 'start', '', url]]);
    expect(browserOpenCommand(url, 'sunos' as NodeJS.Platform)).toBeUndefined();

    // --json reports the URL and whether the opener ran.
    const json = memIO();
    expect(await runServe({ pair: true, json: true, port: info.port, globalPath: env.globalPath }, json, { platform: 'darwin', exec: fakeExec([]) })).toBe(0);
    // Catches: a pair that opened the browser had no `ok`, though one that did not leads with `ok: false`.
    expect(JSON.parse(json.out.join(''))).toEqual({ ok: true, up: true, url, opened: true });
    expect(Object.keys(JSON.parse(json.out.join('')))[0]).toBe('ok');
  });

  // Catches: --pair created serve.json (and minted a token) when it was
  // missing, so asking to pair configured serve as a side effect.
  it('--pair writes nothing and says serve is not configured when serve.json is missing', async () => {
    const dir = await fs.mkdtemp(path.join(env.home, 'pair-unconfigured-'));
    const globalPath = path.join(dir, 'lexicon.yaml');
    const servePath = getServePath({ globalPath });
    const calls: string[][] = [];
    const text = memIO();
    expect(await runServe({ pair: true, port: info.port, globalPath }, text, { home: env.home, platform: 'darwin', exec: fakeExec(calls) })).toBe(1);
    expect(text.err.join('')).toContain('lexicon: serve is not configured:');
    expect(text.err.join('')).toContain('does not exist; lexicon serve creates it');
    expect(text.err.join('')).toContain('lexicon serve --install');
    expect(text.out.join('')).toBe('');

    const json = memIO();
    expect(await runServe({ pair: true, json: true, port: info.port, globalPath }, json, { platform: 'darwin', exec: fakeExec(calls) })).toBe(1);
    expect(JSON.parse(json.out.join(''))).toEqual({
      ok: false,
      error: `serve is not configured: ${servePath} does not exist; lexicon serve creates it`,
      nextStep: expect.stringContaining('lexicon serve --install'),
      up: false,
      configured: false,
      configPath: servePath,
    });
    expect(calls).toEqual([]);
    await expect(fs.stat(servePath)).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('--pair exits 1 with a start hint when the server is down, and when no browser opens', async () => {
    const closed = createServer({ port: 0, cwd: env.cwd, globalPath: env.globalPath, quiet: true });
    const c = await closed.start();
    await closed.stop();
    const calls: string[][] = [];
    const down = memIO();
    expect(await runServe({ pair: true, port: c.port, globalPath: env.globalPath }, down, { platform: 'darwin', exec: fakeExec(calls) })).toBe(1);
    expect(calls).toEqual([]);
    expect(down.err.join('')).toContain(`lexicon serve is down at http://127.0.0.1:${c.port}`);
    expect(down.err.join('')).toContain('lexicon serve --install');
    const downJson = memIO();
    expect(await runServe({ pair: true, json: true, port: c.port, globalPath: env.globalPath }, downJson, { platform: 'darwin', exec: fakeExec(calls) })).toBe(1);
    expect(JSON.parse(downJson.out.join(''))).toMatchObject({ ok: false, error: expect.stringContaining('lexicon serve is down'), nextStep: expect.stringContaining('lexicon serve'), up: false, url: `http://127.0.0.1:${c.port}/pair` });

    const failed = memIO();
    expect(await runServe({ pair: true, port: info.port, globalPath: env.globalPath }, failed, { platform: 'darwin', exec: fakeExec([], 1) })).toBe(1);
    expect(failed.err.join('')).toContain('could not open a browser');
    expect(failed.out.join('')).toContain(`http://127.0.0.1:${info.port}/pair`);
    const failedJson = memIO();
    expect(await runServe({ pair: true, json: true, port: info.port, globalPath: env.globalPath }, failedJson, { platform: 'darwin', exec: fakeExec([], 1) })).toBe(1);
    expect(JSON.parse(failedJson.out.join(''))).toMatchObject({ ok: false, up: true, opened: false, error: expect.any(String) });
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

  // Catches: the --json listening line had no `ok`, though a failed start prints `{ ok: false, error }`.
  it('--json prints one listening document that leads with ok: true', async () => {
    const io = memIO();
    const controller = new AbortController();
    let seen: { port: number; url: string; token: string } | undefined;
    const run = runServe({ port: 0, quiet: true, json: true, cwd: env.cwd, globalPath: env.globalPath }, io, {
      home: env.home,
      signal: controller.signal,
      onListening: (i) => {
        seen = i;
      },
    });
    for (let i = 0; i < 200 && !seen; i += 1) await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    expect(await run).toBe(0);
    const doc = JSON.parse(io.out.join('')) as Record<string, unknown>;
    expect(Object.keys(doc)[0]).toBe('ok');
    expect(doc).toMatchObject({ ok: true, url: seen!.url, port: seen!.port, token: seen!.token });
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
      const cli = await fakeCli(home);
      const calls: string[][] = [];
      const io = memIO();
      const code = await runServe({ install: true, globalPath: env.globalPath }, io, {
        platform: 'darwin',
        home,
        env: {},
        exec: fakeExec(calls),
        cliPath: cli,
        nodePath: '/usr/local/bin/node',
        uid: 501,
      });
      expect(code).toBe(0);
      const plistPath = launchAgentPath(home, {});
      const plist = await fs.readFile(plistPath, 'utf8');
      expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
      expect(plist).toContain(`<string>/usr/local/bin/node</string>\n    <string>${cli}</string>\n    <string>serve</string>`);
      expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
      // Nothing set at install time: the plist carries no environment.
      expect(plist).not.toContain('EnvironmentVariables');
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
      expect(await runServe({ install: true, globalPath: env.globalPath }, io2, { platform: 'darwin', home, env: {}, exec: exec2, cliPath: cli, uid: 501 })).toBe(0);
      expect(calls2[2]).toEqual(['launchctl', 'load', plistPath]);

      // uninstall
      const calls3: string[][] = [];
      const io3 = memIO();
      expect(await runServe({ uninstall: true, globalPath: env.globalPath }, io3, { platform: 'darwin', home, env: {}, exec: fakeExec(calls3), uid: 501 })).toBe(0);
      expect(calls3[0]).toEqual(['launchctl', 'bootout', `gui/501/${LAUNCH_AGENT_LABEL}`]);
      await expect(fs.access(plistPath)).rejects.toThrow();
      expect(io3.out.join('')).toContain(`removed ${plistPath}`);
    } finally {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('--install on Linux writes the systemd user unit', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-home-'));
    try {
      const cli = await fakeCli(home);
      const calls: string[][] = [];
      const io = memIO();
      const code = await runServe({ install: true, globalPath: env.globalPath }, io, {
        platform: 'linux',
        home,
        env: {},
        exec: fakeExec(calls),
        cliPath: cli,
        nodePath: '/usr/bin/node',
      });
      expect(code).toBe(0);
      const unitPath = systemdUnitPath(home, {});
      expect(unitPath).toBe(path.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME));
      const unit = await fs.readFile(unitPath, 'utf8');
      // systemd's own escaping: unitQuote doubles a backslash, so the
      // Windows temp path in this fixture is doubled in the unit file. That is
      // the unit being right, not the test being wrong.
      expect(unit).toContain(`ExecStart="/usr/bin/node" "${cli.replace(/\\/g, '\\\\')}" serve`);
      expect(unit).toContain('WantedBy=default.target');
      expect(unit).not.toContain('Environment=');
      expect(calls).toEqual([
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT_NAME],
      ]);
      expect(io.out.join('')).toContain(`wrote ${unitPath}`);

      const failing = memIO();
      expect(await runServe({ install: true, globalPath: env.globalPath }, failing, { platform: 'linux', home, env: {}, exec: fakeExec([], 1), cliPath: cli })).toBe(1);

      const calls2: string[][] = [];
      expect(await runServe({ uninstall: true, globalPath: env.globalPath }, memIO(), { platform: 'linux', home, env: {}, exec: fakeExec(calls2) })).toBe(0);
      expect(calls2[0]).toEqual(['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT_NAME]);
      await expect(fs.access(unitPath)).rejects.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  // Catches: any unlink failure (a directory in place, permissions) printed "was not installed" and exited 0.
  it('--uninstall reports a service file it could not remove, and still says when there was none', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-home-'));
    try {
      const none = memIO();
      expect(await runServe({ uninstall: true, globalPath: env.globalPath }, none, { platform: 'linux', home, env: {}, exec: fakeExec([]) })).toBe(0);
      expect(none.out.join('')).toContain('was not installed');

      // A directory where the unit file goes: unlink fails with something other than ENOENT.
      const unitPath = systemdUnitPath(home, {});
      await fs.mkdir(unitPath, { recursive: true });
      const calls: string[][] = [];
      const linux = memIO();
      expect(await runServe({ uninstall: true, globalPath: env.globalPath }, linux, { platform: 'linux', home, env: {}, exec: fakeExec(calls) })).toBe(1);
      expect(linux.out.join('')).not.toContain('was not installed');
      expect(linux.err.join('')).toContain(`could not remove ${unitPath}`);
      expect(calls.at(-1)).toEqual(['systemctl', '--user', 'daemon-reload']);

      const plistPath = launchAgentPath(home, {});
      await fs.mkdir(plistPath, { recursive: true });
      const mac = memIO();
      expect(await runServe({ uninstall: true, globalPath: env.globalPath }, mac, { platform: 'darwin', home, env: {}, exec: fakeExec([]), uid: 501 })).toBe(1);
      expect(mac.err.join('')).toContain(`could not remove ${plistPath}`);
    } finally {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('--install refuses a CLI path that does not exist: nothing written, no bootout, exit 1', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-home-'));
    try {
      // A previous, working install is in place; it must survive a broken re-install.
      const plistPath = launchAgentPath(home, {});
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, 'previous plist', 'utf8');
      const missing = path.join(home, 'plugin', 'index.js');
      for (const platform of ['darwin', 'linux'] as const) {
        const calls: string[][] = [];
        const io = memIO();
        const code = await runServe({ install: true, globalPath: env.globalPath }, io, { platform, home, env: {}, exec: fakeExec(calls), cliPath: missing, uid: 501 });
        expect(code).toBe(1);
        expect(calls).toEqual([]);
        expect(io.out.join('')).toBe('');
        expect(io.err.join('')).toContain(`refusing to install the login service: ${missing} does not exist`);
        expect(io.err.join('')).toContain('nothing was written');
      }
      expect(await fs.readFile(plistPath, 'utf8')).toBe('previous plist');
      await expect(fs.access(systemdUnitPath(home, {}))).rejects.toThrow();

    } finally {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('--install resolves the CLI from LEXICON_CLI when no cliPath is given', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-home-'));
    try {
      const cli = await fakeCli(home, 'elsewhere/dist/cli/index.js');
      const calls: string[][] = [];
      const io = memIO();
      const code = await runServe({ install: true, globalPath: env.globalPath }, io, {
        platform: 'darwin',
        home,
        env: { LEXICON_CLI: cli },
        exec: fakeExec(calls),
        nodePath: '/usr/local/bin/node',
        uid: 501,
      });
      expect(code).toBe(0);
      const plist = await fs.readFile(launchAgentPath(home, {}), 'utf8');
      expect(plist).toContain(`<string>${cli}</string>`);
      expect(io.out.join('')).toContain(`ProgramArguments: /usr/local/bin/node ${cli} serve`);
    } finally {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('LEXICON_SERVE_LABEL renames the LaunchAgent for install, uninstall and the plist label', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-home-'));
    try {
      const cli = await fakeCli(home);
      const labelled = { [SERVE_LABEL_ENV_VAR]: 'ai.ashlr.lexicon.serve.test' };
      const calls: string[][] = [];
      const io = memIO();
      const code = await runServe({ install: true, globalPath: env.globalPath }, io, { platform: 'darwin', home, env: labelled, exec: fakeExec(calls), cliPath: cli, uid: 501 });
      expect(code).toBe(0);
      const plistPath = launchAgentPath(home, labelled);
      expect(plistPath).toBe(path.join(home, 'Library', 'LaunchAgents', 'ai.ashlr.lexicon.serve.test.plist'));
      expect(await fs.readFile(plistPath, 'utf8')).toContain('<string>ai.ashlr.lexicon.serve.test</string>');
      expect(calls).toEqual([
        ['launchctl', 'bootout', 'gui/501/ai.ashlr.lexicon.serve.test'],
        ['launchctl', 'bootstrap', 'gui/501', plistPath],
      ]);
      expect(io.out.join('')).toContain('installed ai.ashlr.lexicon.serve.test');
      // The real label's plist is untouched.
      await expect(fs.access(launchAgentPath(home, {}))).rejects.toThrow();
      // A label with shell-ish characters is ignored in favour of the default.
      expect(launchAgentPath(home, { [SERVE_LABEL_ENV_VAR]: 'bad label; rm -rf' })).toBe(launchAgentPath(home, {}));

      const calls2: string[][] = [];
      expect(await runServe({ uninstall: true, globalPath: env.globalPath }, memIO(), { platform: 'darwin', home, env: labelled, exec: fakeExec(calls2), uid: 501 })).toBe(0);
      expect(calls2[0]).toEqual(['launchctl', 'bootout', 'gui/501/ai.ashlr.lexicon.serve.test']);
      await expect(fs.access(plistPath)).rejects.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('--install on Windows registers a Scheduled Task with schtasks /Create /XML', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-schtasks-'));
    try {
      const cli = await fakeCli(home);
      const calls: string[][] = [];
      const io = memIO();
      const code = await runServe({ install: true, globalPath: env.globalPath }, io, {
        platform: 'win32',
        home,
        env: { USERNAME: 'me', USERDOMAIN: 'BOX' },
        exec: fakeExec(calls),
        cliPath: cli,
        nodePath: 'C:\\node\\node.exe',
      });
      expect(code).toBe(0);
      expect(calls).toHaveLength(1);
      const [cmd, ...args] = calls[0];
      expect(cmd).toBe('schtasks');
      // /XML rather than /TR: the command line holds two quoted absolute paths
      // and /TR is a single field, so the quotes would have to survive Node's
      // argv re-quoting and schtasks' own parsing. The XML keeps them apart.
      expect(args.slice(0, 4)).toEqual(['/Create', '/TN', SCHEDULED_TASK_NAME, '/XML']);
      expect(args[5]).toBe('/F');
      const text = io.out.join('');
      expect(text).toContain('created Scheduled Task Lexicon');
      expect(text).toContain(`"${cli}" serve`);
    } finally {
      await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  describe('--install carries LEXICON_PATH and XDG_CONFIG_HOME into the service', () => {
    // Relative values resolve against --cwd, like `lexicon install`; `&`, `<`,
    // `%`, a quote and a space exercise each format's escaping.
    // XDG_CONFIG_HOME is absolute and writable: the Linux install writes its
    // unit under it, so it must not point at a root-only path.
    const xdg = path.join(os.tmpdir(), `lexicon-xdg-${process.pid} my cfg`);
    const shellEnv = { LEXICON_PATH: "lex & <co>/100%/o'brien.yaml", XDG_CONFIG_HOME: xdg, PATH: '/bin' };
    const cwd = path.resolve('/work dir');
    const lexPath = path.resolve(cwd, "lex & <co>/100%/o'brien.yaml");
    afterAll(async () => {
      await fs.rm(xdg, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it('macOS: an EnvironmentVariables dict in the plist', async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-home-'));
      try {
        const cli = await fakeCli(home);
        const io = memIO();
        expect(
          await runServe({ install: true, globalPath: env.globalPath, cwd }, io, {
            platform: 'darwin',
            home,
            env: shellEnv,
            exec: fakeExec([]),
            cliPath: cli,
            nodePath: '/usr/local/bin/node',
            uid: 501,
          }),
        ).toBe(0);
        const plist = await fs.readFile(launchAgentPath(home, shellEnv), 'utf8');
        const esc = (v: string): string => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        expect(plist).toContain(
          '  <key>EnvironmentVariables</key>\n  <dict>\n' +
            `    <key>LEXICON_PATH</key>\n    <string>${esc(lexPath)}</string>\n` +
            `    <key>XDG_CONFIG_HOME</key>\n    <string>${esc(xdg)}</string>\n` +
            '  </dict>\n  <key>RunAtLoad</key>',
        );
        // PATH is not carried, and the program path still parses.
        expect(plist).not.toContain('<key>PATH</key>');
        expect(programPathFromPlist(plist)).toBe(cli);
        expect(io.out.join('')).toContain(`  Environment: LEXICON_PATH=${lexPath}\n`);
      } finally {
        await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    });

    it('Linux: one quoted Environment= line per variable, % doubled', async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-home-'));
      try {
        const cli = await fakeCli(home);
        const io = memIO();
        expect(
          await runServe({ install: true, globalPath: env.globalPath, cwd }, io, {
            platform: 'linux',
            home,
            env: shellEnv,
            exec: fakeExec([]),
            cliPath: cli,
            nodePath: '/usr/bin/node',
          }),
        ).toBe(0);
        const unit = await fs.readFile(systemdUnitPath(home, shellEnv), 'utf8');
        const q = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
        expect(unit).toContain(
          `Type=simple\nEnvironment="LEXICON_PATH=${q(lexPath)}"\nEnvironment="XDG_CONFIG_HOME=${q(xdg)}"\nExecStart=`,
        );
        expect(io.out.join('')).toContain(`  Environment: XDG_CONFIG_HOME=${xdg}\n`);
      } finally {
        await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    });

    it('systemd: a % in the CLI path is doubled and still round-trips', () => {
      const unit = systemdUnit('/usr/bin/node', '/opt/100%/index.js');
      expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/100%%/index.js" serve');
      expect(programPathFromUnit(unit)).toBe('/opt/100%/index.js');
    });

    it('Windows: a serve.env next to serve.json, loaded with node --env-file', async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-schtasks-'));
      const envFile = path.join(path.dirname(env.globalPath), SERVE_ENV_FILE_NAME);
      try {
        const cli = await fakeCli(home);
        const io = memIO();
        let xml = '';
        const exec: ServeExec = async (_cmd, args) => {
          xml = Buffer.from(await fs.readFile(args[4])).toString('utf16le').replace(/^\ufeff/, '');
          return { code: 0, stdout: '', stderr: '' };
        };
        expect(
          await runServe({ install: true, globalPath: env.globalPath, cwd }, io, {
            platform: 'win32',
            home,
            env: { ...shellEnv, USERNAME: 'me' },
            exec,
            cliPath: cli,
            nodePath: 'C:\\node\\node.exe',
            nodeVersion: 'v22.11.0',
          }),
        ).toBe(0);
        expect(xml).toContain(`<Arguments>--env-file=&quot;${envFile.replace(/&/g, '&amp;')}&quot; &quot;`);
        expect(programPathFromTaskXml(xml)).toBe(cli);
        expect(await fs.readFile(envFile, 'utf8')).toBe(serveEnvFile({ LEXICON_PATH: lexPath, XDG_CONFIG_HOME: xdg }));
        expect(io.out.join('')).toContain(`Arguments: --env-file="${envFile}" "${cli}" serve`);

        // A node too old for --env-file: warned, installed without it.
        const old = memIO();
        await fs.rm(envFile, { force: true });
        expect(
          await runServe({ install: true, globalPath: env.globalPath, cwd }, old, {
            platform: 'win32',
            home,
            env: shellEnv,
            exec,
            cliPath: cli,
            nodePath: 'C:\\node\\node.exe',
            nodeVersion: 'v20.5.1',
          }),
        ).toBe(0);
        expect(old.err.join('')).toContain('node v20.5.1 cannot load an env file (needs 20.6+)');
        expect(xml).not.toContain('--env-file');
        await expect(fs.access(envFile)).rejects.toThrow();

        // Nothing set: the task is exactly what it was before.
        expect(
          await runServe({ install: true, globalPath: env.globalPath }, memIO(), {
            platform: 'win32',
            home,
            env: { USERNAME: 'me' },
            exec,
            cliPath: cli,
            nodePath: 'C:\\node\\node.exe',
          }),
        ).toBe(0);
        expect(xml).toContain(`<Arguments>&quot;${cli}&quot; serve</Arguments>`);
        await expect(fs.access(envFile)).rejects.toThrow();
      } finally {
        await fs.rm(envFile, { force: true });
        await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    });

    it.skipIf(!nodeSupportsEnvFile(process.version))('serveEnvFile is read back verbatim by node --env-file', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-envfile-'));
      try {
        const values = { LEXICON_PATH: "C:\\new\\lex #1 & co\\o'brien.yaml", XDG_CONFIG_HOME: 'C:\\Users\\me\\tab\\cfg' };
        const file = path.join(dir, 'serve.env');
        await fs.writeFile(file, serveEnvFile(values));
        const out = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [`--env-file=${file}`, '-e', 'process.stdout.write(JSON.stringify([process.env.LEXICON_PATH, process.env.XDG_CONFIG_HOME]))'],
            // node keeps a variable that is already set over the file's, so start clean.
            { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' } },
          );
          let text = '';
          child.stdout.on('data', (d: Buffer) => (text += d.toString()));
          child.on('error', reject);
          child.on('close', () => resolve(text));
        });
        expect(JSON.parse(out)).toEqual([values.LEXICON_PATH, values.XDG_CONFIG_HOME]);
        expect(() => serveEnvFile({ LEXICON_PATH: "a'b`c" })).toThrow(/both/);
        expect(nodeSupportsEnvFile('v20.6.0')).toBe(true);
        expect(nodeSupportsEnvFile('v20.5.9')).toBe(false);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('--install on Windows refuses a CLI path that does not exist, and runs nothing', async () => {
    const calls: string[][] = [];
    const io = memIO();
    const code = await runServe({ install: true, globalPath: env.globalPath }, io, {
      platform: 'win32',
      home: 'C:\\Users\\me',
      exec: fakeExec(calls),
      cliPath: 'C:\\nowhere\\dist\\cli\\index.js',
      nodePath: 'C:\\node\\node.exe',
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(io.err.join('')).toContain('does not exist');
  });

  it('--uninstall on Windows deletes the task, and says so when there was none', async () => {
    const ok: string[][] = [];
    const io = memIO();
    expect(await runServe({ uninstall: true, globalPath: env.globalPath }, io, {
      platform: 'win32',
      home: 'C:\\Users\\me',
      exec: fakeExec(ok),
    })).toBe(0);
    expect(ok).toEqual([['schtasks', '/Delete', '/TN', 'Lexicon', '/F']]);
    expect(io.out.join('')).toContain('removed Scheduled Task Lexicon');

    const missing: string[][] = [];
    const io2 = memIO();
    expect(await runServe({ uninstall: true, globalPath: env.globalPath }, io2, {
      platform: 'win32',
      home: 'C:\\Users\\me',
      exec: fakeExec(missing, 1),
    })).toBe(0);
    expect(io2.out.join('')).toContain('was not installed');
  });

  it('the task XML round-trips its program path and binds the trigger to one user', () => {
    const xml = scheduledTaskXml('C:\\Program Files\\nodejs\\node.exe', 'C:\\lex & co\\index.js', 'BOX\\me');
    // The CLI entry, not the node binary -- the same thing the plist and the
    // unit parsers return, so the doctor's "points at a missing file" check
    // means one thing on all three platforms.
    expect(programPathFromTaskXml(xml)).toBe('C:\\lex & co\\index.js');
    expect(xml).toContain('<Command>C:\\Program Files\\nodejs\\node.exe</Command>');
    expect(xml).toContain('<Arguments>&quot;C:\\lex &amp; co\\index.js&quot; serve</Arguments>');
    expect(xml).toContain('<UserId>BOX\\me</UserId>');
    expect(xml).toContain('<LogonTrigger>');
    // Task Scheduler's default 72-hour kill would take the server down.
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    // schtasks parses the document as UTF-16 and the declaration must say so.
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true);
    expect(xml).toContain('\r\n');
    expect(programPathFromTaskXml('<Task/>')).toBeUndefined();
    expect(programPathFromTaskXml('<Arguments>serve</Arguments>')).toBeUndefined();
  });

  it('taskUserId prefers DOMAIN\\user, falls back to the bare name, and gives up without one', () => {
    expect(taskUserId({ USERNAME: 'me', USERDOMAIN: 'BOX' })).toBe('BOX\\me');
    expect(taskUserId({ USERNAME: 'me', COMPUTERNAME: 'BOX' })).toBe('BOX\\me');
    expect(taskUserId({ USERNAME: 'me' })).toBe('me');
    expect(taskUserId({})).toBeUndefined();
  });

  it('the Scheduled Task name follows LEXICON_SERVE_LABEL, and rejects a name schtasks would misread', () => {
    expect(scheduledTaskName({})).toBe('Lexicon');
    expect(scheduledTaskName({ [SERVE_LABEL_ENV_VAR]: 'Lexicon.test' })).toBe('Lexicon.test');
    expect(scheduledTaskName({ [SERVE_LABEL_ENV_VAR]: '\\Folder\\Task' })).toBe('Lexicon');
  });
});

// ---------------------------------------------------------------------------
// packs + aliases (own server and lexicon so the term counts above stay put)
// ---------------------------------------------------------------------------

describe('packs and aliases routes', () => {
  let home2: string;
  let globalPath2: string;
  let cwd2: string;
  let srv2: LexiconHttpServer;
  let info2: ServeStartInfo;

  async function api2(method: string, route: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${info2.token}`, ...extra };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${info2.url}${route}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }

  beforeAll(async () => {
    home2 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-packs-')));
    globalPath2 = path.join(home2, 'lexicon', 'lexicon.yaml');
    cwd2 = path.join(home2, 'work');
    await fs.mkdir(cwd2, { recursive: true });
    srv2 = createServer({ port: 0, cwd: cwd2, globalPath: globalPath2, quiet: true, reloadMs: 0 });
    info2 = await srv2.start();
  });

  afterAll(async () => {
    await srv2.stop();
    await fs.rm(home2, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('GET /packs lists the shipped packs with an installed flag and needs a token', async () => {
    expect((await fetch(`${info2.url}/packs`)).status).toBe(401);
    const res = await api2('GET', '/packs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packs: { name: string; title: string; terms: number; aliases: number; installed: boolean; path: string }[]; installed: string[] };
    expect(body.packs.map((p) => p.name)).toEqual(['ai', 'business', 'developer', 'voice-tools']);
    expect(body.packs.every((p) => p.installed === false && p.terms > 0 && p.aliases > 0 && p.path.endsWith('.yaml'))).toBe(true);
    expect(body.installed).toEqual([]);
    expect((await api2('POST', '/packs', {})).status).toBe(405);
  });

  // Catches: GET /packs left out what MCP list_packs and `pack list --json` report:
  // a community pack the lexicon lists with no registry record, and a skipped project file.
  it('GET /packs lists community refs and carries registryMismatch, projectTrust and skippedProject', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-packs-community-')));
    const globalPath = path.join(dir, 'config', 'lexicon.yaml');
    const repo = path.join(dir, 'repo');
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.writeFile(globalPath, 'version: 1\nsettings:\n  packs: [developer, example/cardiology]\nterms:\n  - canonical: Kubectl\n    aliases: [cube control]\n');
    await fs.writeFile(path.join(repo, '.lexicon.yaml'), 'version: 1\nsettings:\n  packs: [ai]\nterms: []\n');
    const srv = createServer({ port: 0, cwd: repo, globalPath, quiet: true, reloadMs: 0 });
    const started = await srv.start();
    try {
      const res = await fetch(`${started.url}/packs`, { headers: { Authorization: `Bearer ${started.token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { packs: { name: string; installed: boolean }[]; installed: string[]; registryMismatch?: unknown; projectTrust?: string; skippedProject?: string };
      expect(body.installed).toEqual(['developer', 'example/cardiology']);
      expect(body.packs.find((p) => p.name === 'developer')?.installed).toBe(true);
      // The untrusted project file records `ai`; it is not read, so `ai` is not installed.
      expect(body.packs.find((p) => p.name === 'ai')?.installed).toBe(false);
      expect(body.registryMismatch).toEqual({ fileOnly: ['example/cardiology'], recordOnly: [] });
      expect(body.projectTrust).toBe('untrusted');
      expect(body.skippedProject).toBe(path.join(repo, '.lexicon.yaml'));
    } finally {
      await srv.stop();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  // Catches: LexiconBar's pack card (apps/macos LocalAPI.swift installPack)
  // read only `added` and `merged`, so a reinstall read "64 terms merged"
  // though the server said the pack was already installed and nothing was
  // added. No Swift toolchain runs here, so this pins the keys it reads to
  // the real response instead.
  it('the menu bar app reads alreadyInstalled and summary from POST /packs/:name, keys the response has', async () => {
    const swift = await fs.readFile(path.join(process.cwd(), 'apps/macos/LexiconBar/Sources/LexiconBar/LocalAPI.swift'), 'utf8');
    const fn = swift.slice(swift.indexOf('func installPack('), swift.indexOf('func uninstallPack('));
    expect(fn.length).toBeGreaterThan(0);
    const keys = [...fn.matchAll(/\$0\["([A-Za-z]+)"\]/g)].map((m) => m[1]);
    expect(keys).toEqual(expect.arrayContaining(['added', 'merged', 'alreadyInstalled', 'summary']));
    expect(swift).toMatch(/if let serverSummary, !serverSummary\.isEmpty \{ return serverSummary \}/);
    const res = await api2('POST', '/packs/voice-tools');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    try {
      for (const key of keys) expect(body, key).toHaveProperty(key);
      expect(typeof body.summary).toBe('string');
      expect(typeof body.alreadyInstalled).toBe('boolean');
    } finally {
      expect((await api2('DELETE', '/packs/voice-tools')).status).toBe(200);
    }
  });

  // Catches: the pack card showed the server summary, which names the full
  // lexicon file path, in one fixed-height line with no truncation or `~`.
  // No Swift toolchain runs here, so this pins the view's source.
  it('the menu bar pack card shortens the summary path and keeps it to one line', async () => {
    const swift = await fs.readFile(path.join(process.cwd(), 'apps/macos/LexiconBar/Sources/LexiconBar/Onboarding/OnboardingViews.swift'), 'utf8');
    const card = swift.slice(swift.indexOf('private struct PackCard'), swift.indexOf('private var symbol: String'));
    expect(card).toContain('Text(Self.homeShortened(summary))');
    expect(card).toMatch(/\.lineLimit\(1\)\.truncationMode\(\.middle\)\s*\.help\(summary\)/);
    expect(card).toContain('summary.replacingOccurrences(of: home + "/", with: "~/")');
  });

  it('POST /packs/:name installs (idempotent, empty body allowed), GET /packs reflects it, DELETE /packs/:name removes', async () => {
    const first = await api2('POST', '/packs/developer');
    expect(first.status).toBe(200);
    const installed = (await first.json()) as { pack: { name: string }; added: number; merged: number; path: string; scope: string };
    expect(installed.pack.name).toBe('developer');
    expect(installed.added).toBeGreaterThan(50);
    expect(installed.merged).toBe(0);
    expect(installed.path).toBe(globalPath2);
    expect(installed.scope).toBe('global');
    expect((await readLexiconFile(globalPath2, 'global')).lexicon.settings?.packs).toEqual(['developer']);

    const list = (await (await api2('GET', '/packs')).json()) as { packs: { name: string; installed: boolean }[]; installed: string[] };
    expect(list.installed).toEqual(['developer']);
    expect(list.packs.find((p) => p.name === 'developer')?.installed).toBe(true);
    const health = (await (await fetch(`${info2.url}/health`)).json()) as { terms: number };
    expect(health.terms).toBe(installed.added);

    const again = (await (await api2('POST', '/packs/developer', {})).json()) as { added: number; merged: number; alreadyInstalled: boolean; summary: string };
    expect(again).toMatchObject({ added: 0, merged: installed.added });
    // Catches: a reinstall that changed nothing came back as "0 added, N
    // merged" with no word that the pack was already there.
    expect(again.alreadyInstalled).toBe(true);
    expect(again.summary).toMatch(new RegExp(`^developer is already installed in ${globalPath2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+ terms, \\d+ aliases\\); nothing was added$`));
    expect(installed).toMatchObject({ alreadyInstalled: false, summary: `installed developer: ${installed.added} added, 0 merged into ${globalPath2}` });

    // The new terms are live for /normalize right away.
    const norm = await api2('POST', '/normalize', { text: 'deploy to cuban eats on versal with superbase' });
    expect(((await norm.json()) as NormalizeResult).output).toBe('deploy to Kubernetes on Vercel with Supabase');

    const removed = await api2('DELETE', '/packs/developer');
    expect(removed.status).toBe(200);
    const body = (await removed.json()) as { pack: { name: string }; removed: string[]; kept: string[]; files: string[] };
    expect(body.pack.name).toBe('developer');
    // Kubernetes, Vercel and Supabase got hits from the normalize above and stay.
    expect(body.kept.sort()).toEqual(['Kubernetes', 'Supabase', 'Vercel']);
    expect(body.removed).toHaveLength(installed.added - 3);
    expect(body.files).toEqual([globalPath2]);
    expect(((await (await api2('GET', '/packs')).json()) as { installed: string[] }).installed).toEqual([]);

    // Catches: removing a pack no file lists answered 200 with three empty
    // arrays and no word that nothing was removed.
    expect((body as unknown as { summary: string }).summary).toMatch(new RegExp(`^removed ${installed.added - 3} terms of developer from .+; kept 3 you edited \\(hits, extra aliases or never-words\\): `));
    expect(body).not.toHaveProperty('notInstalled');
    const absent = await api2('DELETE', '/packs/developer');
    expect(absent.status).toBe(200);
    expect(await absent.json()).toMatchObject({ removed: [], files: [], notInstalled: true, summary: 'developer is not installed; nothing was removed' });
    expect(await (await api2('DELETE', '/packs/developer?scope=global')).json()).toMatchObject({ notInstalled: true, summary: 'developer is not installed in the global lexicon; nothing was removed' });
  });

  it('404 for an unknown pack, 405 for GET on a pack, 400 for a bad scope or body', async () => {
    const missing = await api2('POST', '/packs/nope');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: expect.stringContaining('unknown pack "nope"') });
    expect((await api2('DELETE', '/packs/nope')).status).toBe(404);
    // Names that fail the route pattern never reach the loader.
    expect((await api2('POST', '/packs/..%2Fdeveloper')).status).toBe(404);
    expect((await api2('POST', '/packs/Developer')).status).toBe(404);
    expect((await api2('GET', '/packs/developer')).status).toBe(405);
    expect((await api2('DELETE', '/packs/developer?scope=nope')).status).toBe(400);
    expect((await api2('POST', '/packs/developer', { scope: 'nope' })).status).toBe(400);
  });

  it('project scope through the same trust gate', async () => {
    const repo = path.join(home2, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const res = await api2('POST', '/packs/voice-tools', { scope: 'project', cwd: repo });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe(path.join(repo, '.lexicon.yaml'));
    const listed = (await (await api2('GET', `/packs?cwd=${encodeURIComponent(repo)}`)).json()) as { installed: string[] };
    expect(listed.installed).toEqual(['voice-tools']);
    await fs.appendFile(path.join(repo, '.lexicon.yaml'), '# hand edit\n');
    const refused = await api2('POST', '/packs/ai', { scope: 'project', cwd: repo });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toContain('has changed since it was trusted, so nothing was written.');
    const removal = await api2('DELETE', `/packs/voice-tools?cwd=${encodeURIComponent(repo)}`);
    expect(removal.status).toBe(403);
    expect(((await removal.json()) as { error: string }).error).toContain('or retry with ?scope=global to use the global lexicon instead');
  });

  it('GET /aliases?canonical=X returns suggestAliases and 400 without a canonical', async () => {
    const res = await api2('GET', `/aliases?canonical=${encodeURIComponent('Ashlr.AI')}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { canonical: string; aliases: string[] };
    expect(body.canonical).toBe('Ashlr.AI');
    expect(body.aliases).toEqual(suggestAliases('Ashlr.AI'));
    expect(body.aliases).toContain('Ashler');
    // Catches: the 400 named the parameter but not how to pass it.
    const missing = await api2('GET', '/aliases');
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'canonical query parameter is required (e.g. GET /aliases?canonical=Ashlr.AI)' });
    expect((await api2('GET', '/aliases?canonical=%20')).status).toBe(400);
    expect((await api2('GET', `/aliases?canonical=${'a'.repeat(81)}`)).status).toBe(400);
    // Catches: the cap was a literal 80 on the raw value, so invisible
    // characters (which the schema strips from a canonical) counted toward
    // it and reached the answer.
    const zwsp = encodeURIComponent('\u200B\uFEFF');
    const padded = await api2('GET', `/aliases?canonical=${zwsp}${'a'.repeat(80)}${zwsp}`);
    expect(padded.status).toBe(200);
    expect(((await padded.json()) as { canonical: string }).canonical).toBe('a'.repeat(80));
    const hidden = (await (await api2('GET', `/aliases?canonical=Ashlr${zwsp}.AI`)).json()) as { canonical: string; aliases: string[] };
    expect(hidden).toEqual({ canonical: 'Ashlr.AI', aliases: suggestAliases('Ashlr.AI') });
    expect(await (await api2('GET', `/aliases?canonical=${'a'.repeat(81)}`)).json()).toEqual({ error: 'canonical must be at most 80 characters' });
    // Catches: a control character inside the name (which NonEmptyWord
    // refuses, so no term could hold it) was let through to suggestAliases.
    for (const ctl of ['\n', '\t', '\u0007', '\u0085', ' ']) {
      const res = await api2('GET', `/aliases?canonical=${encodeURIComponent(`Ashlr${ctl}AI`)}`);
      expect(res.status, JSON.stringify(ctl)).toBe(400);
      expect(await res.json()).toEqual({ error: 'canonical must not contain control characters or newlines' });
    }
    // Outer whitespace controls are trimmed, as the schema trims a canonical.
    expect((await (await api2('GET', `/aliases?canonical=${encodeURIComponent('\tAshlr.AI\n')}`)).json())).toEqual({ canonical: 'Ashlr.AI', aliases: suggestAliases('Ashlr.AI') });
    expect((await api2('POST', '/aliases', { canonical: 'x' })).status).toBe(405);
    expect((await fetch(`${info2.url}/aliases?canonical=x`)).status).toBe(401);
  });

  it('preflight for an extension origin advertises DELETE', async () => {
    const res = await fetch(`${info2.url}/packs/developer`, { method: 'OPTIONS', headers: { Origin: 'chrome-extension://abc' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, DELETE');
  });
});

// ---------------------------------------------------------------------------
// Consumer contract: Phantom desktop voice
// ---------------------------------------------------------------------------

/**
 * Phantom's desktop app (ashlrai/phantom desktop/src-tauri/src/voice/lexicon.rs)
 * reads serve.json, then talks raw HTTP/1.0 over loopback: a dry-run
 * POST /normalize whose replacements it applies itself by UTF-16 offset,
 * GET /lexicon for an offline cache of global terms, and
 * GET /export/whisper-prompt. These tests pin the fields it reads. Its serde
 * types are strict: one term without a string canonical or string aliases, or
 * a non-string `paths` value, fails the whole response. A few checks here
 * (no chunking, text/plain, the 32-hex token) pin the server more tightly
 * than the client strictly needs, on purpose.
 */
function phantomRequest(method: string, route: string, body = ''): Promise<{ head: string; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(info.port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (d: Buffer) => chunks.push(d));
    socket.on('error', reject);
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const split = raw.indexOf('\r\n\r\n');
      resolve({ head: raw.slice(0, split), body: raw.slice(split + 4) });
    });
    socket.write(
      `${method} ${route} HTTP/1.0\r\nHost: 127.0.0.1:${info.port}\r\nAuthorization: Bearer ${info.token}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
  });
}

describe('consumer contract: Phantom desktop voice client', () => {
  it('serve.json sits beside LEXICON_PATH with a numeric port and a header-safe token', async () => {
    expect(getServePath()).toBe(path.join(path.dirname(env.globalPath), 'serve.json'));
    const raw = JSON.parse(await fs.readFile(getServePath(), 'utf8')) as { port: unknown; token: unknown };
    expect(typeof raw.port).toBe('number');
    expect(raw.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a dry-run /normalize over HTTP/1.0 returns UTF-16 spans that rebuild the real output', async () => {
    const text = 'deploy 🚀 to ashler, then ping Ashlar ✅';
    const dry = await phantomRequest('POST', '/normalize', JSON.stringify({ text, dryRun: true, cwd: env.cwd }));
    expect(dry.head).toMatch(/^HTTP\/1\.[01] 200 /);
    expect(dry.head.toLowerCase()).not.toContain('transfer-encoding: chunked');
    const out = JSON.parse(dry.body) as { input: string; replacements: Array<{ start: number; end: number; original: string; replacement: string }> };
    expect(out.input).toBe(text);
    expect(out.replacements.length).toBe(2);
    let rebuilt = text;
    let floor = Number.POSITIVE_INFINITY;
    for (const r of [...out.replacements].sort((a, b) => b.start - a.start)) {
      expect(text.slice(r.start, r.end)).toBe(r.original);
      expect(r.end).toBeLessThanOrEqual(floor);
      rebuilt = rebuilt.slice(0, r.start) + r.replacement + rebuilt.slice(r.end);
      floor = r.start;
    }
    const real = (await (await api('POST', '/normalize', { text, dryRun: true, cwd: env.cwd })).json()) as { output: string };
    const applied = (await (await api('POST', '/normalize', { text, cwd: env.cwd })).json()) as { output: string };
    expect(real.output).toBe(text);
    expect(rebuilt).toBe(applied.output);
    expect(rebuilt).toBe('deploy 🚀 to Ashlr.AI, then ping Ashlr.AI ✅');
  });

  it('GET /lexicon gives global terms with provenance Phantom can cache', async () => {
    const res = await phantomRequest('GET', `/lexicon?cwd=${encodeURIComponent(env.cwd)}`);
    const body = JSON.parse(res.body) as {
      lexicon: { terms: Array<{ canonical: unknown; aliases: unknown; caseSensitive?: unknown; scope?: unknown }> };
      paths: { global?: string; project?: string };
      projectTrust?: string;
    };
    expect(body.paths.global).toBe(env.globalPath);
    expect(body.paths.project).toBeUndefined();
    expect(body.projectTrust).toBeUndefined();
    expect(Object.values(body.paths).every((v) => typeof v === 'string')).toBe(true);
    expect(body.lexicon.terms.find((t) => t.canonical === 'Ashlr.AI')?.scope).toBe('global');
    for (const t of body.lexicon.terms) {
      expect(typeof t.canonical).toBe('string');
      expect(Array.isArray(t.aliases) && t.aliases.every((a) => typeof a === 'string')).toBe(true);
      if ('caseSensitive' in t) expect(typeof t.caseSensitive).toBe('boolean');
      if ('scope' in t && t.scope !== null) expect(typeof t.scope).toBe('string');
    }
  });

  // Phantom caches only when `paths` has no project AND `projectTrust` is
  // absent; `projectTrust` is set whenever a project file exists, so a skipped
  // file still keeps the response live-only after `paths` dropped it.
  it('GET /lexicon reports project context, which Phantom keeps out of its cache', async () => {
    const res = await phantomRequest('GET', `/lexicon?cwd=${encodeURIComponent(env.untrustedProject)}`);
    const body = JSON.parse(res.body) as { paths: { project?: string }; projectTrust?: string; skippedProject?: string };
    expect(body.paths.project).toBeUndefined();
    expect(body.skippedProject).toBe(path.join(env.untrustedProject, '.lexicon.yaml'));
    expect(body.projectTrust).toBe('untrusted');
  });

  it('GET /export/whisper-prompt is plain comma-separated canonicals', async () => {
    const res = await phantomRequest('GET', `/export/whisper-prompt?cwd=${encodeURIComponent(env.cwd)}`);
    expect(res.head).toMatch(/^HTTP\/1\.[01] 200 /);
    expect(res.head.toLowerCase()).toContain('content-type: text/plain');
    expect(res.body.trim().split(', ')).toContain('Ashlr.AI');
  });

  it('answers 401 without the bearer token, which makes Phantom drop its cache', async () => {
    const res = await rawGet('/lexicon', {});
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Notes on an empty lexicon, a filter that matches nothing, a skipped project
// ---------------------------------------------------------------------------

describe('notes on an empty or partial answer', () => {
  let dir: string;
  let globalPath: string;
  let emptyRepo: string;
  let untrustedOnly: string;
  let notes: LexiconHttpServer;
  let started: ServeStartInfo;
  const call = async (method: string, route: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> =>
    fetch(`${started.url}${route}`, {
      method,
      headers: { Authorization: `Bearer ${started.token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const at = (route: string, cwd: string): string => `${route}${route.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(cwd)}`;

  beforeAll(async () => {
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-serve-notes-')));
    globalPath = path.join(dir, 'config', 'lexicon.yaml');
    emptyRepo = path.join(dir, 'empty');
    untrustedOnly = path.join(dir, 'untrusted');
    await fs.mkdir(emptyRepo, { recursive: true });
    await fs.mkdir(path.join(untrustedOnly, '.git'), { recursive: true });
    await fs.writeFile(path.join(untrustedOnly, '.lexicon.yaml'), 'version: 1\nterms:\n  - canonical: HostileCorp\n    aliases: [hostyle]\n', 'utf8');
    // No global lexicon file at all: the merged lexicon has no terms.
    notes = createServer({ port: 0, cwd: emptyRepo, globalPath, quiet: true, reloadMs: 0 });
    started = await notes.start();
  });

  afterAll(async () => {
    await notes.stop();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Catches: GET /export/:format answered 200 with an empty body and no word
  // of why, where `lexicon export` and MCP export_lexicon say so in a note.
  it('GET /export/:format names why an export is empty in X-Lexicon-Note, the body unchanged', async () => {
    const empty = await call('GET', at('/export/csv', emptyRepo));
    expect(empty.status).toBe(200);
    expect(empty.headers.get(EXPORT_NOTE_HEADER)).toBe(
      'The lexicon has no terms yet, so the export is empty; run `lexicon setup`, or add one with: lexicon learn <heard> <meant>.',
    );
    expect(await empty.text()).toBe(exportLexicon({ version: 1, terms: [] }, 'csv'));
    const skipped = await call('GET', at('/export/text', untrustedOnly));
    expect(skipped.headers.get(EXPORT_NOTE_HEADER)).toContain('the only terms are in the untrusted project lexicon, which was left out; review it and run `lexicon trust`');
    expect(await skipped.text()).not.toContain('HostileCorp');

    await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand' }, { globalPath, cwd: emptyRepo });
    await addTerm({ canonical: 'Plainword', aliases: [], category: 'product' }, { globalPath, cwd: emptyRepo });
    const full = await call('GET', at('/export/text', emptyRepo));
    expect(full.headers.get(EXPORT_NOTE_HEADER)).toBeNull();
    const noMatch = await call('GET', at('/export/text?category=person', emptyRepo));
    expect(noMatch.headers.get(EXPORT_NOTE_HEADER)).toBe("No term matched ?category=person, so the export is empty; lexicon list shows each term's category.");
    expect(await noMatch.text()).toBe('');
    const noRows = await call('GET', at('/export/csv?category=product', emptyRepo));
    expect(noRows.headers.get(EXPORT_NOTE_HEADER)).toBe(
      'No exported term has an alias, and csv writes one row per alias, so the export has no rows; add one with: lexicon add <canonical> <alias>.',
    );
    // With terms loaded, a skipped project file is named too.
    const partial = await call('GET', at('/export/text', untrustedOnly));
    expect(partial.headers.get(EXPORT_NOTE_HEADER)).toBe(
      'An untrusted project .lexicon.yaml exists and was not loaded; review it and run `lexicon trust` to enable it. Its terms are not in the export.',
    );
    // An allowed browser origin may read the header.
    const cors = await call('GET', at('/export/text', untrustedOnly), undefined, { Origin: 'chrome-extension://abc' });
    expect(cors.headers.get('access-control-expose-headers')).toBe(EXPORT_NOTE_HEADER);
    await fs.rm(globalPath, { force: true });
  });
});
