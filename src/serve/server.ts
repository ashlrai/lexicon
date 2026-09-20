/**
 * Local HTTP API (`lexicon serve`): one loopback endpoint for surfaces that
 * cannot run a hook or an MCP server (browser extension, Claude Desktop, the
 * Codex app, macOS Shortcuts, Raycast, the menu bar app).
 *
 * node:http only, no framework. Every request except `GET /health` and
 * `GET /pair` needs `Authorization: Bearer <token>` (token from serve.json,
 * see ./config.ts). `/pair` is the one-click pairing page for the browser
 * extension: it carries the token in a <meta> tag and is served only to a
 * loopback client whose `Host` header names this port (see pairPageHtml).
 * CORS headers are set only for browser-extension origins or the exact
 * origins listed in `serve.json.allowedOrigins`, never `*`. `/packs` lists,
 * installs (POST) and removes (DELETE) the starter packs and `/aliases`
 * suggests spellings for an onboarding form. Bodies are JSON,
 * capped at 1 MB. The lexicon is re-read at most every 2 s per cwd and always
 * after a write; the trust gate applies exactly as everywhere else.
 *
 * `createServer()` is exported so tests and the menu bar app can embed it;
 * signal handling lives in the CLI command (src/cli/cmd-serve.ts).
 */
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import {
  EXPORT_FORMAT_INFO,
  addTerm,
  computeStats,
  diffSummary,
  exportLexicon,
  installPack,
  installedPacks,
  isExportFormat,
  learnCorrection,
  listPacks,
  loadLexicon,
  normalize,
  recordHits,
  resolvePaths,
  isProjectTrustError,
  sanitizeForDisplay,
  suggestAliases,
  uninstallPack,
} from '../core/index.js';
import type {
  ExportFormat,
  InstallPackResult,
  LexiconStats,
  LoadedLexicon,
  NormalizeResult,
  PackInfo,
  Term,
  TermCategory,
  TermScope,
  UninstallPackResult,
} from '../core/index.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  ensureServeConfig,
  getServePath,
  isOriginAllowed,
  writeServeConfig,
} from './config.js';
import type { ServeConfig } from './config.js';
import { errorMessage } from '../util/errors.js';
import { packageVersion } from '../util/package.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServeServerOptions {
  /** Port to bind. Default DEFAULT_PORT (41733); 0 picks a free port. */
  port?: number;
  /** Interface to bind. Default 127.0.0.1. Callers must warn when this is not loopback. */
  host?: string;
  /** Default directory for project-lexicon discovery when a request carries no `cwd`. Default process.cwd(). */
  cwd?: string;
  /** Explicit global lexicon path (test hook); overrides $LEXICON_PATH. serve.json lives next to it. */
  globalPath?: string;
  /** Suppress the per-request log line. */
  quiet?: boolean;
  /** Log sink for the per-request line. Default process.stderr. */
  log?: (line: string) => void;
  /** Version reported by /health. Default: package.json. */
  version?: string;
  /** Lexicon reload cadence in ms. Default LEXICON_RELOAD_MS (2000). */
  reloadMs?: number;
  /** Hard cap on in-flight requests before 503. Default MAX_CONCURRENT_REQUESTS (64). */
  maxConcurrent?: number;
}

export interface ServeStartInfo {
  port: number;
  token: string;
  host: string;
  url: string;
  /** Path of serve.json. */
  configPath: string;
}

export interface LexiconHttpServer {
  server: http.Server;
  start(): Promise<ServeStartInfo>;
  stop(): Promise<void>;
}

export interface HealthResponse {
  ok: true;
  version: string;
  terms: number;
  projectTrust?: LoadedLexicon['projectTrust'];
  port: number;
}

export interface NormalizeResponse extends NormalizeResult {
  summary: string;
}

export interface LearnResponse {
  term: Term;
  created: boolean;
  aliasAdded: boolean;
  /** Path of the lexicon file written. */
  path: string;
}

export interface AddResponse {
  term: Term;
  path: string;
  created: boolean;
}

export interface LexiconResponse {
  lexicon: LoadedLexicon['merged'];
  paths: { global: string; project?: string };
  projectTrust?: LoadedLexicon['projectTrust'];
  /** Path only; the contents of an untrusted file never leave the disk. */
  skippedProject?: string;
}

export interface PacksResponse {
  /** Every pack shipped with the package, with whether the loaded lexicon lists it. */
  packs: (PackInfo & { installed: boolean })[];
  /** Names from `settings.packs` of the global and (trusted) project files. */
  installed: string[];
}

