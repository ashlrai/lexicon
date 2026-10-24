/**
 * Local HTTP API (`lexicon serve`): one loopback endpoint for surfaces that
 * cannot run a hook or an MCP server (browser extension, Claude Desktop, the
 * Codex app, macOS Shortcuts, Raycast, the menu bar app).
 *
 * node:http only, no framework. Every request must carry a `Host` that names
 * this server (isAllowedHost, the DNS rebinding guard). Every request except
 * an `OPTIONS` preflight (204, no body, on any path), `GET /health` (without
 * `?cwd=`) and `GET /pair` needs `Authorization: Bearer <token>` (token from
 * serve.json, see ./config.ts); a 401 carries `WWW-Authenticate: Bearer`.
 * `/pair` is the one-click pairing page for the browser
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
import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs, realpathSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_INFO,
  LIMITS,
  addTerm,
  computeStats,
  conflictNote,
  learnUnchangedNote,
  diffSummary,
  emptyExportNote,
  emptyExportReason,
  emptyLexiconNote,
  emptyNormalizeHint,
  emptyStatsNote,
  exportLexiconWithNotes,
  findRegistryRecordMismatch,
  hasControlChars,
  findUnencodableChar,
  UNENCODABLE_NOTE,
  installPack,
  installedPacks,
  resolveExportFormat,
  learnCorrection,
  listPacks,
  loadLexicon,
  loadMatcherIndex,
  normalizeWithIndex,
  packAlreadyInstalledNote,
  recordHits,
  resolvePaths,
  isProjectTrustError,
  sanitizeForDisplay,
  sanitizeForDisplayMax,
  skippedProjectNote,
  spellingConflicts,
  stripInvisible,
  suggestAliases,
  timeBudgetIncomplete,
  unchangedTermNote,
  uninstallPack,
} from '../core/index.js';
// Built in core/notes.ts; still exported here, where POST /normalize uses it.
export { emptyNormalizeHint } from '../core/index.js';
import { EXPORT_MAX_LIMIT } from '../core/index.js';
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
  serveUrl,
  recordServePort,
} from './config.js';
import type { ServeConfig } from './config.js';
import { isHeldLockError } from '../util/atomic.js';
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
  /** Time for a whole request (headers and body) to arrive, in ms. Default REQUEST_TIMEOUT_MS (30000). */
  requestTimeoutMs?: number;
  /** Time for the request headers to arrive, in ms; at most `requestTimeoutMs`. Default HEADERS_TIMEOUT_MS (10000). */
  headersTimeoutMs?: number;
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
  /** As `/stats` gives it: set whenever a project file exists for `cwd`. */
  projectTrust?: LoadedLexicon['projectTrust'];
  /**
   * Path only: a project file that was not merged, so its names were not
   * corrected. Without it an unchanged result in a repo whose lexicon is not
   * trusted read exactly like text that needed no correction.
   */
  skippedProject?: string;
  /** `emptyNormalizeHint`: only when the merged lexicon has no terms, naming `lexicon setup` (or `lexicon trust`). */
  hint?: string;
}

export interface LearnResponse {
  term: Term;
  created: boolean;
  aliasAdded: boolean;
  /** Path of the lexicon file written. */
  path: string;
  /** Another term that also claims `heard` (LearnResult.conflict). */
  conflict?: LearnConflict;
  /** `heard` was already an alias (or a casing of the canonical) of the term, so nothing was written. Only then. */
  unchanged?: true;
  /** `meant` is an alias of the term and `heard` its canonical: the lexicon already corrects the other way (LearnResult.reversed). With `unchanged`. */
  reversed?: true;
  /**
   * With `unchanged`: `learnUnchangedNote`, followed by the conflict note when there is a
   * `conflict`. With `conflict` alone: `conflictNote([conflict])`, naming the scoped
   * `lexicon remove --alias` command, as `learn --json` gives it.
   */
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
  /** The term already had every alias and field given; nothing was written. Only then. */
  unchanged?: true;
  /** With `unchanged` only: `unchangedTermNote(canonical)`. */
  note?: string;
}

/** POST /packs/:name: the install result, `alreadyInstalled` always set, and one sentence saying what happened. */
export interface InstallPackResponse extends InstallPackResult {
  /** True when the reinstall left the file byte for byte as it was. */
  alreadyInstalled: boolean;
  /** `installed <name>: N added, M merged into <path>`, or `packAlreadyInstalledNote` for a reinstall that changed nothing. */
  summary: string;
}

/** DELETE /packs/:name: the uninstall result and one sentence saying what happened. */
export interface UninstallPackResponse extends UninstallPackResult {
  /** No lexicon file in that scope listed the pack, so nothing was written. Only then. */
  notInstalled?: true;
  /** `removed N terms of <name> from <files>` (and what was kept), or `<name> is not installed; nothing was removed` (`in the <scope> lexicon` with `?scope=`). */
  summary: string;
}

