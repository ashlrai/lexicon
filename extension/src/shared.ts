/// <reference lib="dom" />
/**
 * Types and constants shared by the background worker, content script, popup
 * and options page. No chrome.* access here: everything that touches the
 * extension API takes it as a dependency so the jsdom tests can stub it.
 *
 * The DOM lib reference above is deliberate: tests/extension.test.ts pulls
 * these modules into the root tsconfig, whose lib is ES2022 only.
 */
import type { MatchReason, NormalizeIncomplete } from '../../src/core/types.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:41733';
/** The port `lexicon serve` binds by default; the manifest grants it and runs `pair.js` on it. */
export const DEFAULT_PORT = '41733';
/** Path of the server's pairing page; `lexicon serve --pair` opens it, `pair.ts` runs on it. */
export const PAIR_PATH = '/pair';
/** `<meta name>` attributes on the pairing page (mirrors PAIR_META in src/serve/server.ts). */
export const PAIR_META = { token: 'lexicon-token', port: 'lexicon-port', version: 'lexicon-version' } as const;
/** Hosts the pairing page may be served from; the background refuses to pair with anything else. */
export const PAIR_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];
/** Token shape written by `lexicon serve` (32..128 hex chars). */
export const TOKEN_RE = /^[0-9a-f]{32,128}$/;

/** Which engine corrects text. `api` falls back to `embedded` when /health fails. */
export type Mode = 'api' | 'embedded';

export interface Settings {
  baseUrl: string;
  /** Bearer token, set by pairing (`lexicon serve --pair`) or pasted from `lexicon serve --show`. Never sent to a content script. */
  token: string;
  mode: Mode;
  /** Normalize on an idle debounce while typing (text before the caret only). */
  live: boolean;
  /** Embedded lexicon, YAML. Used when mode is `embedded` or the API is down. */
  yaml: string;
  /** Per-host enable switch; absent means enabled. */
  sites: Record<string, boolean>;
  /** "Any site" opt-in (needs the optional <all_urls> host permission). */
  anySite: boolean;
}

export const STORAGE_KEYS = {
  settings: 'settings',
  recent: 'recent',
  /** Hosts the guard ran on through "Any site", newest first (see `rememberAnySiteHost`), so Options can list them. */
  anySiteHosts: 'anySiteHosts',
  /** The `navigator.userAgent` of the browser that last refused `matchOriginAsFallback` (see any-site.ts), so a reconcile there leaves the registration alone. */
  anySiteNoFallback: 'anySiteNoFallback',
} as const;

export const RECENT_LIMIT = 5;
/** Most hosts kept under STORAGE_KEYS.anySiteHosts. */
export const ANY_SITE_HOSTS_LIMIT = 100;

/** A stored host list as it can be trusted: strings that look like a host (`hostKey` form), no repeats, at most ANY_SITE_HOSTS_LIMIT. */
export function coerceHostList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || !/^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(v) || out.includes(v)) continue;
    out.push(v);
    if (out.length >= ANY_SITE_HOSTS_LIMIT) break;
  }
  return out;
}
export const LIVE_DEBOUNCE_MS = 400;
export const PRECHECK_DEBOUNCE_MS = 250;
export const TOAST_MS = 3000;
export const HEALTH_TTL_MS = 10_000;
/** Timeout for /health, /normalize and /stats: quick reads a correction waits on. */
export const FETCH_TIMEOUT_MS = 1500;
/**
 * Timeout for POST /learn: the server waits up to 10 s for the lexicon file's
 * lock (DEFAULT_LOCK_TIMEOUT_MS) before it writes, so 1.5 s gave up on a write
 * that still went through.
 */
export const WRITE_TIMEOUT_MS = 15_000;
/** Timeout for GET /lexicon (Sync), which sends the whole lexicon. */
export const LEXICON_TIMEOUT_MS = 10_000;
/**
 * After the server answers 401 to the stored token, no bearer request is sent
 * with that token (and base URL) for this long; each further 401 doubles it,
 * up to TOKEN_BACKOFF_MAX_MS. Changing the token or base URL ends it at once.
 */
export const TOKEN_BACKOFF_MS = 30_000;
export const TOKEN_BACKOFF_MAX_MS = 10 * 60_000;
/**
 * The largest request body `lexicon serve` reads (MAX_BODY_BYTES in
 * src/serve/server.ts); a longer one is a 413. The background checks text whose
 * /normalize body would be larger with the embedded lexicon instead of posting it.
 */
export const API_MAX_BODY_BYTES = 1024 * 1024;

export interface Correction {
  start: number;
  end: number;
  original: string;
  replacement: string;
  canonical: string;
  reason: MatchReason;
  confidence: number;
}

