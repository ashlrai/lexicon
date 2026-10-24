/**
 * `serve.json`: the local HTTP API's port and bearer token, stored next to the
 * global lexicon (`<dirname(global)>/serve.json`) with mode 0600. Created on
 * the first `lexicon serve`, reused afterwards so clients (browser extension,
 * Shortcuts, Raycast, the menu bar app) can find the server and its token.
 *
 * Optional `allowedOrigins` lets the user whitelist extra CORS origins; the
 * three browser-extension schemes are always allowed. `*` is never honoured.
 */
import { randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolvePaths } from '../core/index.js';
import { redactSecrets } from '../core/redact.js';
import type { StoreOptions } from '../core/index.js';
import { withFileLock, writeFileAtomic } from '../util/atomic.js';
import { formatJson } from '../util/json.js';
import { errorMessage } from '../util/errors.js';

/** serve.json holds the API token, so it is owner-only. */
const SERVE_FILE_MODE = 0o600;

export const SERVE_FILE_NAME = 'serve.json';
/** Fixed default so clients can find the server without discovery. */
export const DEFAULT_PORT = 41733;
export const DEFAULT_HOST = '127.0.0.1';
/** Origin schemes that always receive CORS headers (browser extensions only). */
export const EXTENSION_ORIGIN_PREFIXES: readonly string[] = [
  'chrome-extension://',
  'moz-extension://',
  'safari-web-extension://',
];

export interface ServeConfig {
  /** Port the server last listened on (informational; `lexicon serve` without `--port` binds DEFAULT_PORT). */
  port: number;
  /** 32 to 128 hex characters (either case; `generateToken` writes lower case), sent as `Authorization: Bearer <token>`, compared exactly. */
  token: string;
  /** ISO timestamp of token creation. */
  createdAt: string;
  /** Extra exact-match origins that receive CORS headers. Optional, user-edited. */
  allowedOrigins?: string[];
}

/**
 * Either case of hex: a hand-edited token in upper case was "no usable token"
 * and replaced, breaking every client given it. The bearer check stays exact
 * and constant-time (`tokenMatches` in server.ts compares the bytes), so
 * `ABCD...` and `abcd...` are different tokens; the case only stops counting
 * as malformed.
 */
const TOKEN_RE = /^[0-9a-fA-F]{32,128}$/;

/** `<dirname(global lexicon)>/serve.json`; follows LEXICON_PATH and XDG_CONFIG_HOME. */
export function getServePath(opts: StoreOptions = {}): string {
  return path.join(path.dirname(resolvePaths(opts).global), SERVE_FILE_NAME);
}

function parseServeConfig(raw: unknown): ServeConfig | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { port, token, createdAt, allowedOrigins } = raw as Record<string, unknown>;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
  const config: ServeConfig = {
    port: typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT,
    token,
    createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
  };
  if (Array.isArray(allowedOrigins)) {
    const origins = allowedOrigins.filter((o): o is string => typeof o === 'string' && o !== '*' && o.length > 0);
    if (origins.length > 0) config.allowedOrigins = origins;
  }
  return config;
}

/**
 * serve.json's JSON, a leading byte order mark allowed: Windows Notepad (and
 * PowerShell's `Out-File -Encoding utf8`) save one, and JSON.parse refuses it.
 */
function parseServeJson(text: string): unknown {
  return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
}

/**
 * Why `readServeConfig` found no usable config at `file`, for the
 * "serve is not configured: <file> <why>" lines of `--status` and `--pair`.
 */
export function unusableServeConfigReason(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // Only a missing file is one lexicon serve creates: a serve.json that is
    // a directory or unreadable (EISDIR, EACCES) was reported as missing too,
    // and lexicon serve then failed on it instead of creating anything.
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT') return 'does not exist; lexicon serve creates it';
    return `could not be read (${typeof code === 'string' ? code : errorMessage(err)}); make it a readable file, or remove it so lexicon serve makes a new token`;
  }
  if (text.replace(/^\uFEFF/, '').trim() === '') return 'is empty; lexicon serve replaces it';
  try {
    parseServeJson(text);
  } catch {
    return 'is not valid JSON; fix it, or delete it and lexicon serve makes a new token';
  }
  return 'has no usable token; lexicon serve replaces it';
}