export interface LexiconResponse {
  lexicon: LoadedLexicon['merged'];
  /** The files merged into `lexicon`; a skipped project file is in `skippedProject` instead. */
  paths: { global: string; project?: string };
  projectTrust?: LoadedLexicon['projectTrust'];
  /** Path only; the contents of an untrusted file never leave the disk. */
  skippedProject?: string;
  /** `lexiconNote`: the `lexicon trust` step for a skipped project file, else how to add terms to an empty lexicon. Only then. */
  note?: string;
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
  /** `statsNote`: the `lexicon trust` step for a skipped project file, else how to add terms to an empty lexicon. Only then. */
  note?: string;
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
/**
 * How long a whole request (headers and body) may take to arrive. Node's
 * default is 300 s, so a client trickling a body held one of the
 * MAX_CONCURRENT_REQUESTS slots for five minutes; a 1 MB body on loopback
 * arrives in milliseconds. A late request gets 408 with `{ error }`.
 */
export const REQUEST_TIMEOUT_MS = 30_000;
/** How long the request headers may take to arrive (Node's default is 60 s). */
export const HEADERS_TIMEOUT_MS = 10_000;
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
/** Bounded so a client cycling `cwd` values cannot grow the cache without limit; the least recently used cwd goes first. */
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

/**
 * Every route as `METHOD /path`, in the order the Endpoints table of
 * docs/LOCAL-API.md lists them. The unknown-route 404 names them, as the
 * unknown export format 404 names the formats, so a client that guessed a
 * path learns the real ones from the answer.
 */
const ROUTES: readonly string[] = [
  'GET /health',
  'GET /pair',
  'POST /normalize',
  'POST /learn',
  'POST /add',
  'GET /lexicon',
  'GET /stats',
  'GET /packs',
  'POST /packs/:name',
  'DELETE /packs/:name',
  'GET /aliases',
  'GET /export/:format',
];

/**
 * What each POST route's body holds, as docs/LOCAL-API.md lists it. Every
 * body 400 (empty, not JSON, not an object, a missing, mistyped or unknown
 * field) ends with it, so a first request built by guesswork learns the
 * real field names from the answer. Without it `{}` to /normalize read only
 * `text: Invalid input: expected string, received undefined`, and a typo
 * only `Unrecognized key`.
 */
const BODY_SHAPES = {
  '/normalize': 'POST /normalize takes { text, dryRun?, minConfidence?, cwd? }',
  '/learn': 'POST /learn takes { heard, meant, scope?, cwd? }',
  '/add': 'POST /add takes { canonical, aliases?, phonetic?, category?, notes?, never?, scope?, cwd? }',
  '/packs/:name': 'POST /packs/:name takes { scope?, cwd? } or an empty body',
} as const;
type BodyRoute = keyof typeof BODY_SHAPES;

/** Seconds a 503 asks the client to wait (its `Retry-After`) before sending the same request again. */
const BUSY_RETRY_AFTER_S = 1;

/**
 * Both ways to get the bearer token, for every 401: an extension user pairs
 * (`--pair`), any other client copies it (`--show`). The `/health?cwd=` 401
 * named only `--show` after the main one learned `--pair`.
 */
const TOKEN_SOURCES = 'pair the browser extension with: lexicon serve --pair; for any other client, copy the token from: lexicon serve --show';

/**
 * The 503 before start() has read serve.json (an embedder that listens on
 * `server` itself): there is no token to check yet, so nothing is wrong with
 * the request; say when to send it again, as the busy 503 does.
 */
function serverStarting(): HttpError {
  return new HttpError(503, `server is starting; retry after ${BUSY_RETRY_AFTER_S} second (Retry-After)`, {
    'Retry-After': String(BUSY_RETRY_AFTER_S),
  });
}

/** The 401 for a request that needs the bearer token; `what` names what needed it. */
function tokenRequired(what = 'missing or invalid bearer token'): HttpError {
  return new HttpError(401, `${what} (${TOKEN_SOURCES})`);
}

/** `/packs/<name>`; the name is validated again by `loadPack` (PACK_NAME_RE). */
const PACK_ROUTE_RE = /^\/packs\/([a-z0-9-]+)$/;
/** `/export/<format>`, any case: resolveExportFormat lowercases, like `lexicon export` and the MCP tool. */
const EXPORT_ROUTE_RE = /^\/export\/([a-z-]+)$/i;

/**
 * The status for an error thrown while handling a request. 400 is for what
 * the request got wrong (`HttpError`s raised here, and core's `InputError`:
 * an empty canonical, heard equal to meant, a term the schema rejects); a
 * lock another writer still held at its timeout is 503 (retry); anything
 * else (a lexicon file that does not parse, a lock that cannot be created,
 * EACCES) is the server's state, so 500, which tells a client to report
 * rather than to change its input.
 */
export function errorStatus(err: unknown): number {
  if (err instanceof HttpError) return err.status;
  if (isProjectTrustError(err)) return 403;
  if (err instanceof Error && err.name === 'PackNotFoundError') return 404;
  if (isInputError(err)) return 400;
  // Another writer (the hook, the MCP server, a CLI command) still held the
  // file's lock when the wait ran out: the server's state, but a passing one,
  // so a retry is the fix, not a report. Every other lock failure stays 500.
  if (isHeldLockError(err)) return 503;
  return 500;
}

/**
 * The message of a 503 for a lock another writer still holds (`errorStatus`).
 * The lock error names the file and its holder, which a caller with the token
 * may see, as it may a 500's detail; an anonymous one gets the advice only.
 */
function heldLockMessage(err: unknown, authed: boolean): string {
  const retry = `retry after ${BUSY_RETRY_AFTER_S} second (Retry-After)`;
  return authed
    ? `another writer is still using the lexicon file: ${errorMessage(err)}; ${retry}`
    : `another writer is still using the lexicon file; ${retry}`;
}

/**
 * The 403 for a project-scope write into a `.lexicon.yaml` that is not
 * trusted, in HTTP terms. Core's message ends `or write to the global lexicon
 * instead`, which says nothing about how a request does that: here it is
 * `"scope": "global"` in a POST body, or `?scope=global` on a DELETE.
 */
function projectTrustRefusal(err: Error & { path?: unknown; status?: unknown }, method: string): string {
  const file = typeof err.path === 'string' ? err.path : 'this repo';
  const why = err.status === 'changed' ? 'has changed since it was trusted' : 'is untrusted';
  const global = method === 'DELETE' ? '?scope=global' : '"scope": "global" in the body';
  return `project lexicon at ${file} ${why}, so nothing was written. Review it and run \`lexicon trust\`, then retry; or retry with ${global} to use the global lexicon instead`;
}

/**
 * The 500 detail a caller without the token gets when a lexicon file does not
 * parse: what is wrong and where to read the file and line, without the path.
 * It said only `internal error (the lexicon serve log has the detail)`, so
 * the browser extension's status line, which asks plain /health, gave no hint
 * that the fix was an edit to the lexicon.
 */
export const BROKEN_LEXICON_ANONYMOUS = 'a lexicon file does not parse; run `lexicon serve --status` (or `lexicon doctor`) for the file and the line, then fix it';

/** True for store.ts's error for a lexicon file that does not parse or validate. */
function brokenLexicon(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return message.startsWith('Failed to parse lexicon YAML at ') || message.startsWith('Invalid lexicon at ');
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
 * The query string of a POST route, which takes none: its options are body
 * fields. Checked after the body is read, so the client sees the 400. A query
 * parameter used to be dropped, so `POST /packs/developer?scope=project`
 * installed into the global lexicon and answered 200, and `POST
 * /normalize?cwd=...` corrected against the server's own directory.
 */
function noQuery(url: URL, route: BodyRoute): void {
  const first = url.searchParams.keys().next();
  if (first.done) return;
  throw new HttpError(400, `unknown query parameter "${sanitizeForDisplay(first.value)}" (a POST takes its options in the JSON body, not the query string: ${BODY_SHAPES[route]})`);
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
    if (limit > EXPORT_MAX_LIMIT) throw new HttpError(400, `limit must be at most ${EXPORT_MAX_LIMIT}, got ${limit}`);
  }
  return { ...(categories.length > 0 ? { categories } : {}), ...(limit !== undefined ? { limit } : {}) };
}

/**
 * `?json=` of `GET /export/:format`: `1` or `true` answers JSON, `{ format,
 * content, rows?, dropped?, note? }`, so a client can read the names a format
 * left out (`dropped`, the sentences `lexicon export --json` gives), which
 * the ASCII `X-Lexicon-Note` header cannot carry. `0`, `false` or no
 * parameter keeps the plain export; anything else is a 400.
 */
function exportJsonFlag(url: URL): boolean {
  const raw = url.searchParams.get('json');
  if (raw === null) return false;
  const value = raw.trim().toLowerCase();
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  throw new HttpError(400, `json must be 1, true, 0 or false, got "${sanitizeForDisplay(raw)}"`);
}

/**
 * The response header that carries `GET /export/:format`'s note, so the body
 * stays exactly the export. Listed in `Access-Control-Expose-Headers` so an
 * allowed browser origin can read it.
 */
export const EXPORT_NOTE_HEADER = 'X-Lexicon-Note';

/**
 * `GET /lexicon`'s `note`: the skipped project file's `lexicon trust` step
 * (skippedProjectNote), else, for a lexicon with no terms, how to add some
 * (emptyLexiconNote), as `lexicon list --full` and MCP list_terms say it.
 * Undefined when there is nothing to say.
 */
export function lexiconNote(loaded: Pick<LoadedLexicon, 'merged' | 'projectTrust' | 'skippedProject'>): string | undefined {
  return skippedProjectNote(loaded) ?? (loaded.merged.terms.length === 0 ? emptyLexiconNote() : undefined);
}

/**
 * `GET /stats`'s `note`: the skipped project file's `lexicon trust` step,
 * else, for a lexicon with no terms, the note `lexicon stats --json` gives
 * (emptyStatsNote) and MCP lexicon_stats says in tool terms.
 */
export function statsNote(loaded: Pick<LoadedLexicon, 'merged' | 'projectTrust' | 'skippedProject'>): string | undefined {
  return skippedProjectNote(loaded, 'Its terms are not in the counts.') ?? emptyStatsNote(loaded);
}

function withNote(note: string | undefined): { note?: string } {
  return note !== undefined ? { note } : {};
}

/**
 * Why an export is empty or has no rows, and that a skipped project file's
 * terms are not in it, in the words `lexicon export` prints (emptyExportNote,
 * skippedProjectJson); MCP export_lexicon says the same in tool terms.
 * Undefined when there is nothing to say. One line of printable ASCII, so it
 * fits in a header.
 */
export function exportNote(
  loaded: Pick<LoadedLexicon, 'merged' | 'projectTrust' | 'skippedProject'>,
  format: ExportFormat,
  opts: { categories?: TermCategory[]; limit?: number },
  dropped: readonly string[] = [],
  { ascii = true }: { ascii?: boolean } = {},
): string | undefined {
  const notes: string[] = [];
  // Names stay out of a header (it is ASCII only); ?json=1 and the CLI's --json list them.
  if (dropped.length > 0) {
    notes.push(`The ${format} export left entries out to stay within its target's limits; GET /export/${format}?json=1 or lexicon export ${format} --json lists them under dropped.`);
  }
  const reason = emptyExportReason(loaded, format, opts);
  if (reason) notes.push(emptyExportNote(reason, { format, filter: `?category=${(opts.categories ?? []).join(',')}` }));
  const skipped = skippedProjectNote(loaded, 'Its terms are not in the export.');
  if (skipped && loaded.merged.terms.length > 0) notes.push(skipped);
  if (notes.length === 0) return undefined;
  const note = notes.join(' ');
  return ascii ? note.replace(/[^\x20-\x7e]/g, '?') : note;
}



function issuesMessage(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown, route: BodyRoute): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new HttpError(400, `invalid request body: ${issuesMessage(result.error)} (${BODY_SHAPES[route]})`);
  return result.data;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return false;
  // Fixed-length digests of both: a length check ahead of timingSafeEqual
  // returned early for a token of the wrong length, so timing told a caller
  // how long the real token is (32 to 128 hex characters are all valid).
  const given = createHash('sha256').update(match[1], 'utf8').digest();
  const expected = createHash('sha256').update(token, 'utf8').digest();
  return timingSafeEqual(given, expected);
}