export interface ServerHealth {
  ok: boolean;
  version: string;
  terms: number;
}

// ---------------------------------------------------------------------------
// Messages: content script / popup / options -> background
// ---------------------------------------------------------------------------

export type Request =
  | { type: 'normalize'; text: string; dryRun?: boolean }
  /** `probe`: Options > Test connection, which asks the server even while a rejected token is backed off. */
  | { type: 'status'; probe?: boolean }
  | { type: 'learn'; heard: string; meant: string }
  | { type: 'sync' }
  | { type: 'anySite'; enabled: boolean }
  /** From pair.ts on the /pair page: store `token` for `baseUrl` after the server accepts it. */
  | { type: 'pair'; baseUrl: string; token: string }
  /** From Options, after the user allowed the port: run `pair.js` on that port's /pair page (or stop, for the default port). */
  | { type: 'pairPort'; baseUrl: string };

export interface NormalizeOk {
  ok: true;
  input: string;
  output: string;
  changed: boolean;
  replacements: Correction[];
  /** Engine that produced the result. */
  mode: Mode;
  /** Set when `api` was configured but the request fell back to `embedded`. */
  fallback?: string;
  /** Set when matching stopped at the engine's time budget: later text was not checked. */
  incomplete?: NormalizeIncomplete;
}
export interface Failure {
  ok: false;
  error: string;
}
export type NormalizeReply = NormalizeOk | Failure;

export interface StatusReply {
  ok: true;
  configuredMode: Mode;
  activeMode: Mode;
  /** null when unreachable. */
  server: ServerHealth | null;
  serverError?: string;
  tokenSet: boolean;
  /** Set when the server is up but answered 401 to the stored token. */
  tokenError?: string;
  /**
   * Set with `tokenError` while the background backs off from that token
   * (TOKEN_BACKOFF_MS): until this time (epoch ms) no bearer request is sent
   * with it, unless the token or base URL changes first.
   */
  tokenRetryAt?: number;
  /** Set when the server is up and took the token, but a bearer route failed for another reason (so corrections fall back). */
  apiError?: string;
  embeddedTerms: number;
  embeddedError?: string;
  recent: Correction[];
  live: boolean;
  anySite: boolean;
}

export interface LearnReply {
  ok: true;
  message: string;
  mode: Mode;
}

export interface SyncReply {
  ok: true;
  terms: number;
  yaml: string;
  /**
   * The repo `.lexicon.yaml` the server left out because it is untrusted or
   * changed since it was trusted (GET /lexicon `skippedProject`, path only),
   * so its terms are not in `yaml`. Only then.
   */
  skippedProject?: { path: string; trust: 'untrusted' | 'changed' };
}

export interface PairReply {
  ok: true;
  /** The base URL now stored (normalized, no trailing slash). */
  baseUrl: string;
  terms: number;
  version: string;
}

export interface PairPortReply {
  ok: true;
  /** The host permissions the pairing page on that port uses; absent for the default port, which the manifest covers. */
  origins?: string[];
}

export type Reply = NormalizeReply | StatusReply | LearnReply | SyncReply | PairReply | PairPortReply | Failure | { ok: true };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function defaultSettings(yaml: string): Settings {
  return {
    baseUrl: DEFAULT_BASE_URL,
    token: '',
    mode: 'api',
    live: false,
    yaml,
    sites: {},
    anySite: false,
  };
}

/** Fill a partial (possibly stale or corrupt) stored object with defaults. */
export function coerceSettings(raw: unknown, defaultYaml: string): Settings {
  const d = defaultSettings(defaultYaml);
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<Record<keyof Settings, unknown>>;
  return {
    baseUrl: typeof r.baseUrl === 'string' && r.baseUrl.trim() ? r.baseUrl.trim().replace(/\/+$/, '') : d.baseUrl,
    // A token pasted with the newline or spaces around it was sent as is and rejected.
    token: typeof r.token === 'string' ? r.token.trim() : d.token,
    mode: r.mode === 'embedded' ? 'embedded' : 'api',
    live: r.live === true,
    yaml: typeof r.yaml === 'string' ? r.yaml : d.yaml,
    sites: r.sites && typeof r.sites === 'object' ? { ...(r.sites as Record<string, boolean>) } : {},
    anySite: r.anySite === true,
  };
}

/** The stored settings object as it is (fields kept as stored, defaults not filled in), or `{}`. */
function storedObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

/**
 * What the popup stores when its per-site switch changes: the stored object
 * with only `sites` changed. It stored `coerceSettings(stored, '')`, which on
 * a fresh install (nothing stored yet) wrote an empty `yaml`, so the first
 * site switch emptied the embedded lexicon; a field left out is still filled
 * with its default when read.
 */