/** The stored config, or undefined when the file is missing or unusable (a bad token is never reused). */
export async function readServeConfig(opts: StoreOptions = {}): Promise<ServeConfig | undefined> {
  let text: string;
  try {
    text = await fs.readFile(getServePath(opts), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseServeConfig(parseServeJson(text));
  } catch {
    return undefined;
  }
}

/**
 * Run `fn` with exclusive access to `serve.json`, across processes.
 *
 * Re-entrant, and taken inside a lexicon file's lock rather than around one.
 * See the lock ordering note in `util/atomic.ts`.
 */
export function withServeConfigLock<T>(fn: () => Promise<T>, opts: StoreOptions = {}): Promise<T> {
  return withFileLock(getServePath(opts), fn);
}

/** Writes the token, so 0600. Returns the path written. */
export async function writeServeConfig(config: ServeConfig, opts: StoreOptions = {}): Promise<string> {
  const target = getServePath(opts);
  await withServeConfigLock(() => writeFileAtomic(target, formatJson(config), { mode: SERVE_FILE_MODE }), opts);
  return target;
}

/**
 * Put an existing serve.json back to 0600 when group or other can read it.
 *
 * The file is created 0600, but one that already exists is reused as found:
 * restored from a backup, synced from another machine, copied with `cp`, or
 * written by hand following the docs, it came back 0644, and the server (and
 * `--show`, `--install`) went on serving a token any local account could read.
 * Rewriting it only happened when the port changed. Not on Windows, where the
 * mode bits do not describe access.
 */
async function keepOwnerOnly(file: string): Promise<void> {
  if (process.platform === 'win32') return;
  let mode: number;
  try {
    mode = (await fs.stat(file)).mode & 0o777;
  } catch {
    return;
  }
  if ((mode & 0o077) === 0) return;
  try {
    await fs.chmod(file, SERVE_FILE_MODE);
  } catch (err) {
    throw new Error(
      `${file} holds the local API token and is readable by other users (mode ${mode.toString(8)}), and it could not be made private: ${err instanceof Error ? err.message : String(err)}; run: chmod 600 ${file}`,
    );
  }
}

export function generateToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Read the config, creating it with a fresh token on first run.
 *
 * Read and create are one locked step. Unlocked, two first runs each saw no
 * file, each minted a token, and the loser's client was left holding a token
 * the server would answer 401 to; the same race also renamed two writers'
 * temp files over each other, which is how `trust.json` crashed with ENOENT.
 */
export interface EnsureServeConfigHooks {
  /**
   * Called (inside the lock, after the new file is written) when an existing,
   * non-empty serve.json had no usable token and a new one replaced it, with
   * one sentence naming the file, why its token was unusable and how paired
   * clients get the new one. Without it the replacement was silent and every
   * paired client was answered 401 with no word of why.
   */
  onTokenReplaced?: (message: string) => void;
}

/** Why `raw` (serve.json parsed) has no token `parseServeConfig` accepts. */
function tokenProblem(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'it is not a JSON object';
  const token = (raw as Record<string, unknown>).token;
  if (token === undefined) return 'it has no "token" key';
  if (typeof token !== 'string') return '"token" is not a string';
  return `"token" is not 32 to 128 hex characters (0-9, a-f, A-F)`;
}

export async function ensureServeConfig(opts: StoreOptions = {}, hooks: EnsureServeConfigHooks = {}): Promise<ServeConfig> {
  return withServeConfigLock(async () => {
    const file = getServePath(opts);
    let raw: unknown;
    let text: string | undefined;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'ENOENT') throw err;
    }
    if (text !== undefined && text.replace(/^\uFEFF/, '').trim() !== '') {
      // A file that does not parse was rewritten with a fresh token, which
      // dropped a hand-added allowedOrigins and left every paired client
      // holding a token the server answers 401 to. It is refused instead.
      try {
        raw = parseServeJson(text);
      } catch (err) {
        throw new Error(
          `${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it, or delete it to have lexicon serve make a new token (paired clients then need the new one: lexicon serve --pair or --show)`,
        );
      }
      const existing = parseServeConfig(raw);
      if (existing) {
        await keepOwnerOnly(file);
        return existing;
      }
    }
    // Missing, or no usable token: a new token, keeping the origins the user listed.
    const origins = parseServeConfig({ ...(typeof raw === 'object' && raw !== null ? raw : {}), token: '0'.repeat(32) })?.allowedOrigins;
    const config: ServeConfig = {
      port: DEFAULT_PORT,
      token: generateToken(),
      createdAt: new Date().toISOString(),
      ...(origins ? { allowedOrigins: origins } : {}),
    };
    await writeServeConfig(config, opts);
    if (raw !== undefined) {
      hooks.onTokenReplaced?.(
        `${file} had no usable token (${tokenProblem(raw)}), so a new token was written there; ` +
          'clients paired with the old one are refused until they get it: lexicon serve --pair (browser extension) or lexicon serve --show (copy it)',
      );
    }
    return config;
  }, opts);
}