/** True when the request carries `Expect: 100-continue`. */
function expectsContinue(req: http.IncomingMessage): boolean {
  return String(req.headers.expect ?? '').trim().toLowerCase() === '100-continue';
}

/** True when the request announces a body (`Content-Length`) over `cap`. */
function declaresOver(req: http.IncomingMessage, cap: number): boolean {
  const declared = Number(req.headers['content-length']);
  return Number.isFinite(declared) && declared > cap;
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
    if (declaresOver(req, cap)) {
      // A client waiting on `Expect: 100-continue` has not sent the body (the
      // server's checkContinue handler did not invite it): refuse it now.
      if (expectsContinue(req)) {
        settle(tooLarge());
        return;
      }
      overflow = true;
    }
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

/**
 * Parse a JSON object body for `route`, whose fields the 400s name. With
 * `optional`, an empty body reads as `{}` (routes whose fields are all optional).
 */
async function readJson(req: http.IncomingMessage, cap: number, route: BodyRoute, optional = false): Promise<unknown> {
  // A byte order mark (PowerShell 5.1 and .NET clients send one with a UTF-8
  // body) is not JSON, so JSON.parse answered "not valid JSON" to a valid body.
  const text = (await readBody(req, cap)).replace(/^\uFEFF/, '');
  const takes = BODY_SHAPES[route];
  // The body is read as UTF-8 text: a gzip or deflate body read as "not valid
  // JSON", which sent the client looking for a syntax error that was not there.
  const encoding = String(req.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding !== '' && encoding !== 'identity') {
    throw new HttpError(415, `request bodies are not decompressed (Content-Encoding: ${sanitizeForDisplay(encoding)}); send the JSON uncompressed (${takes})`);
  }
  if (text.trim() === '') {
    if (optional) return {};
    throw new HttpError(400, `request body must be a JSON object (${takes})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, `request body is not valid JSON (${takes})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, `request body must be a JSON object (${takes})`);
  }
  return parsed;
}

/**
 * A file's path with symlinks resolved when it exists, so two spellings of
 * one file compare equal. On win32 (NTFS) and darwin (APFS and HFS+ by
 * default) the filesystem ignores case, so `C:\Users\Me\.lexicon.yaml` and
 * `c:\users\me\.lexicon.yaml` are one file: the key is case-folded there
 * (and NFC-normalised on darwin, which also ignores Unicode normalisation),
 * or a write through one spelling left a load cached under the other. A
 * case-sensitive APFS volume can only over-match, which drops a cached load
 * that was still good: a reload, never a stale answer.
 */
export function canonicalFile(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
  realpath: (p: string) => string = realpathSync,
): string {
  const resolved = platform === 'win32' ? path.win32.resolve(filePath) : path.resolve(filePath);
  let real: string;
  try {
    real = realpath(resolved);
  } catch {
    real = resolved;
  }
  if (platform === 'win32') return real.toLowerCase();
  if (platform === 'darwin') return real.normalize('NFC').toLowerCase();
  return real;
}

/**
 * The request target as a URL on this server. `new URL(target, base)` reads a
 * target that starts with `//` as a network-path reference, so `//health`
 * became host `health`, path `/`. The origin is prefixed instead, so the path
 * is always the request's own; an absolute-form target (`http://host/path`)
 * keeps only its path and query, and anything else is `/`.
 */
export function requestUrl(target: string | undefined): URL {
  const base = 'http://localhost';
  const raw = target ?? '/';
  try {
    if (raw.startsWith('/')) return new URL(base + raw);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      const abs = new URL(raw);
      return new URL(base + abs.pathname + abs.search);
    }
  } catch {
    // fall through
  }
  return new URL(base + '/');
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

/**
 * What `lexicon serve --pair` and the pairing page say on a port other than
 * DEFAULT_PORT: the extension's manifest runs its pairing script on that port
 * only, so another port is paired from the extension's Options, which asks
 * the browser for access to it.
 */
export function pairPortNote(port: number): string {
  return `the extension pairs itself on port ${DEFAULT_PORT} only; for port ${port}, open its Options, set Base URL to ${serveUrl(port)} and click "pair in this browser" there, then allow access to that port`;
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
    // No URL on this page (it makes no request and names none): the address bar has it.
    ...(input.port === DEFAULT_PORT
      ? []
      : [
          `<p id="other-port">Installed already? The extension pairs itself on port ${DEFAULT_PORT} only. For port ${port}, open its Options, set Base URL to this page's address without <code>/pair</code> and click <strong>pair in this browser</strong> there, then allow access to that port.</p>`,
        ]),
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
  const requestTimeout = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  // Node refuses a headers timeout over the request timeout.
  const headersTimeout = Math.min(opts.headersTimeoutMs ?? HEADERS_TIMEOUT_MS, requestTimeout);

  let config: ServeConfig | undefined;
  let boundPort = 0;
  let inFlight = 0;
  const cache = new Map<string, CachedLexicon>();
  /**
   * Bumped by every write invalidation (and by stop). A load that started before a write and
   * finished after the write's invalidation read the old file; it is
   * returned to its own request but not cached, or it would put the old
   * lexicon back for up to `reloadMs`.
   */
  let generation = 0;

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
    if (hit && now - hit.at < reloadMs) {
      // A Map iterates in insertion order: moving a hit to the end makes the
      // first key the least recently used one, which is what eviction drops.
      cache.delete(cwd);
      cache.set(cwd, hit);
      return hit;
    }
    // No route reads a skipped project file's terms (each names it by path
    // only), so an untrusted or changed one is never parsed, as in the hook.
    const startedAt = generation;
    const loaded = await loadLexicon({ cwd, ...storeOpts, parseSkipped: false });
    const entry: CachedLexicon = { loaded, at: now };
    if (generation !== startedAt) return entry;
    cache.delete(cwd);
    if (cache.size >= MAX_CACHED_CWDS) {
      const leastRecent = cache.keys().next().value;
      if (leastRecent !== undefined) cache.delete(leastRecent);
    }
    cache.set(cwd, entry);
    return entry;
  }

  async function load(cwd: string): Promise<LoadedLexicon> {
    return (await loadEntry(cwd)).loaded;
  }

  /**
   * After a write to `written` (learn, add, pack install, pack uninstall). A
   * global write can change every cwd's load, so it drops them all. A
   * project-scope write drops only the cached loads that used that project
   * file (merged or skipped), plus any load that had no project file while
   * its cwd now resolves to the written one (the write created it). Every
   * other cwd reads another `.lexicon.yaml` and the unchanged global file, so
   * its load and matcher index are still exact.
   */
  function invalidateWritten(written: readonly { scope: TermScope; path: string }[]): void {
    generation += 1;
    if (written.some((f) => f.scope === 'global')) {
      cache.clear();
      return;
    }
    const targets = new Set(written.map((f) => canonicalFile(f.path)));
    if (targets.size === 0) return;
    for (const [cwd, entry] of cache) {
      const used = entry.loaded.project?.path ?? entry.loaded.skippedProject?.path ?? resolvePaths({ cwd, ...storeOpts }).project;
      if (used !== undefined && targets.has(canonicalFile(used))) cache.delete(cwd);
    }
  }

  /** The scope of each file `uninstallPack` rewrote: the global file by path, any other one a project file. */
  function scopedFiles(cwd: string, files: readonly string[]): { scope: TermScope; path: string }[] {
    const global = canonicalFile(resolvePaths({ cwd, ...storeOpts }).global);
    return files.map((f) => ({ scope: canonicalFile(f) === global ? 'global' : 'project', path: f }));
  }

  /**
   * After `recordHits(canonicals)`: drops only the cached loads holding one of
   * those terms. A hit count is all that call writes, and only those terms'
   * `hits` can have moved, so every other cwd's load (and its matcher index)
   * is still exact. Clearing the whole cache here made one normalize reload every cwd.
   */
  function invalidateHits(canonicals: readonly string[]): void {
    // No generation bump: a load in flight here can miss only these hit
    // counts (for at most reloadMs), and bumping on every counted normalize
    // would keep busy cwds from ever being cached.
    const keys = new Set(canonicals.map((c) => c.trim().toLowerCase()));
    for (const [key, entry] of cache) {
      if (entry.loaded.merged.terms.some((t) => keys.has(t.canonical.trim().toLowerCase()))) cache.delete(key);
    }
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
    const body = parseBody(NormalizeBody, raw, '/normalize');
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
      // `loaded` spares recordHits re-reading (and re-parsing) both files.
      await recordHits(canonicals, { cwd, ...storeOpts, loaded: entry.loaded }).catch(() => undefined);
      invalidateHits(canonicals);
    }
    return {
      ...result,
      summary: result.replacements.length > 0 ? diffSummary(result) : '',
      // Without it a body cut short by the budget reads as fully corrected.
      ...(timedOut ? { incomplete: timeBudgetIncomplete(body.text.length, normalizeBudgetMs) } : {}),
      // The same additive keys as /stats and MCP normalize_transcript.
      ...(entry.loaded.projectTrust !== undefined ? { projectTrust: entry.loaded.projectTrust } : {}),
      ...(entry.loaded.skippedProject !== undefined ? { skippedProject: entry.loaded.skippedProject.path } : {}),
      // An empty lexicon corrects nothing, which read like text that needed no correction.
      ...(entry.loaded.merged.terms.length === 0 ? { hint: emptyNormalizeHint(entry.loaded) } : {}),
    };
  }

  async function handleLearn(raw: unknown): Promise<LearnResponse> {
    const body = parseBody(LearnBody, raw, '/learn');
    const cwd = await resolveCwd(body.cwd);
    const result = await learnCorrection(
      { heard: body.heard, meant: body.meant },
      { cwd, ...storeOpts, ...(body.scope !== undefined ? { scope: body.scope } : {}) },
    );
    invalidateWritten([result.file]);
    const unchanged = !result.created && !result.aliasAdded;
    const notes = [
      ...(unchanged ? [learnUnchangedNote(body.heard, result.term.canonical, { meant: body.meant, scope: result.file.scope })] : []),
      ...(result.conflict ? [conflictNote([result.conflict])] : []),
    ];
    return {
      term: result.term,
      created: result.created,
      aliasAdded: result.aliasAdded,
      path: result.file.path,
      // Nothing was written (heard was already an alias, or the canonical in
      // another case): say so, as POST /add and MCP learn_correction do,
      // instead of two false flags that read like a failure or a merge.
      ...(unchanged ? { unchanged: true as const } : {}),
      ...(result.reversed ? { reversed: true as const } : {}),
      ...(unchanged || result.conflict ? { note: notes.join(' ') } : {}),
      ...(result.conflict ? { conflict: result.conflict } : {}),
      ...(result.untrustedProject ? { untrustedProject: result.untrustedProject } : {}),
    };
  }

  async function handleAdd(raw: unknown): Promise<AddResponse> {
    const body = parseBody(AddBody, raw, '/add');
    const cwd = await resolveCwd(body.cwd);
    // Generated aliases only when this creates the term (see addTerm's
    // defaultAliases), and only for an omitted field: an explicit [] means
    // none, as in MCP add_term. No caller sends [] to ask for suggestions
    // (the menu bar app omits an empty list; the Windows app and the
    // extension send no aliases at all).
    const given = body.aliases !== undefined;
    const aliases = body.aliases ?? [];
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
    invalidateWritten([saved.file]);
    // An alias another term already holds may keep being corrected to that
    // term: report it, as MCP add_term and `lexicon add --json` do, instead
    // of a bare success. Best effort: a reload that fails loses the report.
    const conflicts = await load(cwd).then(
      (loaded) => spellingConflicts(loaded.merged, saved.term.aliases, saved.term.canonical),
      () => [],
    );
    return {
      term: saved.term,
      path: saved.file.path,
      created: saved.created,
      // The term already had every alias and field given, so nothing was
      // written: say so, as `lexicon add --json` and MCP add_term do, instead
      // of a 200 that reads like a merge.
      ...(saved.unchanged ? { unchanged: true as const, note: unchangedTermNote(saved.term.canonical) } : {}),
      ...(conflicts.length > 0 ? { conflicts } : {}),
    };
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
      ...withNote(lexiconNote(loaded)),
    };
  }

  async function handleStats(cwd: string): Promise<StatsResponse> {
    const loaded = await load(cwd);
    return {
      ...computeStats(loaded),
      ...(loaded.projectTrust !== undefined ? { projectTrust: loaded.projectTrust } : {}),
      ...(loaded.skippedProject !== undefined ? { skippedProject: loaded.skippedProject.path } : {}),
      ...withNote(statsNote(loaded)),
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

  async function handleInstallPack(name: string, raw: unknown): Promise<InstallPackResponse> {
    const body = parseBody(PackBody, raw, '/packs/:name');
    const cwd = await resolveCwd(body.cwd);
    const result = await installPack(name, { cwd, ...storeOpts, ...(body.scope !== undefined ? { scope: body.scope } : {}) });
    invalidateWritten([result]);
    // A reinstall that changed nothing says so, with the pack's counts, in the
    // words `lexicon pack add` and MCP add_pack use, not "0 added, N merged".
    const alreadyInstalled = result.alreadyInstalled === true;
    return {
      ...result,
      alreadyInstalled,
      summary: alreadyInstalled
        ? packAlreadyInstalledNote(result.pack.name, result)
        : `installed ${result.pack.name}: ${result.added} added, ${result.merged} merged into ${result.path}`,
    };
  }

  async function handleUninstallPack(name: string, url: URL): Promise<UninstallPackResponse> {
    // The query string is this route's body, so it is strict too: a typo such
    // as `?scop=project` was ignored and the pack came out of the default
    // (global) lexicon instead, still 200.
    strictQuery(url, 'DELETE /packs/:name', ['scope', 'cwd']);
    const cwd = await resolveCwd(url.searchParams.get('cwd'));
    const scopeParam = url.searchParams.get('scope');
    const scope = TERM_SCOPES.find((s) => s === scopeParam);
    if (scopeParam !== null && scope === undefined) throw new HttpError(400, `invalid scope "${sanitizeForDisplay(scopeParam)}" (global or project)`);
    const result = await uninstallPack(name, { cwd, ...storeOpts, ...(scope !== undefined ? { scope } : {}) });
    invalidateWritten(scopedFiles(cwd, result.files));
    // No file listed the pack, so nothing was written: say so, as `lexicon
    // pack remove` does, instead of a 200 with three empty arrays.
    if (result.files.length === 0) {
      return { ...result, notInstalled: true, summary: `${result.pack.name} is not installed${scope !== undefined ? ` in the ${scope} lexicon` : ''}; nothing was removed` };
    }
    const kept = result.kept.length > 0 ? `; kept ${result.kept.length} you edited (hits, extra aliases or never-words): ${result.kept.join(', ')}` : '';
    const shared = result.shared.length > 0 ? `; kept ${result.shared.length} another installed pack also has: ${result.shared.join(', ')}` : '';
    return {
      ...result,
      summary: `removed ${result.removed.length} term${result.removed.length === 1 ? '' : 's'} of ${result.pack.name} from ${result.files.join(', ')}${kept}${shared}`,
    };
  }

  /** GET /aliases?canonical=X: the spellings STT is likely to produce, for an onboarding form. */
  function handleAliases(url: URL): AliasesResponse {
    strictQuery(url, 'GET /aliases', ['canonical']);
    // Cleaned as the schema cleans a canonical (stripInvisible, then trim), so
    // a zero-width character neither counts toward the cap nor reaches the aliases.
    const canonical = stripInvisible(url.searchParams.get('canonical') ?? '').trim();
    if (!canonical) throw new HttpError(400, 'canonical query parameter is required (e.g. GET /aliases?canonical=Ashlr.AI)');
    if (canonical.length > LIMITS.word) throw new HttpError(400, `canonical must be at most ${LIMITS.word} characters`);
    // The schema's NonEmptyWord refuses these too, so no stored canonical
    // could carry them; the aliases they would seed would never be accepted.
    if (hasControlChars(canonical)) throw new HttpError(400, 'canonical must not contain control characters or newlines');
    const unencodable = findUnencodableChar(canonical);
    if (unencodable) throw new HttpError(400, `canonical must not contain ${unencodable} (${UNENCODABLE_NOTE})`);
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
    if (!config) throw serverStarting();
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
      if (cwdParam !== null && !config) throw serverStarting();
      if (cwdParam !== null && config && !tokenMatches(req.headers.authorization, config.token)) {
        throw tokenRequired('/health?cwd= needs the bearer token, which plain /health does not');
      }
      return json(200, await health(await resolveCwd(cwdParam)));
    }
    if (pathname === PAIR_PATH) {
      if (method !== 'GET') throw notGet();
      return pairPage(req);
    }

    // Before start() has read serve.json no token could match, so the right
    // token was answered 401 "invalid" too. That is the starting 503; a wrong
    // token once the config is loaded stays the 401.
    if (!config) throw serverStarting();
    if (!tokenMatches(req.headers.authorization, config.token)) {
      throw tokenRequired();
    }

    if (pathname === '/normalize') {
      if (method !== 'POST') throw wrongMethod(['POST']);
      const raw = await readJson(req, MAX_BODY_BYTES, '/normalize');
      noQuery(url, '/normalize');
      return json(200, await handleNormalize(raw));
    }
    if (pathname === '/learn') {
      if (method !== 'POST') throw wrongMethod(['POST']);
      const raw = await readJson(req, MAX_BODY_BYTES, '/learn');
      noQuery(url, '/learn');
      return json(200, await handleLearn(raw));
    }
    if (pathname === '/add') {
      if (method !== 'POST') throw wrongMethod(['POST']);
      const raw = await readJson(req, MAX_BODY_BYTES, '/add');
      noQuery(url, '/add');
      return json(200, await handleAdd(raw));
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
      if (method === 'POST') {
        const raw = await readJson(req, MAX_BODY_BYTES, '/packs/:name', true);
        noQuery(url, '/packs/:name');
        return json(200, await handleInstallPack(packMatch[1], raw));
      }
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
      // The formats to choose from, as MCP export_lexicon and `lexicon export` give them.
      if (format === undefined) throw new HttpError(404, `unknown export format "${sanitizeForDisplay(exportMatch[1])}" (one of: ${EXPORT_FORMATS.join(', ')})`);
      strictQuery(url, 'GET /export/:format', ['cwd', 'category', 'limit', 'json'], ['category']);
      const exportOpts = exportQueryOptions(url);
      const asJson = exportJsonFlag(url);
      const loaded = await load(await resolveCwd(url.searchParams.get('cwd')));
      // An empty export answered 200 with no word of why; the reason rides in
      // a header so the body stays exactly the export.
      const exported = exportLexiconWithNotes(loaded.merged, format, exportOpts);
      if (asJson) {
        // The header is ASCII and cannot name what a format left out; this
        // body can, as `lexicon export --json` does.
        const note = exportNote(loaded, format, exportOpts, [], { ascii: false });
        return json(200, {
          format,
          content: exported.text,
          ...(exported.rows !== undefined ? { rows: exported.rows } : {}),
          ...(exported.notes.length > 0 ? { dropped: exported.notes } : {}),
          ...(note !== undefined ? { note } : {}),
        });
      }
      const note = exportNote(loaded, format, exportOpts, exported.notes);
      return {
        status: 200,
        text: exported.text,
        contentType: exportContentType(format),
        ...(note !== undefined ? { headers: { [EXPORT_NOTE_HEADER]: note } } : {}),
      };
    }
    throw new HttpError(404, `no route for ${req.method ?? 'GET'} ${sanitizeForDisplay(pathname)} (routes: ${ROUTES.join(', ')})`);
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

  const serverOptions: http.ServerOptions = {
    requestTimeout,
    headersTimeout,
    // Node checks the timeouts on this cadence (default 30 s, a tenth of its
    // default request timeout); keep the same proportion for ours.
    connectionsCheckingInterval: Math.max(25, Math.min(1_000, Math.floor(headersTimeout / 4))),
  };
  const server = http.createServer(serverOptions, (req, res) => {
    const started = Date.now();
    const method = req.method ?? 'GET';
    const head = method === 'HEAD';
    const url = requestUrl(req.url);
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
      cors['Access-Control-Expose-Headers'] = EXPORT_NOTE_HEADER;
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
      // Private Network Access: Chrome asks before a public page reaches a
      // loopback server. Granted only with the CORS headers above, so only to
      // an allowed origin and never on /pair.
      if (cors['Access-Control-Allow-Origin'] !== undefined && /^true$/i.test(String(req.headers['access-control-request-private-network'] ?? '').trim())) {
        cors['Access-Control-Allow-Private-Network'] = 'true';
      }
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (inFlight >= maxConcurrent) {
      // Says what to do next, not only what went wrong: the request was not
      // run, so the same request is safe to send again after Retry-After.
      send(
        res,
        json(503, { error: `too many concurrent requests (${inFlight} already in flight), so this one was not run; retry it after ${BUSY_RETRY_AFTER_S} second (Retry-After)` }),
        { ...cors, 'Retry-After': String(BUSY_RETRY_AFTER_S) },
        head,
      );
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
        let message = isProjectTrustError(err) ? projectTrustRefusal(err as Error, method) : errorMessage(err);
        if (status === 500) {
          message = authed
            ? `internal error: ${message}`
            : brokenLexicon(err)
              ? `internal error: ${BROKEN_LEXICON_ANONYMOUS}`
              : 'internal error (the lexicon serve log has the detail)';
        }
        const heldLock = isHeldLockError(err);
        if (heldLock) message = heldLockMessage(err, authed);
        if (status === 500 || heldLock) log(`[serve] ${method} ${sanitizeForDisplay(url.pathname)} failed: ${errorMessage(err)}`);
        const extra: Record<string, string> = { ...cors, ...(err instanceof HttpError ? err.headers : {}) };
        if (heldLock) extra['Retry-After'] = String(BUSY_RETRY_AFTER_S);
        if (status === 413) extra['Connection'] = 'close';
        if (status === 401) extra['WWW-Authenticate'] = 'Bearer';
        send(res, json(status, { error: message }), extra, head);
      });
  });

  // Node answers `Expect: 100-continue` with 100 Continue on its own, so a
  // client announcing a 20 MB body uploaded it, and past readBody's drain
  // limit the connection was cut: a reset instead of the 413. A body over
  // the limit is not invited; readBody answers 413 before it is sent.
  server.on('checkContinue', (req, res) => {
    if (!declaresOver(req, MAX_BODY_BYTES)) res.writeContinue();
    server.emit('request', req, res);
  });

  // A request the HTTP parser cannot read never reaches the handler, and
  // Node's own answer is a bare status line with no body, where every other
  // error of this API is `{ error }`. Same statuses as Node's: 431 for
  // headers over the limit, 408 for a request that took too long, else 400.
  server.on('clientError', (err: NodeJS.ErrnoException, socket: net.Socket) => {
    // A response already under way (a request timeout can fire while a
    // handler answers early) must not get a second status line written into it.
    const pending = (socket as net.Socket & { _httpMessage?: http.ServerResponse | null })._httpMessage;
    if (err.code === 'ECONNRESET' || !socket.writable || pending?.headersSent === true) {
      socket.destroy();
      return;
    }
    const [status, reason, what] =
      err.code === 'HPE_HEADER_OVERFLOW'
        ? [431, 'Request Header Fields Too Large', 'request headers are too large']
        : err.code === 'ERR_HTTP_REQUEST_TIMEOUT'
          ? [408, 'Request Timeout', 'the request did not arrive in time']
          : [400, 'Bad Request', 'malformed HTTP request'];
    const body = JSON.stringify({ error: `${what} (${err.code ?? 'parse error'}); nothing was run` });
    if (!opts.quiet) log(`[serve] ${status} ${what} (${err.code ?? 'parse error'})`);
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body, 'utf8')}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`,
    );
  });

  // Close idle keep-alive sockets quickly on stop(); the default 5 s is fine while running.
  server.keepAliveTimeout = 5_000;

  let running = false;

  async function start(): Promise<ServeStartInfo> {
    if (running) throw new Error('server already started');
    // A replaced token is logged even when quiet: paired clients now get 401.
    config = await ensureServeConfig(storeOpts, { onTokenReplaced: (message) => log(`[serve] warning: ${sanitizeForDisplayMax(message, Number.POSITIVE_INFINITY)}`) });
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
    // Only the port changes: serve.json is re-read under its lock, so an edit
    // made while the server was binding (allowedOrigins, a new token) is kept.
    if (config.port !== boundPort) {
      config = await recordServePort(boundPort, config, storeOpts);
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
    generation += 1;
    cache.clear();
  }

  return { server, start, stop };
}
