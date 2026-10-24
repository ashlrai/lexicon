/**
 * Background logic: owns the token, talks to the local API, falls back to the
 * embedded engine. Pure apart from the injected fetch/storage so tests can
 * run it under jsdom with a fake server.
 */
import { builtinPage } from './adapters.js';
import { createEmbedded, learnIntoYaml, lexiconToYaml } from './embedded.js';
import { conflictNote, conflictRemoveCommand, parseLexicon, redactSecrets } from './core.js';
import type { NormalizeIncomplete } from './core.js';
import {
  ANY_SITE_HOSTS_LIMIT,
  API_MAX_BODY_BYTES,
  coerceHostList,
  coerceSettings,
  errorMessage,
  FETCH_TIMEOUT_MS,
  HEALTH_TTL_MS,
  LEXICON_TIMEOUT_MS,
  pairableBaseUrl,
  pairPortOrigins,
  PAIR_PATH,
  hostKey,
  RECENT_LIMIT,
  STORAGE_KEYS,
  TOKEN_BACKOFF_MAX_MS,
  TOKEN_BACKOFF_MS,
  TOKEN_RE,
  WRITE_TIMEOUT_MS,
} from './shared.js';
import type {
  Correction,
  Failure,
  LearnReply,
  Mode,
  NormalizeReply,
  PairPortReply,
  PairReply,
  Reply,
  Request,
  ServerHealth,
  Settings,
  StatusReply,
  SyncReply,
} from './shared.js';

/** What `handle` reads of `chrome.runtime.MessageSender`. */
export interface MessageSender {
  url?: string;
}