export interface AliasesResponse {
  canonical: string;
  aliases: string[];
}

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_CONCURRENT_REQUESTS = 64;
export const LEXICON_RELOAD_MS = 2_000;
/** Path of the extension pairing page (`lexicon serve --pair` opens it). */
export const PAIR_PATH = '/pair';
/** `<meta name>` attributes the pairing page carries; extension/src/pair.ts reads the same names. */
export const PAIR_META = { token: 'lexicon-token', port: 'lexicon-port', version: 'lexicon-version' } as const;
/** How long the pairing page waits for the extension before it shows install instructions (CSS timer). */
export const PAIR_INSTALL_HINT_MS = 3_000;
/** Response headers on the pairing page beyond Content-Type and Cache-Control. */
export const PAIR_HEADERS: Readonly<Record<string, string>> = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
};
/** Bounded so a client cycling `cwd` values cannot grow the cache without limit. */
const MAX_CACHED_CWDS = 32;

/** Content type per exporter file extension (`EXPORT_FORMAT_INFO[format].ext`). */
export const EXPORT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  plist: 'application/xml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
};

export function exportContentType(format: ExportFormat): string {
  return EXPORT_CONTENT_TYPES[EXPORT_FORMAT_INFO[format].ext] ?? 'text/plain; charset=utf-8';
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const TERM_CATEGORIES = [
  'brand',
  'person',
  'product',
  'acronym',
  'identifier',
  'place',
  'other',
] as const satisfies readonly TermCategory[];
const TERM_SCOPES = ['global', 'project'] as const satisfies readonly TermScope[];

const CwdField = z.string().min(1).optional();

const NormalizeBody = z.object({
  text: z.string(),
  dryRun: z.boolean().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  cwd: CwdField,
});

const LearnBody = z.object({
  heard: z.string(),
  meant: z.string(),
  scope: z.enum(TERM_SCOPES).optional(),
  cwd: CwdField,
});

const AddBody = z.object({
  canonical: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  phonetic: z.string().optional(),
  category: z.enum(TERM_CATEGORIES).optional(),
  notes: z.string().optional(),
  never: z.array(z.string()).optional(),
  scope: z.enum(TERM_SCOPES).optional(),
  cwd: CwdField,
});

const PackBody = z.object({
  scope: z.enum(TERM_SCOPES).optional(),
  cwd: CwdField,
});

/** `/packs/<name>`; the name is validated again by `loadPack` (PACK_NAME_RE). */
const PACK_ROUTE_RE = /^\/packs\/([a-z0-9-]+)$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}



function issuesMessage(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(400, `invalid request body: ${issuesMessage(result.error)}`);
  return result.data;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return false;
  const given = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/**
 * Read a body of at most `cap` bytes. Beyond the cap the rest is drained
 * (never buffered) and the promise rejects with 413 once the client has
 * finished sending, so the client always sees the response instead of EPIPE.
 * A stream that keeps going past DRAIN_LIMIT is cut off.
 */
function readBody(req: http.IncomingMessage, cap: number): Promise<string> {
  const DRAIN_LIMIT = cap * 16;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let settled = false;
    const settle = (err?: HttpError): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const tooLarge = (): HttpError => new HttpError(413, `request body exceeds ${cap} bytes`);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > cap) overflow = true;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (!overflow && size > cap) {
        overflow = true;
        chunks.length = 0;
      }
      if (overflow) {
        if (size > DRAIN_LIMIT) {
          req.destroy();
          settle(tooLarge());
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(overflow ? tooLarge() : undefined));
    req.on('error', (err) => settle(new HttpError(400, `could not read request body: ${errorMessage(err)}`)));
    req.on('close', () => settle(overflow ? tooLarge() : new HttpError(400, 'request body was cut short')));
  });
}

/** Parse a JSON object body. With `optional`, an empty body reads as `{}` (routes whose fields are all optional). */
async function readJson(req: http.IncomingMessage, cap: number, optional = false): Promise<unknown> {
  const text = await readBody(req, cap);
  if (text.trim() === '') {
    if (optional) return {};
    throw new HttpError(400, 'request body must be a JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'request body must be a JSON object');
  }
  return parsed;
}

interface CachedLexicon {
  loaded: LoadedLexicon;
  at: number;
}

// ---------------------------------------------------------------------------
// Pairing page
// ---------------------------------------------------------------------------

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * True when `hostHeader` is exactly `127.0.0.1:<port>` or `localhost:<port>`.
 * A browser sends the Host it navigated to, so a page on another origin that
 * tricks the browser into resolving its own name to 127.0.0.1 (DNS rebinding)
 * still arrives with its own Host and is refused.
 */
export function isPairHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** `127.0.0.1`, `::1` and the IPv4-mapped `::ffff:127.x.x.x` forms. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  if (a === '::1') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  return v4.startsWith('127.');
}

