/**
 * Local HTTP API (`lexicon serve`): one loopback endpoint for surfaces that
 * cannot run a hook or an MCP server (browser extension, Claude Desktop, the
 * Codex app, macOS Shortcuts, Raycast, the menu bar app).
 *
 * node:http only, no framework. Every request except `GET /health` needs
 * `Authorization: Bearer <token>` (token from serve.json, see ./config.ts).
 * CORS headers are set only for browser-extension origins or the exact
 * origins listed in `serve.json.allowedOrigins`, never `*`. Bodies are JSON,
 * capped at 1 MB. The lexicon is re-read at most every 2 s per cwd and always
 * after a write; the trust gate applies exactly as everywhere else.
 *
 * `createServer()` is exported so tests and the menu bar app can embed it;
 * signal handling lives in the CLI command (src/cli/cmd-serve.ts).
 */
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import {
  EXPORT_FORMAT_INFO,
  addTerm,
  computeStats,
  diffSummary,
  exportLexicon,
  isExportFormat,
  learnCorrection,
  loadLexicon,
  normalize,
  recordHits,
  resolvePaths,
  sanitizeForDisplay,
  suggestAliases,
} from '../core/index.js';
import type {
  ExportFormat,
  LexiconStats,
  LoadedLexicon,
  NormalizeResult,
  Term,
  TermCategory,
  TermScope,
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

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_CONCURRENT_REQUESTS = 64;
export const LEXICON_RELOAD_MS = 2_000;
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isProjectTrustError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ProjectTrustError';
}

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const { name, version } = parsed as { name?: unknown; version?: unknown };
      if (name === '@ashlr/lexicon' && typeof version === 'string') return version;
    }
  } catch {
    // fall through
  }
  return '0.0.0';
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

async function readJson(req: http.IncomingMessage, cap: number): Promise<unknown> {
  const text = await readBody(req, cap);
  if (text.trim() === '') throw new HttpError(400, 'request body must be a JSON object');
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
// createServer
// ---------------------------------------------------------------------------

export function createServer(opts: ServeServerOptions = {}): LexiconHttpServer {
  const host = opts.host ?? DEFAULT_HOST;
  const requestedPort = opts.port ?? DEFAULT_PORT;
  const defaultCwd = path.resolve(opts.cwd ?? process.cwd());
  const globalPath = opts.globalPath;
  const storeOpts = globalPath !== undefined ? { globalPath } : {};
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const version = opts.version ?? readPackageVersion();
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

  // ---- request pipeline --------------------------------------------------

  type Response = { status: number; json: unknown } | { status: number; text: string; contentType: string };

  function json(status: number, payload: unknown): Response {
    return { status, json: payload };
  }

  async function route(req: http.IncomingMessage, url: URL): Promise<Response> {
    const method = req.method ?? 'GET';
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (method === 'GET' && pathname === '/health') return json(200, await health(resolveCwd(url.searchParams.get('cwd'))));

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
    // learnCorrection / addTerm / parseLexicon throw plain Errors on bad input.
    if (err instanceof Error && !(err instanceof TypeError)) return 400;
    return 500;
  }

  function send(res: http.ServerResponse, response: Response, extra: Record<string, string>): void {
    const headers: Record<string, string> = { ...extra, 'Cache-Control': 'no-store' };
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
      cors['Access-Control-Allow-Methods'] = 'GET, POST';
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