export interface KeyValueStore {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface BackgroundDeps {
  fetch: typeof fetch;
  store: KeyValueStore;
  defaultYaml: string;
  now?: () => number;
  /** Called when the "any site" toggle changes; registers/unregisters the dynamic content script. */
  setAnySite?: (enabled: boolean) => Promise<void>;
  /**
   * Runs `pair.js` on the /pair page of a non-default port (`origins` from
   * `pairPortOrigins`, already granted), or stops it (undefined). Throws
   * `PAIR_PORT_DENIED_MESSAGE` when the origins are not granted.
   */
  setPairPort?: (origins: string[] | undefined) => Promise<void>;
}

export interface Background {
  /** `sender.url`: the page of the tab the request came from, as the browser reports it (never the request's own word). */
  handle(req: Request, sender?: MessageSender): Promise<Reply>;
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
}

interface HealthCache {
  at: number;
  /** The base URL probed: a cache for another URL (Options writes storage directly) is not reused. */
  baseUrl: string;
  health: ServerHealth | null;
  error?: string;
}

/** A token the server answered 401 to, at that base URL: not sent again before `until`. */
interface Rejection {
  baseUrl: string;
  token: string;
  until: number;
  delayMs: number;
  message: string;
}

interface ApiNormalize {
  input?: string;
  output: string;
  changed: boolean;
  replacements: Correction[];
  summary?: string;
  incomplete?: unknown;
}

/** A well-formed `incomplete` field from the API (src/serve/server.ts), ignoring anything else. */
function isIncomplete(value: unknown): value is NormalizeIncomplete {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<NormalizeIncomplete>;
  return Array.isArray(v.reasons) && typeof v.totalChars === 'number' && typeof v.note === 'string';
}

/** A 401 from the API: the server is up but the stored token is not its token. */
class TokenRejectedError extends Error {
  constructor(message = 'API rejected the token (401). Re-copy it from `lexicon serve --show`, or run `lexicon serve --pair`.') {
    super(message);
    this.name = 'TokenRejectedError';
  }
}

/**
 * A stored token holding a character no HTTP header can carry (a smart quote
 * or non-breaking space picked up with a paste). fetch throws a TypeError for
 * it, which read as "cannot reach lexicon serve" while the server was up, and
 * status said Connected while every /normalize fell back. The server's tokens
 * are hex, so such a token can never be right.
 */
export const MALFORMED_TOKEN_MESSAGE =
  'The stored API token has characters a lexicon token never has (it is hex only); re-copy it from `lexicon serve --show`, or run `lexicon serve --pair`.';

/** A bearer route with no token stored. Pairing is the one-command fix; pasting is the fallback. */
export const NO_TOKEN_MESSAGE = 'No API token set: run `lexicon serve --pair` to pair this browser, or paste the token `lexicon serve --show` prints into Options.';

/** The step after a reply that says nothing of why the server failed (a bare status, a timeout, `ok: false`). */
export const SERVE_STATUS_STEP = 'run `lexicon serve --status` to check the server';

/** A `/normalize` reply without `output` and `replacements`: most likely a server from another release. */
export const NORMALIZE_SHAPE_MESSAGE =
  'API /normalize returned an unexpected shape: the server and this extension are likely different releases; update lexicon or the extension so they match.';

/**
 * A GET /lexicon reply without a `lexicon` object (another program on the
 * port, a proxy's page, a server from another release). The core's
 * parseLexicon reads a missing value as an empty lexicon, so Sync replaced
 * the embedded YAML with nothing.
 */
export const LEXICON_SHAPE_MESSAGE =
  'API /lexicon returned no lexicon, so the embedded lexicon was left as it was: the server and this extension are likely different releases, or another program answers on that port; run `lexicon serve --status` to check.';

/**
 * The `fallback` of a normalize whose /normalize body (`bytes`, UTF-8) is over
 * the server's request limit: the server would answer 413 to every such
 * check, so the embedded lexicon checks it and nothing is posted.
 */
export function tooLargeForApiMessage(bytes: number): string {
  return `the text is ${bytes} bytes as a request, over the 1 MB lexicon serve accepts, so the embedded lexicon checked it`;
}

/**
 * A /health body with lexicon serve's shape (src/serve/server.ts
 * HealthResponse): a boolean `ok`, a non-empty `version` string and a
 * whole-number `terms`. Any `{ ok: true }` used to count, so another program
 * on the port read as the server and every correction was posted to it.
 */
export function isLexiconHealth(raw: unknown): raw is { ok: boolean; version: string; terms: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const r = raw as { ok?: unknown; version?: unknown; terms?: unknown };
  return typeof r.ok === 'boolean' && typeof r.version === 'string' && r.version.length > 0 && Number.isInteger(r.terms) && (r.terms as number) >= 0;
}

/** What status and a fallback say when something other than lexicon serve answers /health. */
export function foreignHealthMessage(baseUrl: string): string {
  return `something answered ${baseUrl}/health, but not as lexicon serve does; another program may hold the port. Run \`lexicon serve --status\` to check, or point Options at the port lexicon serve uses`;
}

/** What a request that never reached the server says: where it went and how to start the server. */
export function unreachableMessage(baseUrl: string): string {
  return `cannot reach lexicon serve at ${baseUrl}; start it with \`lexicon serve\` (or \`lexicon serve --install\` to start it at login)`;
}

/** The `error` string of a failed API reply (`{ error }`, see src/serve/server.ts), or undefined. */
async function apiErrorDetail(res: Response, token: string): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    const error = body?.error;
    // A server at baseUrl that is not lexicon serve may quote the bearer token back.
    return typeof error === 'string' && error.trim() ? redactSecrets(error.trim(), [token]).slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

export function createBackground(deps: BackgroundDeps): Background {
  const now = deps.now ?? (() => Date.now());
  const embedded = createEmbedded(deps.defaultYaml);
  let healthCache: HealthCache | null = null;
  let rejection: Rejection | null = null;

  /** The backoff for these settings' token and base URL, or null (another token or URL is never held back). */
  function rejectionFor(settings: Settings): Rejection | null {
    return rejection && rejection.baseUrl === settings.baseUrl && rejection.token === settings.token ? rejection : null;
  }

  /** The backoff when it still holds at this moment. */
  function activeRejection(settings: Settings): Rejection | null {
    const r = rejectionFor(settings);
    return r && now() < r.until ? r : null;
  }

  async function getSettings(): Promise<Settings> {
    const raw = await deps.store.get([STORAGE_KEYS.settings]);
    return coerceSettings(raw[STORAGE_KEYS.settings], deps.defaultYaml);
  }

  async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = await getSettings();
    const next = coerceSettings({ ...current, ...patch }, deps.defaultYaml);
    await deps.store.set({ [STORAGE_KEYS.settings]: next });
    if (patch.baseUrl !== undefined || patch.token !== undefined) {
      healthCache = null;
      rejection = null;
    }
    return next;
  }

