/**
 * Local HTTP API (`lexicon serve`): one loopback endpoint for surfaces that
 * cannot run a hook or an MCP server (browser extension, Claude Desktop, the
 * Codex app, macOS Shortcuts, Raycast, the menu bar app).
 *
 * node:http only, no framework. Every request must carry a `Host` that names
 * this server (isAllowedHost, the DNS rebinding guard). Every request except
 * `GET /health` (without `?cwd=`) and `GET /pair` needs
 * `Authorization: Bearer <token>` (token from serve.json, see ./config.ts). `/pair` is the one-click pairing page for the browser
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
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import {
  EXPORT_FORMAT_INFO,
  addTerm,
  computeStats,
  conflictNote,
  diffSummary,
  exportLexicon,
  findRegistryRecordMismatch,
  installPack,
  installedPacks,
  resolveExportFormat,
  learnCorrection,
  listPacks,
  loadLexicon,
  loadMatcherIndex,
  normalizeWithIndex,
  recordHits,
  isProjectTrustError,
  sanitizeForDisplay,
  spellingConflicts,
  suggestAliases,
  timeBudgetIncomplete,
  uninstallPack,
} from '../core/index.js';
import type {
  ExportFormat,
  InstallPackResult,
  LearnConflict,
  LexiconStats,
  LoadedLexicon,
  RegistryRecordMismatch,
  MatcherIndex,
  NormalizeIncomplete,
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
import { errorMessage, isInputError } from '../util/errors.js';
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
  /** Matching budget per /normalize in ms. Default NORMALIZE_BUDGET_MS. */
  normalizeBudgetMs?: number;
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
  /** Present only when matching stopped at the time budget (`reasons: ['time']`). */
  incomplete?: NormalizeIncomplete;
}

export interface LearnResponse {
  term: Term;
  created: boolean;
  aliasAdded: boolean;
  /** Path of the lexicon file written. */
  path: string;
  /** Another term that also claims `heard` (LearnResult.conflict). */
  conflict?: LearnConflict;
  /** With `conflict` only: `conflictNote([conflict])`, naming the scoped `lexicon remove --alias` command, as `learn --json` gives it. */
  note?: string;
  /** The untrusted project lexicon that also claims `heard`, path only (LearnResult.untrustedProject). */
  untrustedProject?: { path: string; trust: 'untrusted' | 'changed' };
}

export interface AddResponse {
  term: Term;
  path: string;
  created: boolean;
  /** Aliases another term also holds, so they may still be corrected to it (MCP add_term `conflicts`). Only when there is one. */
  conflicts?: LearnConflict[];
}

export interface LexiconResponse {
  lexicon: LoadedLexicon['merged'];
  /** The files merged into `lexicon`; a skipped project file is in `skippedProject` instead. */
  paths: { global: string; project?: string };
  projectTrust?: LoadedLexicon['projectTrust'];
  /** Path only; the contents of an untrusted file never leave the disk. */
  skippedProject?: string;
}

/**
 * `GET /stats`: `LexiconStats` plus, as `/lexicon` and `/packs` carry them,
 * `projectTrust` and the skipped project file's path. The counts leave a
 * skipped file out, and nothing said so.
 */
export interface StatsResponse extends LexiconStats {
  projectTrust?: LoadedLexicon['projectTrust'];
  /** Path only: its terms are not in the counts. */
  skippedProject?: string;
}

export interface PacksResponse {
  /** Every pack shipped with the package, with whether the loaded lexicon lists it. */
  packs: (PackInfo & { installed: boolean })[];
  /** Names from `settings.packs` of the global and (trusted) project files, community refs (`author/name`) included. */
  installed: string[];
  /** The lexicon files and the registry records disagree about a community pack (as MCP list_packs reports it). */
  registryMismatch?: RegistryRecordMismatch;
  projectTrust?: LoadedLexicon['projectTrust'];
  /** Path only: a pack only this skipped project file records reads as not installed. */
  skippedProject?: string;
}

