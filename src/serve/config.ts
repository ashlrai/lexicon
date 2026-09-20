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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePaths } from '../core/index.js';
import type { StoreOptions } from '../core/index.js';
import { writeFileAtomic } from '../util/atomic.js';
import { formatJson } from '../util/json.js';

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
  /** 32 hex characters, sent as `Authorization: Bearer <token>`. */
  token: string;
  /** ISO timestamp of token creation. */
  createdAt: string;
  /** Extra exact-match origins that receive CORS headers. Optional, user-edited. */
  allowedOrigins?: string[];
}

const TOKEN_RE = /^[0-9a-f]{32,128}$/;

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

/** The stored config, or undefined when the file is missing or unusable (a bad token is never reused). */
export async function readServeConfig(opts: StoreOptions = {}): Promise<ServeConfig | undefined> {
  let text: string;
  try {
    text = await fs.readFile(getServePath(opts), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseServeConfig(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Writes the token, so 0600. Returns the path written. */
export async function writeServeConfig(config: ServeConfig, opts: StoreOptions = {}): Promise<string> {
  const target = getServePath(opts);
  await writeFileAtomic(target, formatJson(config), { mode: SERVE_FILE_MODE });
  return target;
}

export function generateToken(): string {
  return randomBytes(16).toString('hex');
}

/** Read the config, creating it with a fresh token on first run. */
export async function ensureServeConfig(opts: StoreOptions = {}): Promise<ServeConfig> {
  const existing = await readServeConfig(opts);
  if (existing) return existing;
  const config: ServeConfig = { port: DEFAULT_PORT, token: generateToken(), createdAt: new Date().toISOString() };
  await writeServeConfig(config, opts);
  return config;
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

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || h.startsWith('127.');
}