  async function getRecent(): Promise<Correction[]> {
    const raw = await deps.store.get([STORAGE_KEYS.recent]);
    const list = raw[STORAGE_KEYS.recent];
    return Array.isArray(list) ? (list as Correction[]) : [];
  }

  async function recordRecent(corrections: Correction[]): Promise<void> {
    if (corrections.length === 0) return;
    const recent = await getRecent();
    const next = [...corrections.map((c) => ({ ...c })), ...recent].slice(0, RECENT_LIMIT);
    await deps.store.set({ [STORAGE_KEYS.recent]: next });
  }

  /**
   * `probe` sends a bearer request even while the token is backed off
   * (Options > Test connection); every other bearer request with a token the
   * server rejected waits out the backoff without touching the network.
   */
  async function fetchJson(
    settings: Settings,
    path: string,
    opts: RequestInit & { auth?: boolean; probe?: boolean; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const { auth, probe, timeoutMs = FETCH_TIMEOUT_MS, ...init } = opts;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';
      if (auth !== false) {
        if (!settings.token) throw new Error(NO_TOKEN_MESSAGE);
        if (!/^[\x21-\x7e]+$/.test(settings.token)) throw new TokenRejectedError(MALFORMED_TOKEN_MESSAGE);
        const held = activeRejection(settings);
        if (held && !probe) throw new TokenRejectedError(held.message);
        headers.Authorization = `Bearer ${settings.token}`;
      }
      let res: Response;
      try {
        res = await deps.fetch(`${settings.baseUrl}${path}`, { ...init, headers, signal: ctrl.signal });
      } catch (err) {
        // Nothing answered: whatever /health said earlier no longer holds, so
        // the next request probes again instead of trusting the cache.
        healthCache = null;
        // A refused connection is a bare TypeError ("Failed to fetch" in
        // Chromium, "NetworkError when attempting to fetch resource." in
        // Firefox), which the popup, Test connection and Sync showed as is.
        if (err instanceof TypeError) throw new Error(unreachableMessage(settings.baseUrl));
        throw err;
      }
      // Only 401 means the token. The server also answers 403 for an untrusted
      // project lexicon and 400 for bad input, each with an `{ error }` body
      // that says what to fix, so pass that through instead of a bare status.
      // A 401 or 403 can mean the server restarted with another token or
      // another lexicon: drop the cached /health so the next request asks.
      if (res.status === 401 || res.status === 403) healthCache = null;
      if (res.status === 401) {
        const err = new TokenRejectedError();
        if (auth !== false) {
          // Back off: every normalize sent the rejected token again.
          const prev = rejectionFor(settings);
          const delayMs = prev ? Math.min(prev.delayMs * 2, TOKEN_BACKOFF_MAX_MS) : TOKEN_BACKOFF_MS;
          rejection = { baseUrl: settings.baseUrl, token: settings.token, until: now() + delayMs, delayMs, message: err.message };
        }
        throw err;
      }
      if (auth !== false && res.ok && rejectionFor(settings)) rejection = null;
      if (!res.ok) {
        const detail = await apiErrorDetail(res, settings.token);
        throw new Error(detail ? `API ${path}: ${detail}` : `API ${path} returned HTTP ${res.status}; ${SERVE_STATUS_STEP}`);
      }
      return (await res.json()) as unknown;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        healthCache = null;
        throw new Error(`API ${path} timed out after ${timeoutMs} ms; ${SERVE_STATUS_STEP}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function health(settings: Settings, force = false): Promise<HealthCache> {
    if (!force && healthCache && healthCache.baseUrl === settings.baseUrl && now() - healthCache.at < HEALTH_TTL_MS) return healthCache;
    try {
      const raw = (await fetchJson(settings, '/health', { auth: false })) as unknown;
      if (!isLexiconHealth(raw)) {
        healthCache = { at: now(), baseUrl: settings.baseUrl, health: null, error: foreignHealthMessage(settings.baseUrl) };
        return healthCache;
      }
      const h: ServerHealth = { ok: raw.ok === true, version: raw.version, terms: raw.terms };
      healthCache = { at: now(), baseUrl: settings.baseUrl, health: h.ok ? h : null, error: h.ok ? undefined : `server reports not ok; ${SERVE_STATUS_STEP}` };
    } catch (err) {
      healthCache = { at: now(), baseUrl: settings.baseUrl, health: null, error: errorMessage(err) };
    }
    return healthCache;
  }

  function embeddedNormalize(settings: Settings, text: string, dryRun: boolean, fallback?: string): NormalizeReply {
    const err = embedded.load(settings.yaml);
    // The step goes first: a YAML error can run over several lines.
    if (err) return { ok: false, error: `Embedded lexicon does not parse (fix the YAML under Options > Embedded lexicon, or press Sync from local API there again): ${err}` };
    const r = embedded.normalize(text, dryRun);
    return {
      ok: true,
      input: r.input,
      output: r.output,
      changed: r.changed,
      replacements: r.replacements,
      mode: 'embedded',
      fallback,
      ...(r.incomplete ? { incomplete: r.incomplete } : {}),
    };
  }

  async function apiNormalize(settings: Settings, body: string, text: string): Promise<NormalizeReply> {
    const raw = (await fetchJson(settings, '/normalize', { method: 'POST', body })) as Partial<ApiNormalize>;
    if (typeof raw.output !== 'string' || !Array.isArray(raw.replacements)) {
      throw new Error(NORMALIZE_SHAPE_MESSAGE);
    }
    return {
      ok: true,
      input: text,
      output: raw.output,
      changed: raw.changed === true,
      replacements: raw.replacements,
      mode: 'api',
      ...(isIncomplete(raw.incomplete) ? { incomplete: raw.incomplete } : {}),
    };
  }

  async function normalizeReq(text: string, dryRun: boolean): Promise<NormalizeReply> {
    if (typeof text !== 'string') return { ok: false, error: 'text must be a string' };
    const settings = await getSettings();
    let reply: NormalizeReply;
    if (settings.mode === 'embedded') {
      reply = embeddedNormalize(settings, text, dryRun);
    } else {
      const h = await health(settings);
      const body = JSON.stringify(dryRun ? { text, dryRun: true } : { text });
      const bytes = new TextEncoder().encode(body).length;
      const held = activeRejection(settings);
      if (!h.health) {
        reply = embeddedNormalize(settings, text, dryRun, h.error ?? 'local API unreachable');
      } else if (held) {
        // The token was rejected: wait out the backoff, keeping the health cache.
        reply = embeddedNormalize(settings, text, dryRun, held.message);
      } else if (bytes > API_MAX_BODY_BYTES) {
        // A known 413: the server is fine, so the health cache stays.
        reply = embeddedNormalize(settings, text, dryRun, tooLargeForApiMessage(bytes));
      } else {
        try {
          reply = await apiNormalize(settings, body, text);
        } catch (err) {
          healthCache = null;
          reply = embeddedNormalize(settings, text, dryRun, errorMessage(err));
        }
      }
    }
    if (!dryRun && reply.ok && reply.changed) await recordRecent(reply.replacements);
    return reply;
  }

  async function statusReq(probe: boolean): Promise<StatusReply> {
    const settings = await getSettings();
    // The Embedded mode uses no server, so the popup does not probe one;
    // Test connection (`probe`) still asks, since that is what it is for.
    const h: Pick<HealthCache, 'health' | 'error'> =
      settings.mode === 'api' || probe ? await health(settings, true) : { health: null };
    // /health needs no token, so a reachable server says nothing about the
    // stored one. Prove it on a bearer route, or "Test connection" reports
    // Connected while every /normalize falls back with a 401.
    let tokenError: string | undefined;
    // Any other failure of that bearer route (a 404 from another program
    // that answers /health with ok, a 500 from a lexicon that does not
    // parse, a timeout) fails every /normalize too. It was ignored, so the
    // popup read "Local API" and Test connection "Connected" while every
    // correction fell back to the embedded lexicon.
    let apiError: string | undefined;
    if (settings.mode === 'api' && h.health && settings.token) {
      try {
        await fetchJson(settings, '/stats', { probe });
      } catch (err) {
        if (err instanceof TokenRejectedError) tokenError = err.message;
        else apiError = errorMessage(err);
      }
    }
    // No token means every /normalize falls back (fetchJson refuses a bearer
    // route without one), so the popup must not read "Local API" then either.
    const activeMode: Mode = settings.mode === 'api' && h.health && settings.token && !tokenError && !apiError ? 'api' : 'embedded';
    const embeddedError = embedded.load(settings.yaml);
    const held = tokenError !== undefined ? activeRejection(settings) : null;
    return {
      ok: true,
      configuredMode: settings.mode,
      activeMode,
      server: h.health,
      serverError: h.error,
      tokenSet: settings.token.length > 0,
      ...(tokenError !== undefined ? { tokenError } : {}),
      ...(held ? { tokenRetryAt: held.until } : {}),
      ...(apiError !== undefined ? { apiError } : {}),
      embeddedTerms: embedded.termCount(),
      embeddedError: embeddedError ?? undefined,
      recent: await getRecent(),
      live: settings.live,
      anySite: settings.anySite,
    };
  }

  async function learnReq(heard: string, meant: string): Promise<LearnReply | Failure> {
    const settings = await getSettings();
    const h = settings.mode === 'api' ? await health(settings) : undefined;
    const useApi = h !== undefined && h.health !== null;
    // Why the API was skipped although the server answers /health. Normalize
    // falls back to the embedded lexicon for a missing or rejected token, so
    // Learn does the same (the popup promises it writes the embedded YAML
    // whenever the API is not usable), and says so: the server never saw it.
    let skipped: string | undefined;
    // The API mode with the server down: the word goes to the embedded copy,
    // which the next Sync from local API replaces, so say that as well.
    let again = 'once paired';
    if (h && !h.health) {
      skipped = h.error ?? 'local API unreachable';
      again = 'once the server is running';
    }
    if (useApi && !settings.token) skipped = NO_TOKEN_MESSAGE;
    if (useApi && skipped === undefined) {
      try {
        // Server reply: { term, created, aliasAdded, path, conflict?, untrustedProject? } (src/serve/server.ts LearnResponse).
        const raw = (await fetchJson(settings, '/learn', { method: 'POST', body: JSON.stringify({ heard, meant }), timeoutMs: WRITE_TIMEOUT_MS })) as {
          term?: { canonical?: string };
          created?: boolean;
          aliasAdded?: boolean;
          conflict?: unknown;
          untrustedProject?: unknown;
        };
        healthCache = null; // term count changed
        const canonical = raw?.term?.canonical ?? meant;
        const message = raw?.created
          ? `Added new term ${canonical} with alias "${heard}".`
          : raw?.aliasAdded
            ? `Added "${heard}" as an alias of ${canonical}.`
            : `"${heard}" is already an alias of ${canonical}.`;
        return { ok: true, mode: 'api', message: message + learnWarnings(heard, raw?.conflict, raw?.untrustedProject) };
      } catch (err) {
        // Only a rejected token falls back; a 400 or 403 is the server refusing
        // this correction, which the embedded copy must not quietly accept.
        if (!(err instanceof TokenRejectedError)) return { ok: false, error: errorMessage(err) };
        healthCache = null;
        skipped = err.message;
      }
    }
    try {
      const out = learnIntoYaml(settings.yaml, heard, meant);
      await saveSettings({ yaml: out.yaml });
      return { ok: true, mode: 'embedded', message: out.message + (skipped ? embeddedOnlyNote(skipped, again) : '') };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async function syncReq(): Promise<SyncReply | Failure> {
    const settings = await getSettings();
    try {
      const raw = (await fetchJson(settings, '/lexicon', { timeoutMs: LEXICON_TIMEOUT_MS })) as { lexicon?: unknown; skippedProject?: unknown; projectTrust?: unknown } | null;
      const body = raw?.lexicon;
      if (!body || typeof body !== 'object' || !Array.isArray((body as { terms?: unknown }).terms)) return { ok: false, error: LEXICON_SHAPE_MESSAGE };
      const lexicon = parseLexicon(body);
      const yaml = lexiconToYaml(lexicon);
      await saveSettings({ yaml });
      // GET /lexicon names a repo file it left out (untrusted or changed) by
      // path only; pass it on so Options can say the sync is missing its terms.
      const skippedProject =
        typeof raw?.skippedProject === 'string' && raw.skippedProject
          ? { path: raw.skippedProject, trust: raw.projectTrust === 'changed' ? ('changed' as const) : ('untrusted' as const) }
          : undefined;
      return { ok: true, terms: lexicon.terms.length, yaml, ...(skippedProject ? { skippedProject } : {}) };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  /**
   * Pairing: the /pair content script hands over the token it read from the
   * page. The token is proven against a bearer route (GET /stats; /health
   * needs no auth so it proves nothing) before anything is stored, then the
   * settings switch to `api` with the new base URL and token. The base URL
   * must be the sender tab's own origin, on its /pair page: the URL came from
   * the page's meta tags, and a page should not pair the extension with a
   * server other than the one that served it.
   */
  async function pairReq(rawBaseUrl: string, rawToken: string, senderUrl: string | undefined): Promise<PairReply | Failure> {
    const baseUrl = pairableBaseUrl(String(rawBaseUrl ?? ''));
    if (!baseUrl) return { ok: false, error: 'Pairing works only with a lexicon serve on 127.0.0.1 or localhost.' };
    if (!isPairPageOf(senderUrl, baseUrl)) {
      return { ok: false, error: `Pairing must come from ${baseUrl}${PAIR_PATH} itself; run \`lexicon serve --pair\` again.` };
    }
    const token = String(rawToken ?? '').trim();
    if (!TOKEN_RE.test(token)) return { ok: false, error: 'The page carried no valid token; run `lexicon serve --pair` again.' };
    const candidate: Settings = { ...(await getSettings()), baseUrl, token, mode: 'api' };
    let terms: number;
    try {
      const stats = (await fetchJson(candidate, '/stats')) as { termCount?: unknown };
      terms = typeof stats.termCount === 'number' ? stats.termCount : 0;
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    await saveSettings({ baseUrl, token, mode: 'api' });
    const h = await health(candidate, true);
    return { ok: true, baseUrl, terms: h.health?.terms ?? terms, version: h.health?.version ?? '?' };
  }

  async function pairPortReq(rawBaseUrl: string): Promise<PairPortReply | Failure> {
    if (!pairableBaseUrl(String(rawBaseUrl ?? ''))) return { ok: false, error: 'Pairing works only with a lexicon serve on 127.0.0.1 or localhost, with its port in the URL.' };
    const origins = pairPortOrigins(rawBaseUrl);
    try {
      await deps.setPairPort?.(origins);
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    return origins ? { ok: true, origins } : { ok: true };
  }

  /** Hosts already in STORAGE_KEYS.anySiteHosts this worker has seen, so a check writes the list only for a new one. */
  const rememberedHosts = new Set<string>();

  /**
   * Adds the host of `url` to STORAGE_KEYS.anySiteHosts (newest first, at most
   * ANY_SITE_HOSTS_LIMIT) when the guard runs there through "Any site", so
   * Options lists it with a switch. Built-in chat pages are listed anyway.
   */
  async function rememberAnySiteHost(url: string | undefined): Promise<void> {
    if (!url) return;
    let host: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
      host = hostKey(u.hostname);
    } catch {
      return;
    }
    if (!host || builtinPage(url) || rememberedHosts.has(host)) return;
    const stored = coerceHostList((await deps.store.get([STORAGE_KEYS.anySiteHosts]))[STORAGE_KEYS.anySiteHosts]);
    rememberedHosts.add(host);
    if (stored[0] === host) return;
    await deps.store.set({ [STORAGE_KEYS.anySiteHosts]: [host, ...stored.filter((h) => h !== host)].slice(0, ANY_SITE_HOSTS_LIMIT) });
  }

  async function handle(req: Request, sender?: MessageSender): Promise<Reply> {
    if (!req || typeof req !== 'object' || typeof (req as { type?: unknown }).type !== 'string') {
      return { ok: false, error: 'bad request' };
    }
    switch (req.type) {
      case 'normalize':
        try {
          await rememberAnySiteHost(sender?.url);
        } catch {
          // A storage failure must not cost the check.
        }
        return normalizeReq(req.text, req.dryRun === true);
      case 'status':
        return statusReq(req.probe === true);
      case 'learn':
        return learnReq(String(req.heard ?? ''), String(req.meant ?? ''));
      case 'sync':
        return syncReq();
      case 'pair':
        return pairReq(req.baseUrl, req.token, sender?.url);
      case 'pairPort':
        return pairPortReq(req.baseUrl);
      case 'anySite': {
        try {
          await deps.setAnySite?.(req.enabled === true);
          await saveSettings({ anySite: req.enabled === true });
          return { ok: true };
        } catch (err) {
          return { ok: false, error: errorMessage(err) };
        }
      }
      default:
        return { ok: false, error: `unknown request type ${(req as { type: string }).type}` };
    }
  }

  return { handle, getSettings, saveSettings };
}

/**
 * What a Learn in API mode that went to the embedded YAML must add (the
 * server is down, or up without a usable token): the server's lexicon did not
 * get it, why, and that Sync from local API replaces the embedded YAML.
 * Exported for tests.
 */
export function embeddedOnlyNote(reason: string, again = 'once paired'): string {
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return ` Saved to the embedded lexicon only, not the server's: ${sentence} A later Sync from local API replaces the embedded lexicon, so learn it again ${again}.`;
}

/**
 * What a /learn success must still say: another term that also holds `heard`
 * (`conflict`), so a transcript may keep going to it, and an untrusted project
 * lexicon that claims it too (`untrustedProject`, path only). The popup showed
 * a bare "Added ..." for both, so the user believed a correction that may not
 * win. Fields of an unexpected shape are ignored. Exported for tests.
 */
export function learnWarnings(heard: string, conflict: unknown, untrustedProject: unknown): string {
  let out = '';
  const c = conflict as { canonical?: unknown; scope?: unknown; as?: unknown; spelling?: unknown } | null | undefined;
  if (c && typeof c.canonical === 'string' && (c.scope === 'global' || c.scope === 'project')) {
    const spelling = typeof c.spelling === 'string' ? c.spelling : heard;
    out +=
      c.as === 'alias'
        ? ` But "${spelling}" is also an alias of ${c.canonical} (${c.scope} lexicon), so it may still be corrected to that (to drop it, run: ${conflictRemoveCommand({ canonical: c.canonical, scope: c.scope, as: 'alias', spelling })}).`
        : // The core's sentence (CLI audience), so the popup names the same
          // remove step as learn --json, add --json and serve POST /learn.
          ` But ${conflictNote([{ canonical: c.canonical, scope: c.scope, as: 'canonical', spelling }])}.`;
  }
  const u = untrustedProject as { path?: unknown; trust?: unknown } | null | undefined;
  if (u && typeof u.path === 'string') {
    out += ` The project lexicon ${u.path} is ${u.trust === 'changed' ? 'changed since it was trusted' : 'not trusted'} and also claims "${heard}"; once it is trusted its term wins (review it with: lexicon trust).`;
  }
  return out;
}

/**
 * True when `senderUrl` is the /pair page of `baseUrl` (same origin, path
 * /pair with or without a trailing slash). Exported for tests.
 */
export function isPairPageOf(senderUrl: string | undefined, baseUrl: string): boolean {
  if (!senderUrl) return false;
  let page: URL;
  let base: URL;
  try {
    page = new URL(senderUrl);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  return page.origin === base.origin && page.pathname.replace(/\/+$/, '') === PAIR_PATH;
}