export function withSiteSwitch(stored: unknown, hostname: string, enabled: boolean): Record<string, unknown> {
  const next = storedObject(stored);
  const sites = next.sites && typeof next.sites === 'object' ? { ...(next.sites as Record<string, boolean>) } : {};
  sites[hostKey(hostname)] = enabled;
  return { ...next, sites };
}

/**
 * What Options stores before Test connection and Sync: the settings as
 * stored now with only the connection fields from the form. Both saved the
 * whole form, so a word the popup's Learn had just added to the embedded
 * YAML, or a site it had just paused, was overwritten with what the Options
 * page loaded. An empty base URL keeps the stored one.
 */
export function withConnection(stored: unknown, form: { baseUrl?: string; token: string; mode: Mode }): Record<string, unknown> {
  const next = storedObject(stored);
  return { ...next, ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}), token: form.token, mode: form.mode };
}

/**
 * The Options YAML box after the stored YAML changed elsewhere (a Learn in
 * the popup, a sync): the new YAML when the box still shows what the page
 * last loaded, else the box as it is (the user's unsaved edit wins, and Save
 * writes it).
 */
export function yamlBoxAfterChange(box: string, loaded: string, stored: string): string {
  return box === loaded ? stored : box;
}

/** `www.perplexity.ai` and `perplexity.ai` share one switch. */
export function hostKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

export function siteEnabled(settings: Pick<Settings, 'sites'>, hostname: string): boolean {
  return settings.sites[hostKey(hostname)] !== false;
}