export interface AliasesResponse {
  canonical: string;
  aliases: string[];
}

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_CONCURRENT_REQUESTS = 64;
export const LEXICON_RELOAD_MS = 2_000;
/**
 * How long one /normalize may spend matching before it stops and returns the
 * corrections found so far (the hook's HOOK_MATCH_BUDGET_MS, for a server).
 * The server is one thread: a 1 MB paste against a large lexicon used to hold
 * every other client for seconds, and the extension, which gives up after
 * 1.5 s, fell back to its embedded engine while the send waited. Under that
 * timeout on purpose.
 */
export const NORMALIZE_BUDGET_MS = 1_000;
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

// Bodies are strict: an unknown key is a 400, not ignored. A typo such as
// `dry_run` for `dryRun` used to be dropped, so the request ran as if the
// option had not been sent (a dry run that recorded hits, an add that
// generated aliases the caller never asked for) and still answered 200.

const NormalizeBody = z.object({
  text: z.string(),
  dryRun: z.boolean().optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  cwd: CwdField,
}).strict();

const LearnBody = z.object({
  heard: z.string(),
  meant: z.string(),
  scope: z.enum(TERM_SCOPES).optional(),
  cwd: CwdField,
}).strict();

const AddBody = z.object({
  canonical: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  phonetic: z.string().optional(),
  category: z.enum(TERM_CATEGORIES).optional(),
  notes: z.string().optional(),
  never: z.array(z.string()).optional(),
  scope: z.enum(TERM_SCOPES).optional(),
  cwd: CwdField,
}).strict();

const PackBody = z.object({
  scope: z.enum(TERM_SCOPES).optional(),
  cwd: CwdField,
}).strict();

/** `/packs/<name>`; the name is validated again by `loadPack` (PACK_NAME_RE). */
const PACK_ROUTE_RE = /^\/packs\/([a-z0-9-]+)$/;
/** `/export/<format>`, any case: resolveExportFormat lowercases, like `lexicon export` and the MCP tool. */
const EXPORT_ROUTE_RE = /^\/export\/([a-z-]+)$/i;

/**
 * The status for an error thrown while handling a request. 400 is for what
 * the request got wrong (`HttpError`s raised here, and core's `InputError`:
 * an empty canonical, heard equal to meant, a term the schema rejects);
 * anything else (a lexicon file that does not parse, a lock still held after
 * its timeout, EACCES) is the server's state, so 500, which tells a client to
 * retry or report rather than to change its input.
 */
export function errorStatus(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (isProjectTrustError(err)) return 403;
  if (err instanceof Error && err.name === 'PackNotFoundError') return 404;
  if (isInputError(err)) return 400;
  return 500;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Extra response headers, such as the `Allow` a 405 must carry. */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * A 405 with the `Allow` header RFC 9110 requires, so a client can tell which
 * method the route takes without parsing the message. It used to be absent.
 */
function wrongMethod(allow: readonly string[], message = `use ${allow.join(' or ')}`): HttpError {
  return new HttpError(405, message, { Allow: allow.join(', ') });
}

/**
 * The 405 of a GET route. HEAD is answered like GET without a body (RFC 9110
 * 9.3.2), so `Allow` names both; the message still says `use GET`.
 */
function notGet(): HttpError {
  return wrongMethod(['GET', 'HEAD'], 'use GET');
}

/**
 * The query string is a GET route's body, so it is strict like the bodies: an
 * unknown parameter is a 400 naming it and the ones the route takes, and a
 * parameter given twice is a 400 unless it is listed in `repeatable`. A typo
 * (`?cdw=`) or an option a route does not have (`/export/csv?limit=10`, which
 * the CLI and MCP export take) used to be dropped, and the answer came back
 * 200 as if it had been applied.
 */
function strictQuery(url: URL, route: string, allowed: readonly string[], repeatable: readonly string[] = []): void {
  const takes = allowed.length > 0 ? `takes ${allowed.join(', ')}` : 'takes no query parameters';
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowed.includes(key)) throw new HttpError(400, `unknown query parameter "${sanitizeForDisplay(key)}" (${route} ${takes})`);
    if (!repeatable.includes(key) && url.searchParams.getAll(key).length > 1) throw new HttpError(400, `query parameter "${key}" given more than once`);
  }
}