export interface PairPageInput {
  token: string;
  port: number;
  version: string;
}

/**
 * The pairing page: no script (the CSP forbids it), inline CSS only, no
 * external request. The extension's `pair.js` content script reads the three
 * <meta> tags, pairs through its background worker and rewrites `#status`;
 * a CSS animation reveals `#install` after PAIR_INSTALL_HINT_MS in case no
 * extension is there to hide it.
 */
export function pairPageHtml(input: PairPageInput): string {
  const token = htmlEscape(input.token);
  const port = String(input.port);
  const version = htmlEscape(input.version);
  const delay = `${PAIR_INSTALL_HINT_MS / 1000}s`;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    '<title>Pairing Lexicon</title>',
    '<link rel="icon" href="data:,">',
    `<meta name="${PAIR_META.token}" content="${token}">`,
    `<meta name="${PAIR_META.port}" content="${port}">`,
    `<meta name="${PAIR_META.version}" content="${version}">`,
    '<style>',
    ':root{color-scheme:light dark}',
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f6f7f8;color:#1c1f22}',
    '@media(prefers-color-scheme:dark){body{background:#131517;color:#e8eaed}}',
    'main{max-width:34rem;padding:2rem 1.5rem;text-align:center}',
    '.mark{display:inline-block;width:2.5rem;height:2.5rem;border-radius:.6rem;background:#0f766e;position:relative;margin-bottom:1rem}',
    '.mark::before{content:"";position:absolute;left:36%;top:27%;width:11%;height:50%;background:#fff;border-radius:1px}',
    '.mark::after{content:"";position:absolute;left:36%;top:66%;width:36%;height:11%;background:#fff;border-radius:1px}',
    'h1{font-size:1.4rem;margin:0 0 .5rem}',
    '#status{font-size:1.1rem;margin:.5rem 0 1rem}',
    '#status.ok{color:#0f766e}',
    '#status.error{color:#b42318}',
    `#install{opacity:0;animation:reveal 0s ${delay} forwards;text-align:left;font-size:.95rem}`,
    '@keyframes reveal{to{opacity:1}}',
    'code{font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:rgba(127,127,127,.15);padding:.1em .35em;border-radius:.3em}',
    'ol{padding-left:1.25rem}',
    '.muted{opacity:.7;font-size:.85rem}',
    '</style>',
    '</head>',
    '<body>',
    '<main>',
    '<span class="mark" aria-hidden="true"></span>',
    '<h1>Pairing Lexicon...</h1>',
    '<p id="status" role="status" aria-live="polite">Waiting for the browser extension.</p>',
    '<div id="install">',
    '<p>The Lexicon extension did not answer. Install or enable it, then reload this page:</p>',
    '<ol>',
    '<li>Build it with <code>npm run build:extension</code> (or download <code>lexicon-extension.zip</code> from the release).</li>',
    '<li>Open <code>chrome://extensions</code>, turn on <strong>Developer mode</strong>, click <strong>Load unpacked</strong> and pick <code>extension/dist</code>.</li>',
    '<li>Firefox: <code>about:debugging#/runtime/this-firefox</code>, <strong>Load Temporary Add-on...</strong>, pick <code>extension/dist-firefox/manifest.json</code>.</li>',
    '<li>Come back here, or run <code>lexicon serve --pair</code> again.</li>',
    '</ol>',
    '<p class="muted">Manual fallback: <code>lexicon serve --show</code> prints the token to paste into the extension\'s Options page.</p>',
    '</div>',
    `<p class="muted">lexicon serve ${version} on port ${port}</p>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// createServer
// ---------------------------------------------------------------------------

export function createServer(opts: ServeServerOptions = {}): LexiconHttpServer {
  const host = opts.host ?? DEFAULT_HOST;
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const defaultCwd = path.resolve(opts.cwd ?? process.cwd());
  const globalPath = opts.globalPath;
  const storeOpts = globalPath !== undefined ? { globalPath } : {};
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const version = opts.version ?? packageVersion(import.meta.url);
  const reloadMs = opts.reloadMs ?? LEXICON_RELOAD_MS;
  const maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_REQUESTS;

  let config: ServeConfig | undefined;
  let boundPort = 0;
  let inFlight = 0;
  const cache = new Map<string, CachedLexicon>();

  function resolveCwd(given: string | null | undefined): string {
    return given ? path.resolve(given) : defaultCwd;
  }

  async function load(cwd: string): Promise<LoadedLexicon> {
    const now = Date.now();
    const hit = cache.get(cwd);
    if (hit && now - hit.at < reloadMs) return hit.loaded;
    const loaded = await loadLexicon({ cwd, ...storeOpts });
    if (cache.size >= MAX_CACHED_CWDS && !cache.has(cwd)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(cwd, { loaded, at: now });
    return loaded;
  }

  function invalidate(): void {
    cache.clear();
  }

  // ---- handlers ----------------------------------------------------------

  async function health(cwd: string): Promise<HealthResponse> {
    const loaded = await load(cwd);
    return {
      ok: true,
      version,
      terms: loaded.merged.terms.length,
      ...(loaded.projectTrust !== undefined ? { projectTrust: loaded.projectTrust } : {}),
      port: boundPort,
    };
  }

  async function handleNormalize(raw: unknown): Promise<NormalizeResponse> {
    const body = parseBody(NormalizeBody, raw);
    const cwd = resolveCwd(body.cwd);
    const loaded = await load(cwd);
    const result = normalize(body.text, loaded.merged, {
      ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
      ...(body.minConfidence !== undefined ? { minConfidence: body.minConfidence } : {}),
    });
    if (result.changed && !body.dryRun) {
      const canonicals = [...new Set(result.replacements.map((r) => r.canonical))];
      // Best effort, like the MCP server: a store hiccup never fails a normalize.
      await recordHits(canonicals, { cwd, ...storeOpts }).catch(() => undefined);
      invalidate();
    }
    return { ...result, summary: result.replacements.length > 0 ? diffSummary(result) : '' };
  }

  async function handleLearn(raw: unknown): Promise<LearnResponse> {
    const body = parseBody(LearnBody, raw);
    const cwd = resolveCwd(body.cwd);
    const result = await learnCorrection(
      { heard: body.heard, meant: body.meant },
      { cwd, ...storeOpts, ...(body.scope !== undefined ? { scope: body.scope } : {}) },
    );
    invalidate();
    return { term: result.term, created: result.created, aliasAdded: result.aliasAdded, path: result.file.path };
  }

  async function handleAdd(raw: unknown): Promise<AddResponse> {
    const body = parseBody(AddBody, raw);
    const cwd = resolveCwd(body.cwd);
    const aliases = body.aliases && body.aliases.length > 0 ? body.aliases : suggestAliases(body.canonical);
    const term: Term = {
      canonical: body.canonical,
      aliases,
      source: 'user',
      ...(body.phonetic !== undefined ? { phonetic: body.phonetic } : {}),
      ...(body.category !== undefined ? { category: body.category } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.never && body.never.length > 0 ? { never: body.never } : {}),
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
    };
    const saved = await addTerm(term, { cwd, ...storeOpts, ...(body.scope !== undefined ? { scope: body.scope } : {}) });
    invalidate();
    return { term: saved.term, path: saved.file.path, created: saved.created };
  }

  async function handleLexicon(cwd: string): Promise<LexiconResponse> {
    const loaded = await load(cwd);
    const paths = resolvePaths({ cwd, ...storeOpts });
    return {
      lexicon: loaded.merged,
      paths: { global: paths.global, ...(paths.project !== undefined ? { project: paths.project } : {}) },
      ...(loaded.projectTrust !== undefined ? { projectTrust: loaded.projectTrust } : {}),
      ...(loaded.skippedProject !== undefined ? { skippedProject: loaded.skippedProject.path } : {}),
    };
  }

  async function handleStats(cwd: string): Promise<LexiconStats> {
    return computeStats(await load(cwd));
  }

  async function handlePacks(cwd: string): Promise<PacksResponse> {
    const [packs, loaded] = await Promise.all([listPacks(), load(cwd)]);
    const installed = installedPacks(loaded);
    return { packs: packs.map((p) => ({ ...p, installed: installed.includes(p.name) })), installed };
  }

  async function handleInstallPack(name: string, raw: unknown): Promise<InstallPackResult> {
    const body = parseBody(PackBody, raw);
    const cwd = resolveCwd(body.cwd);
    const result = await installPack(name, { cwd, ...storeOpts, ...(body.scope !== undefined ? { scope: body.scope } : {}) });
    invalidate();
    return result;
  }

  async function handleUninstallPack(name: string, url: URL): Promise<UninstallPackResult> {
    const cwd = resolveCwd(url.searchParams.get('cwd'));
    const scopeParam = url.searchParams.get('scope');
    const scope = TERM_SCOPES.find((s) => s === scopeParam);
    if (scopeParam !== null && scope === undefined) throw new HttpError(400, `invalid scope "${sanitizeForDisplay(scopeParam)}" (global or project)`);
    const result = await uninstallPack(name, { cwd, ...storeOpts, ...(scope !== undefined ? { scope } : {}) });
    invalidate();
    return result;
  }

  /** GET /aliases?canonical=X: the spellings STT is likely to produce, for an onboarding form. */
  function handleAliases(url: URL): AliasesResponse {
    const canonical = (url.searchParams.get('canonical') ?? '').trim();
    if (!canonical) throw new HttpError(400, 'canonical query parameter is required');
    if (canonical.length > 80) throw new HttpError(400, 'canonical must be at most 80 characters');
    return { canonical, aliases: suggestAliases(canonical) };
  }

  // ---- request pipeline --------------------------------------------------

  type Response =
    | { status: number; json: unknown; headers?: Record<string, string> }
    | { status: number; text: string; contentType: string; headers?: Record<string, string> };

  function json(status: number, payload: unknown): Response {
    return { status, json: payload };
  }

  /**
   * GET /pair: the token-bearing page, without bearer auth. Two gates instead:
   * the socket must be a loopback one (a non-loopback `--host` never leaks the
   * token to the network) and `Host` must name this server as 127.0.0.1 or
   * localhost on the bound port (DNS rebinding arrives with another Host).
   */
  function pairPage(req: http.IncomingMessage): Response {
    if (!config) throw new HttpError(503, 'server is starting');
    if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpError(403, 'the pairing page is served on the loopback interface only');
    if (!isPairHost(req.headers.host, boundPort)) {
      throw new HttpError(403, `the pairing page is served for Host 127.0.0.1:${boundPort} or localhost:${boundPort} only`);
    }
    return {
      status: 200,
      text: pairPageHtml({ token: config.token, port: boundPort, version }),
      contentType: 'text/html; charset=utf-8',
      headers: { ...PAIR_HEADERS },
    };
  }

  async function route(req: http.IncomingMessage, url: URL): Promise<Response> {
    const method = req.method ?? 'GET';
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (method === 'GET' && pathname === '/health') return json(200, await health(resolveCwd(url.searchParams.get('cwd'))));
    if (pathname === PAIR_PATH) {
      if (method !== 'GET') throw new HttpError(405, 'use GET');
      return pairPage(req);
    }

    if (!config || !tokenMatches(req.headers.authorization, config.token)) {
      throw new HttpError(401, 'missing or invalid bearer token (see: lexicon serve --show)');
    }

    if (pathname === '/normalize') {
      if (method !== 'POST') throw new HttpError(405, 'use POST');
      return json(200, await handleNormalize(await readJson(req, MAX_BODY_BYTES)));
    }
    if (pathname === '/learn') {
      if (method !== 'POST') throw new HttpError(405, 'use POST');
      return json(200, await handleLearn(await readJson(req, MAX_BODY_BYTES)));
    }
    if (pathname === '/add') {
      if (method !== 'POST') throw new HttpError(405, 'use POST');
      return json(200, await handleAdd(await readJson(req, MAX_BODY_BYTES)));
    }
    if (pathname === '/lexicon') {
      if (method !== 'GET') throw new HttpError(405, 'use GET');
      return json(200, await handleLexicon(resolveCwd(url.searchParams.get('cwd'))));
    }
    if (pathname === '/stats') {
      if (method !== 'GET') throw new HttpError(405, 'use GET');
      return json(200, await handleStats(resolveCwd(url.searchParams.get('cwd'))));
    }
    if (pathname === '/packs') {
      if (method !== 'GET') throw new HttpError(405, 'use GET');
      return json(200, await handlePacks(resolveCwd(url.searchParams.get('cwd'))));
    }
    const packMatch = PACK_ROUTE_RE.exec(pathname);
    if (packMatch) {
      if (method === 'POST') return json(200, await handleInstallPack(packMatch[1], await readJson(req, MAX_BODY_BYTES, true)));
      if (method === 'DELETE') return json(200, await handleUninstallPack(packMatch[1], url));
      throw new HttpError(405, 'use POST to install or DELETE to remove');
    }
    if (pathname === '/aliases') {
      if (method !== 'GET') throw new HttpError(405, 'use GET');
      return json(200, handleAliases(url));
    }
    const exportMatch = /^\/export\/([a-z-]+)$/.exec(pathname);
    if (exportMatch) {
      if (method !== 'GET') throw new HttpError(405, 'use GET');
      const format = exportMatch[1];
      if (!isExportFormat(format)) throw new HttpError(404, `unknown export format "${format}"`);
      const loaded = await load(resolveCwd(url.searchParams.get('cwd')));
      return { status: 200, text: exportLexicon(loaded.merged, format), contentType: exportContentType(format) };
    }
    throw new HttpError(404, `no route for ${method} ${sanitizeForDisplay(pathname)}`);
  }

  function statusFor(err: unknown): number {
    if (err instanceof HttpError) return err.status;
    if (isProjectTrustError(err)) return 403;
    if (err instanceof Error && err.name === 'PackNotFoundError') return 404;
    // learnCorrection / addTerm / parseLexicon throw plain Errors on bad input.
    if (err instanceof Error && !(err instanceof TypeError)) return 400;
    return 500;
  }

  function send(res: http.ServerResponse, response: Response, extra: Record<string, string>): void {
    const headers: Record<string, string> = { ...extra, ...response.headers, 'Cache-Control': 'no-store' };
    if ('json' in response) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      res.writeHead(response.status, headers);
      res.end(JSON.stringify(response.json));
    } else {
      headers['Content-Type'] = response.contentType;
      res.writeHead(response.status, headers);
      res.end(response.text);
    }
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const method = req.method ?? 'GET';
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      url = new URL('/', 'http://localhost');
    }
    const logLine = (): void => {
      if (opts.quiet) return;
      log(`[serve] ${method} ${sanitizeForDisplay(url.pathname)} ${res.statusCode} ${Date.now() - started}ms`);
    };
    res.once('finish', logLine);

    const cors: Record<string, string> = {};
    const origin = req.headers.origin;
    if (isOriginAllowed(origin, config?.allowedOrigins)) {
      cors['Access-Control-Allow-Origin'] = origin as string;
      cors['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
      cors['Access-Control-Allow-Methods'] = 'GET, POST, DELETE';
      cors['Access-Control-Max-Age'] = '600';
      cors['Vary'] = 'Origin';
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (inFlight >= maxConcurrent) {
      send(res, json(503, { error: 'too many concurrent requests' }), { ...cors, 'Retry-After': '1' });
      return;
    }
    inFlight += 1;
    res.once('close', () => {
      inFlight -= 1;
    });

    route(req, url)
      .then((response) => send(res, response, cors))
      .catch((err: unknown) => {
        const status = statusFor(err);
        const message = status === 500 ? 'internal error' : errorMessage(err);
        if (status === 500) log(`[serve] ${method} ${sanitizeForDisplay(url.pathname)} failed: ${errorMessage(err)}`);
        const extra: Record<string, string> = { ...cors };
        if (status === 413) extra['Connection'] = 'close';
        if (status === 401) extra['WWW-Authenticate'] = 'Bearer';
        send(res, json(status, { error: message }), extra);
      });
  });

  // Close idle keep-alive sockets quickly on stop(); the default 5 s is fine while running.
  server.keepAliveTimeout = 5_000;

  let running = false;

  async function start(): Promise<ServeStartInfo> {
    if (running) throw new Error('server already started');
    config = await ensureServeConfig(storeOpts);
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `port ${requestedPort} is already in use (is lexicon serve already running? check with: lexicon serve --status)`,
            ),
          );
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(requestedPort, host, () => {
        server.off('error', onError);
        resolve();
      });
    });
    running = true;
    const address = server.address();
    boundPort = typeof address === 'object' && address !== null ? address.port : requestedPort;
    // Keep serve.json pointing at the live port so `--show`/`--status` and clients find it.
    if (config.port !== boundPort) {
      config = { ...config, port: boundPort };
      await writeServeConfig(config, storeOpts);
    }
    const shownHost = host.includes(':') ? `[${host}]` : host;
    return {
      port: boundPort,
      token: config.token,
      host,
      url: `http://${shownHost}:${boundPort}`,
      configPath: getServePath(storeOpts),
    };
  }

  async function stop(): Promise<void> {
    if (!running) return;
    running = false;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    cache.clear();
  }

  return { server, start, stop };
}