/** True when `origin` may receive CORS headers: an extension origin or a listed exact match. Never `*`. */
export function isOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[] = []): boolean {
  if (!origin) return false;
  if (EXTENSION_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix))) return true;
  return allowedOrigins.some((allowed) => allowed !== '*' && allowed === origin);
}

/** `http://127.0.0.1:41733`. IPv6 hosts are bracketed. */
export function serveUrl(port: number, host: string = DEFAULT_HOST): string {
  const h = host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/**
 * True when binding `host` keeps the API on this machine: `localhost`, an
 * IPv4 address in 127.0.0.0/8, or IPv6 loopback in any spelling (`::1`,
 * `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`, bracketed or not). A hostname that
 * only starts with `127.` (`127.example.com`) is a name that can resolve
 * anywhere, so it is not; it counted as loopback and the network-exposure
 * warning was skipped for it.
 */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost') return true;
  if (isIPv4(h)) return h.startsWith('127.');
  if (!isIPv6(h)) return false;
  // The URL parser writes an IPv6 address in its one compressed form.
  const canonical = new URL(`http://[${h}]`).hostname;
  return canonical === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical);
}

/** What `probeHealth` saw at `<url>/health`. */
export type HealthProbe =
  /** 2xx: the parsed body (`HealthResponse`). */
  | { state: 'up'; body: unknown }
  /** The server answered, but with an error status: it is running and cannot serve (a broken lexicon file, say). */
  | { state: 'failing'; status: number; error: string }
  /** Nothing answered (refused, timed out). */
  | { state: 'down'; error: string };

/**
 * True when a 2xx /health body has lexicon serve's shape (server.ts
 * HealthResponse): `ok` true, a non-empty `version` string and a
 * whole-number `terms`, the shape the browser extension checks
 * (extension/src/background-core.ts isLexiconHealth, which also takes a
 * boolean `ok` and leaves the value to its own code). Any `{ ok: true }`
 * used to count, so another program on the port that answered that was
 * reported as lexicon serve by `lexicon serve --status` and MCP `serve_status`.
 */
export function isLexiconHealth(body: unknown): body is { ok: true; version: string; terms: number } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as { ok?: unknown; version?: unknown; terms?: unknown };
  return b.ok === true && typeof b.version === 'string' && b.version.length > 0 && Number.isInteger(b.terms) && (b.terms as number) >= 0;
}

/** The next step for each way /health can fail, shared by `lexicon serve --status --json` and MCP `serve_status`. */
export const SERVE_STATUS_HINTS = {
  failing:
    'The server is running but cannot serve the lexicon; fix what `error` names (often a lexicon file that does not parse) and check again. Starting another server will not help.',
  down: 'Start it with `lexicon serve`, or `lexicon serve --install` to keep it running at login.',
  foreign:
    'Something other than lexicon serve answers on this port. Stop that program, or run the local API on another port: lexicon serve --port <n>.',
} as const;

/** The `error` for a 2xx /health whose body is not lexicon serve's. */
export const FOREIGN_HEALTH_ERROR = "something else answers on that port: its /health response is not lexicon serve's";

/**
 * GET `<baseUrl>/health`, sending the bearer `token` when there is one so a
 * failing server returns its full error (see `errorStatus` in server.ts)
 * rather than a pointer to its log. `lexicon serve --status` and the MCP
 * `serve_status` tool share it, so neither calls a running server "down".
 */
export async function probeHealth(
  baseUrl: string,
  opts: { token?: string; timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<HealthProbe> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1_500),
      ...(opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : {}),
    });
  } catch (err) {
    return { state: 'down', error: redactSecrets(err instanceof Error ? err.message : String(err), [opts.token, baseUrl]) };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.ok) return { state: 'up', body };
  const given = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  // A server that is not lexicon serve may quote the request's token back.
  return { state: 'failing', status: res.status, error: typeof given === 'string' ? redactSecrets(given, [opts.token]) : `HTTP ${res.status}` };
}