/**
 * `?category=` (repeated or comma-separated) and `?limit=` of `GET
 * /export/:format`, the CLI's `--category` and `--limit`. An unknown category
 * or a limit that is not a positive integer is a 400.
 */
function exportQueryOptions(url: URL): { categories?: TermCategory[]; limit?: number } {
  const categories: TermCategory[] = [];
  for (const raw of url.searchParams.getAll('category').flatMap((v) => v.split(','))) {
    const value = raw.trim().toLowerCase();
    if (value === '') continue;
    const category = TERM_CATEGORIES.find((c) => c === value);
    if (category === undefined) {
      throw new HttpError(400, `unknown category "${sanitizeForDisplay(raw.trim())}" (one of: ${TERM_CATEGORIES.join(', ')})`);
    }
    if (!categories.includes(category)) categories.push(category);
  }
  const limitParam = url.searchParams.get('limit');
  let limit: number | undefined;
  if (limitParam !== null) {
    limit = /^\d+$/.test(limitParam.trim()) ? Number(limitParam.trim()) : NaN;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new HttpError(400, `limit must be a positive integer, got "${sanitizeForDisplay(limitParam)}"`);
  }
  return { ...(categories.length > 0 ? { categories } : {}), ...(limit !== undefined ? { limit } : {}) };
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
  /** Loaded on the first /normalize against this load (loadMatcherIndex); a 2000-term build is ~50 ms. */
  index?: MatcherIndex;
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

/**
 * True when a /pair request may be answered given its `Origin` header: none
 * (a top-level navigation, which is how the extension's content script meets
 * the page) or the page's own origin. Anything else is a script on another
 * origin fetching the token. CORS is granted to every browser-extension origin
 * for the bearer routes, and those are useless without the token; /pair is
 * the one route that hands it out, so it gets no CORS headers and refuses a
 * cross-origin fetch outright, which keeps any other installed extension or
 * an `allowedOrigins` page from reading it.
 */
export function isPairOrigin(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!hostHeader) return false;
  return origin.trim().toLowerCase() === `http://${hostHeader.trim().toLowerCase()}`;
}

/**
 * True when `hostHeader` names this server: `127.0.0.1:<port>`,
 * `localhost:<port>` or `[::1]:<port>`, checked on every route. A page that
 * rebinds its own DNS name to 127.0.0.1 reaches the server with its own name
 * in `Host`, so it is refused before any route runs. With a non-loopback
 * `--host`, the bound address itself is accepted too (any IP literal for a
 * wildcard bind): an IP literal is what a client typed, never a rebound name.
 */