/** `1 term`, `2 terms`, `1 alias`, `2 aliases`: a count with its noun in the right number. */
export function countOf(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** The Options line after a sync from the local API (`SyncReply`). */
export function syncedLine(reply: SyncReply): string {
  const line = `Synced ${countOf(reply.terms, 'term')} from the local API.`;
  const skipped = reply.skippedProject;
  if (!skipped) return line;
  // Without this a sync in a repo nobody trusted read as complete, though the
  // repo's own names were never sent.
  const why = skipped.trust === 'changed' ? 'has changed since it was trusted' : 'is untrusted';
  return `${line} The project lexicon ${skipped.path} ${why}, so its terms were left out: review it and run \`lexicon trust\` in that repo, then sync again.`;
}

/** The one line the toast shows when matching stopped before the end of the text. */
export function incompleteNotice(inc: NormalizeIncomplete): string {
  if (inc.reasons.includes('length') && inc.checkedChars !== undefined) {
    return `Stopped early: only the first ${inc.checkedChars} of ${inc.totalChars} characters were checked.`;
  }
  return 'Stopped early at the time limit: later text was not checked.';
}

/**
 * The Options > Test connection result for `s`. "Connected" is kept for a
 * server that is up and holds a token it accepts: a server that is up with no
 * token set does not serve this browser's corrections yet, so that line leads
 * with what is true and then the step that pairs it.
 */
export function connectionTestLine(s: StatusReply, now = Date.now()): string {
  if (s.server && s.tokenError) return `Reachable (lexicon ${s.server.version}), but ${s.tokenError}${tokenBackoffNote(s, now)}`;
  if (s.server && s.apiError) return `Reachable (lexicon ${s.server.version}), but ${s.apiError.replace(/[.\s]+$/, '')}. Corrections use the embedded lexicon until that is fixed.`;
  if (s.server && !s.tokenSet) {
    return `Server is up, not paired: lexicon ${s.server.version}, ${countOf(s.server.terms, 'term')}. Corrections use the embedded lexicon until you run \`lexicon serve --pair\`.`;
  }
  if (s.server) return `Connected: lexicon ${s.server.version}, ${countOf(s.server.terms, 'term')}.`;
  const why = s.serverError ?? 'no reply';
  return `Unreachable: ${why}${why.includes('lexicon serve') ? '' : '. Start it with `lexicon serve`'}.`;
}

/**
 * What follows a rejected token while the background backs off from it
 * (`tokenRetryAt`), with a leading space, or an empty string.
 */
export function tokenBackoffNote(s: Pick<StatusReply, 'tokenRetryAt'>, now = Date.now()): string {
  if (s.tokenRetryAt === undefined) return '';
  const secs = Math.max(1, Math.ceil((s.tokenRetryAt - now) / 1000));
  return ` The extension will not send this token again for ${secs} s; pairing or saving another token retries at once.`;
}

/** What the popup's status pill and line say for a status reply. */
export interface StatusView {
  /** Pill text: `Local API`, `Embedded` or `Embedded (fallback)`. */
  mode: string;
  /** True when the pill should read as a warning (the configured API is not in use). */
  warn: boolean;
  /** The line under it; backticked spans render as <code> (setMessage). */
  line: string;
}

/**
 * The popup's status for `s`. Every reason the local API is not in use ends
 * with the step that fixes it: the popup is where a first run, a missing or
 * rejected token and a stopped server all show up first.
 */
export function statusView(s: StatusReply, now = Date.now()): StatusView {
  if (s.activeMode === 'api' && s.server) {
    return { mode: 'Local API', warn: false, line: `lexicon ${s.server.version}, ${countOf(s.server.terms, 'term')}` };
  }
  const api = s.configuredMode === 'api';
  const parts: string[] = [`${countOf(s.embeddedTerms, 'embedded term')}`];
  if (api && s.tokenError) parts.push(s.tokenError + tokenBackoffNote(s, now));
  else if (api && s.apiError) parts.push(`server: ${s.apiError}`);
  else if (api && !s.server) parts.push(s.serverError ? `server: ${s.serverError}` : 'server unreachable; start it with `lexicon serve`');
  if (api && !s.tokenSet) {
    parts.push(
      s.server
        ? `server up (lexicon ${s.server.version}), but no token set: run \`lexicon serve --pair\``
        : // A first run has neither: starting the server is not enough, the
          // browser still has to pair, so name that step too.
          'no token set: once the server is running, run `lexicon serve --pair`',
    );
  }
  if (s.embeddedError) parts.push('embedded YAML has errors: fix it under Options > Embedded lexicon');
  return { mode: api ? 'Embedded (fallback)' : 'Embedded', warn: api, line: parts.join(' · ') };
}

/**
 * A page of the extension (Options, the /pair page) whose request to the
 * background itself failed, as when the extension was reloaded or updated
 * under the page: what failed, then how to get it back.
 */
export function extensionRequestFailedLine(error: string): string {
  return `${error.replace(/[.\s]+$/, '')}. Reload this page; if it persists, reload Lexicon on the browser's extensions page.`;
}

/**
 * The popup's status when the status request itself failed: the pill says
 * what failed (a bare "Error" did not) and the line how to get it back.
 */
export function statusFailedView(error: string): StatusView {
  return {
    mode: 'Status unavailable',
    warn: true,
    line: `could not read the extension status: ${error}. Close and reopen the popup; if it persists, reload Lexicon on the browser's extensions page.`,
  };
}

/**
 * What Options says, and the background throws, when the browser did not
 * grant the optional "any site" permission.
 */
export const ANY_SITE_DENIED_MESSAGE =
  'The "any site" permission was not granted: tick the box again and choose Allow. The listed chat sites still work without it.';

export function describeCorrection(c: Pick<Correction, 'original' | 'replacement'>): string {
  return `${c.original} → ${c.replacement}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `http://127.0.0.1:41733/pair` for the stored base URL. */
export function pairUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${PAIR_PATH}`;
}

/**
 * The base URL a pairing request may set: plain http, a loopback host, an
 * explicit port, nothing else (no path, query, credentials). Returns the
 * normalized origin or undefined.
 */
export function pairableBaseUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' || !PAIR_HOSTS.includes(url.hostname) || url.port === '') return undefined;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) return undefined;
  return `http://${url.hostname}:${url.port}`;
}

/**
 * The host permissions pairing with `baseUrl` needs beyond the manifest's:
 * both loopback origins of its port (`lexicon serve --pair` opens
 * 127.0.0.1, Options opens the host typed), or undefined for the default
 * port, which the manifest grants, and for a URL pairing refuses. Requested
 * from the optional `<all_urls>` grant, so the manifest asks for nothing new.
 */
export function pairPortOrigins(baseUrl: string): string[] | undefined {
  const origin = pairableBaseUrl(baseUrl);
  if (!origin) return undefined;
  const port = new URL(origin).port;
  if (port === DEFAULT_PORT) return undefined;
  return PAIR_HOSTS.map((host) => `http://${host}:${port}/*`);
}

/** The `/pair` page match patterns for those origins (what the manifest lists for the default port). */
export function pairScriptMatches(origins: readonly string[]): string[] {
  return origins.map((o) => `${o.replace(/\/\*$/, '')}${PAIR_PATH}*`);
}

/** What Options says, and the background throws, when the browser did not grant access to the server's port. */
export const PAIR_PORT_DENIED_MESSAGE =
  'Access to that port was not granted, so the pairing page cannot reach the extension: click "pair in this browser" again and choose Allow, or paste the token `lexicon serve --show` prints.';