export function isAllowedHost(hostHeader: string | undefined, port: number, bindHost: string = DEFAULT_HOST): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  if (h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`) return true;
  const suffix = `:${port}`;
  if (!h.endsWith(suffix)) return false;
  let name = h.slice(0, -suffix.length);
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  if (net.isIP(name) === 0) return false;
  const bind = bindHost.trim().toLowerCase();
  if (bind === '0.0.0.0' || bind === '::') return true;
  return name === bind;
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
  const normalizeBudgetMs = opts.normalizeBudgetMs ?? NORMALIZE_BUDGET_MS;

  let config: ServeConfig | undefined;
  let boundPort = 0;
  let inFlight = 0;
  const cache = new Map<string, CachedLexicon>();

  /**
   * The request's `cwd` (body field or `?cwd=`), or the server's own when it
   * has none. A `cwd` that is empty or is not an existing directory is a 400:
   * a typo used to fall through to the global lexicon alone, so the answer
   * came back 200 for a project that was never looked at.
   */
  async function resolveCwd(given: string | null | undefined): Promise<string> {
    if (given === null || given === undefined) return defaultCwd;
    if (given.trim() === '') throw new HttpError(400, 'cwd must not be empty (omit it to use the server\'s directory)');
    const resolved = path.resolve(given);
    let isDir = false;
    try {
      isDir = (await fs.stat(resolved)).isDirectory();
    } catch {
      // missing or unreadable: reported below
    }
    if (!isDir) throw new HttpError(400, `cwd is not an existing directory: ${sanitizeForDisplay(resolved)}`);
    return resolved;
  }

  async function loadEntry(cwd: string): Promise<CachedLexicon> {
    const now = Date.now();
    const hit = cache.get(cwd);
    if (hit && now - hit.at < reloadMs) return hit;
    const loaded = await loadLexicon({ cwd, ...storeOpts });
    if (cache.size >= MAX_CACHED_CWDS && !cache.has(cwd)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const entry: CachedLexicon = { loaded, at: now };
    cache.set(cwd, entry);
    return entry;
  }

  async function load(cwd: string): Promise<LoadedLexicon> {
    return (await loadEntry(cwd)).loaded;
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
    const cwd = await resolveCwd(body.cwd);
    const entry = await loadEntry(cwd);
    // From index-cache.json when the hook (or an earlier load) already built
    // the index for this exact lexicon, which survives the reload that
    // follows every hit-counting request.
    entry.index ??= await loadMatcherIndex(entry.loaded);
    const started = Date.now();
    let timedOut = false;
    const result = normalizeWithIndex(body.text, entry.index, {
      shouldStop: () => (timedOut ||= Date.now() - started >= normalizeBudgetMs),
      ...(body.dryRun !== undefined ? { dryRun: body.dryRun } : {}),
      ...(body.minConfidence !== undefined ? { minConfidence: body.minConfidence } : {}),
    });
    if (result.changed && !body.dryRun) {
      const canonicals = [...new Set(result.replacements.map((r) => r.canonical))];
      // Best effort, like the MCP server: a store hiccup never fails a normalize.
      await recordHits(canonicals, { cwd, ...storeOpts }).catch(() => undefined);
      invalidate();
    }
    return {
      ...result,
      summary: result.replacements.length > 0 ? diffSummary(result) : '',
      // Without it a body cut short by the budget reads as fully corrected.
      ...(timedOut ? { incomplete: timeBudgetIncomplete(body.text.length, normalizeBudgetMs) } : {}),
    };
  }

  async function handleLearn(raw: unknown): Promise<LearnResponse> {
    const body = parseBody(LearnBody, raw);
    const cwd = await resolveCwd(body.cwd);
    const result = await learnCorrection(
      { heard: body.heard, meant: body.meant },
      { cwd, ...storeOpts, ...(body.scope !== undefined ? { scope: body.scope } : {}) },
    );
    invalidate();
    return {
      term: result.term,
      created: result.created,
      aliasAdded: result.aliasAdded,
      path: result.file.path,
      ...(result.conflict ? { conflict: result.conflict, note: conflictNote([result.conflict]) } : {}),
      ...(result.untrustedProject ? { untrustedProject: result.untrustedProject } : {}),
    };
  }

  async function handleAdd(raw: unknown): Promise<AddResponse> {
    const body = parseBody(AddBody, raw);
    const cwd = await resolveCwd(body.cwd);
    // Generated aliases only when this creates the term (see addTerm's defaultAliases).
    const aliases = body.aliases ?? [];
    const given = aliases.length > 0;
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
    const saved = await addTerm(term, {
      cwd,
      ...storeOpts,
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
      ...(given ? {} : { defaultAliases: suggestAliases(body.canonical) }),
    });
    invalidate();
    // An alias another term already holds may keep being corrected to that
    // term: report it, as MCP add_term and `lexicon add --json` do, instead
    // of a bare success. Best effort: a reload that fails loses the report.
    const conflicts = await load(cwd).then(
      (loaded) => spellingConflicts(loaded.merged, saved.term.aliases, saved.term.canonical),
      () => [],
    );
    return { term: saved.term, path: saved.file.path, created: saved.created, ...(conflicts.length > 0 ? { conflicts } : {}) };
  }

  async function handleLexicon(cwd: string): Promise<LexiconResponse> {
    const loaded = await load(cwd);
    // The files merged into `lexicon`, as MCP list_terms reports `paths`: a
    // skipped (untrusted or changed) project file is `skippedProject`, not a
    // path in use. `projectTrust` is set whenever a project file exists.
    return {
      lexicon: loaded.merged,
      paths: { global: loaded.global.path, ...(loaded.project ? { project: loaded.project.path } : {}) },
      ...(loaded.projectTrust !== undefined ? { projectTrust: loaded.projectTrust } : {}),
      ...(loaded.skippedProject !== undefined ? { skippedProject: loaded.skippedProject.path } : {}),
    };
  }

  async function handleStats(cwd: string): Promise<StatsResponse> {
    const loaded = await load(cwd);
    return {
      ...computeStats(loaded),
      ...(loaded.projectTrust !== undefined ? { projectTrust: loaded.projectTrust } : {}),
      ...(loaded.skippedProject !== undefined ? { skippedProject: loaded.skippedProject.path } : {}),
    };
  }

  async function handlePacks(cwd: string): Promise<PacksResponse> {
    const [packs, loaded] = await Promise.all([listPacks(), load(cwd)]);
    const installed = installedPacks(loaded);
    // The same additive keys MCP list_packs and `pack list --json` carry. A
    // registry index is never read here: listing its community packs would
    // have the local API fetch whatever URL or path a caller names.
    const mismatch = await findRegistryRecordMismatch(loaded, { cwd, ...storeOpts });
    return {
      packs: packs.map((p) => ({ ...p, installed: installed.includes(p.name) })),
      installed,
      ...(mismatch ? { registryMismatch: mismatch } : {}),
      ...(loaded.projectTrust !== undefined ? { projectTrust: loaded.projectTrust } : {}),
      ...(loaded.skippedProject !== undefined ? { skippedProject: loaded.skippedProject.path } : {}),
    };
  }

  async function handleInstallPack(name: string, raw: unknown): Promise<InstallPackResult> {
    const body = parseBody(PackBody, raw);
    const cwd = await resolveCwd(body.cwd);
    const result = await installPack(name, { cwd, ...storeOpts, ...(body.scope !== undefined ? { scope: body.scope } : {}) });
    invalidate();
    return result;
  }

  async function handleUninstallPack(name: string, url: URL): Promise<UninstallPackResult> {
    // The query string is this route's body, so it is strict too: a typo such
    // as `?scop=project` was ignored and the pack came out of the default
    // (global) lexicon instead, still 200.
    strictQuery(url, 'DELETE /packs/:name', ['scope', 'cwd']);
    const cwd = await resolveCwd(url.searchParams.get('cwd'));
    const scopeParam = url.searchParams.get('scope');
    const scope = TERM_SCOPES.find((s) => s === scopeParam);
    if (scopeParam !== null && scope === undefined) throw new HttpError(400, `invalid scope "${sanitizeForDisplay(scopeParam)}" (global or project)`);
    const result = await uninstallPack(name, { cwd, ...storeOpts, ...(scope !== undefined ? { scope } : {}) });
    invalidate();
    return result;
  }

  /** GET /aliases?canonical=X: the spellings STT is likely to produce, for an onboarding form. */
  function handleAliases(url: URL): AliasesResponse {
    strictQuery(url, 'GET /aliases', ['canonical']);
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
    if (!isPairOrigin(req.headers.origin, req.headers.host)) {
      throw new HttpError(403, 'the pairing page is not served to cross-origin requests');
    }
    return {
      status: 200,
      text: pairPageHtml({ token: config.token, port: boundPort, version }),
      contentType: 'text/html; charset=utf-8',
      headers: { ...PAIR_HEADERS },
    };
  }

  async function route(req: http.IncomingMessage, url: URL): Promise<Response> {
    // HEAD runs the GET route (same status and headers); send() drops the
    // body. `curl -I /health` used to answer 405.
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/health') {
      // Unauthenticated, so a wrong method is answered before the token check.
      if (method !== 'GET') throw notGet();
      // Strict like every other GET route: `/health?cdw=` used to answer for
      // the server's own directory as if the typo were not there. Checked
      // before the token, and it names no directory, so it reveals nothing.
      strictQuery(url, 'GET /health', ['cwd']);
      // Without the token /health only says the server is up: a `cwd` would
      // let any local caller probe which directories carry a .lexicon.yaml
      // and whether they are trusted.
      const cwdParam = url.searchParams.get('cwd');
      if (cwdParam !== null && (!config || !tokenMatches(req.headers.authorization, config.token))) {
        throw new HttpError(401, '/health?cwd= needs the bearer token (see: lexicon serve --show); plain /health does not');
      }
      return json(200, await health(await resolveCwd(cwdParam)));
    }
    if (pathname === PAIR_PATH) {
      if (method !== 'GET') throw notGet();
      return pairPage(req);
    }

    if (!config || !tokenMatches(req.headers.authorization, config.token)) {
      throw new HttpError(401, 'missing or invalid bearer token (see: lexicon serve --show)');
    }

    if (pathname === '/normalize') {
      if (method !== 'POST') throw wrongMethod(['POST']);
      return json(200, await handleNormalize(await readJson(req, MAX_BODY_BYTES)));
    }
    if (pathname === '/learn') {
      if (method !== 'POST') throw wrongMethod(['POST']);
      return json(200, await handleLearn(await readJson(req, MAX_BODY_BYTES)));
    }
    if (pathname === '/add') {
      if (method !== 'POST') throw wrongMethod(['POST']);
      return json(200, await handleAdd(await readJson(req, MAX_BODY_BYTES)));
    }
    if (pathname === '/lexicon') {
      if (method !== 'GET') throw notGet();
      strictQuery(url, 'GET /lexicon', ['cwd']);
      return json(200, await handleLexicon(await resolveCwd(url.searchParams.get('cwd'))));
    }
    if (pathname === '/stats') {
      if (method !== 'GET') throw notGet();
      strictQuery(url, 'GET /stats', ['cwd']);
      return json(200, await handleStats(await resolveCwd(url.searchParams.get('cwd'))));
    }
    if (pathname === '/packs') {
      if (method !== 'GET') throw notGet();
      strictQuery(url, 'GET /packs', ['cwd']);
      return json(200, await handlePacks(await resolveCwd(url.searchParams.get('cwd'))));
    }
    const packMatch = PACK_ROUTE_RE.exec(pathname);
    if (packMatch) {
      if (method === 'POST') return json(200, await handleInstallPack(packMatch[1], await readJson(req, MAX_BODY_BYTES, true)));
      if (method === 'DELETE') {
        // Options travel in the query string. A body was ignored, so
        // `{ "scope": "project" }` removed the pack from the global lexicon.
        if ((await readBody(req, MAX_BODY_BYTES)).trim() !== '') {
          throw new HttpError(400, 'DELETE /packs/:name takes no body; pass scope and cwd in the query string (?scope=project&cwd=...)');
        }
        return json(200, await handleUninstallPack(packMatch[1], url));
      }
      throw wrongMethod(['POST', 'DELETE'], 'use POST to install or DELETE to remove');
    }
    if (pathname === '/aliases') {
      if (method !== 'GET') throw notGet();
      return json(200, handleAliases(url));
    }
    const exportMatch = EXPORT_ROUTE_RE.exec(pathname);
    if (exportMatch) {
      if (method !== 'GET') throw notGet();
      const format = resolveExportFormat(exportMatch[1]);
      if (format === undefined) throw new HttpError(404, `unknown export format "${sanitizeForDisplay(exportMatch[1])}"`);
      strictQuery(url, 'GET /export/:format', ['cwd', 'category', 'limit'], ['category']);
      const exportOpts = exportQueryOptions(url);
      const loaded = await load(await resolveCwd(url.searchParams.get('cwd')));
      return { status: 200, text: exportLexicon(loaded.merged, format, exportOpts), contentType: exportContentType(format) };
    }
    throw new HttpError(404, `no route for ${req.method ?? 'GET'} ${sanitizeForDisplay(pathname)}`);
  }


  /**
   * Write `response`. `Content-Length` is always set from the body, so a HEAD
   * answer (`head`) carries the length the GET would have, and no body.
   */
  function send(res: http.ServerResponse, response: Response, extra: Record<string, string>, head = false): void {
    const headers: Record<string, string> = { ...extra, ...response.headers, 'Cache-Control': 'no-store' };
    const body = 'json' in response ? JSON.stringify(response.json) : response.text;
    headers['Content-Type'] = 'json' in response ? 'application/json; charset=utf-8' : response.contentType;
    headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
    res.writeHead(response.status, headers);
    if (head) res.end();
    else res.end(body);
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const method = req.method ?? 'GET';
    const head = method === 'HEAD';
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
    // A client that goes away before the response is complete never fires
    // 'finish', so that request left no line at all. 'close' always fires.
    res.once('close', () => {
      if (opts.quiet || res.writableFinished) return;
      const stage = res.headersSent ? `after ${res.statusCode} headers were sent` : 'before a response was sent';
      log(`[serve] ${method} ${sanitizeForDisplay(url.pathname)} aborted by the client ${stage} ${Date.now() - started}ms`);
    });

    const cors: Record<string, string> = {};
    const origin = req.headers.origin;
    // Never for /pair: it carries the token (see isPairOrigin).
    const isPair = (url.pathname.replace(/\/+$/, '') || '/') === PAIR_PATH;
    if (!isPair && isOriginAllowed(origin, config?.allowedOrigins)) {
      cors['Access-Control-Allow-Origin'] = origin as string;
      cors['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
      cors['Access-Control-Allow-Methods'] = 'GET, POST, DELETE';
      cors['Access-Control-Max-Age'] = '600';
      cors['Vary'] = 'Origin';
    }

    // Before anything else, OPTIONS included (see isAllowedHost).
    if (!isAllowedHost(req.headers.host, boundPort, host)) {
      send(
        res,
        json(403, {
          error: `Host must be 127.0.0.1:${boundPort}, localhost:${boundPort} or [::1]:${boundPort} (DNS rebinding guard)`,
        }),
        {},
        head,
      );
      return;
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (inFlight >= maxConcurrent) {
      send(res, json(503, { error: 'too many concurrent requests' }), { ...cors, 'Retry-After': '1' }, head);
      return;
    }
    inFlight += 1;
    res.once('close', () => {
      inFlight -= 1;
    });

    route(req, url)
      .then((response) => send(res, response, cors, head))
      .catch((err: unknown) => {
        const status = errorStatus(err);
        // A 500's detail (a broken file and its path, a held lock) is what the
        // user needs to fix it, so a client holding the token gets it; an
        // anonymous caller (plain /health) gets only a pointer to the log.
        const authed = config !== undefined && tokenMatches(req.headers.authorization, config.token);
        let message = errorMessage(err);
        if (status === 500) {
          message = authed
            ? `internal error: ${message}`
            : 'internal error (the lexicon serve log has the detail)';
        }
        if (status === 500) log(`[serve] ${method} ${sanitizeForDisplay(url.pathname)} failed: ${errorMessage(err)}`);
        const extra: Record<string, string> = { ...cors, ...(err instanceof HttpError ? err.headers : {}) };
        if (status === 413) extra['Connection'] = 'close';
        if (status === 401) extra['WWW-Authenticate'] = 'Bearer';
        send(res, json(status, { error: message }), extra, head);
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
