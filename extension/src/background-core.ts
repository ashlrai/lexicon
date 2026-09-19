/**
 * Background logic: owns the token, talks to the local API, falls back to the
 * embedded engine. Pure apart from the injected fetch/storage so tests can
 * run it under jsdom with a fake server.
 */
import { createEmbedded, learnIntoYaml, lexiconToYaml } from './embedded.js';
import { parseLexicon } from './core.js';
import {
  coerceSettings,
  errorMessage,
  FETCH_TIMEOUT_MS,
  HEALTH_TTL_MS,
  RECENT_LIMIT,
  STORAGE_KEYS,
} from './shared.js';
import type {
  Correction,
  Failure,
  LearnReply,
  Mode,
  NormalizeReply,
  Reply,
  Request,
  ServerHealth,
  Settings,
  StatusReply,
  SyncReply,
} from './shared.js';

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
}

export interface Background {
  handle(req: Request): Promise<Reply>;
  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
}

interface HealthCache {
  at: number;
  health: ServerHealth | null;
  error?: string;
}

interface ApiNormalize {
  input?: string;
  output: string;
  changed: boolean;
  replacements: Correction[];
  summary?: string;
}

export function createBackground(deps: BackgroundDeps): Background {
  const now = deps.now ?? (() => Date.now());
  const embedded = createEmbedded(deps.defaultYaml);
  let healthCache: HealthCache | null = null;

  async function getSettings(): Promise<Settings> {
    const raw = await deps.store.get([STORAGE_KEYS.settings]);
    return coerceSettings(raw[STORAGE_KEYS.settings], deps.defaultYaml);
  }

  async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
    const current = await getSettings();
    const next = coerceSettings({ ...current, ...patch }, deps.defaultYaml);
    await deps.store.set({ [STORAGE_KEYS.settings]: next });
    if (patch.baseUrl !== undefined || patch.token !== undefined) healthCache = null;
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

  async function fetchJson(settings: Settings, path: string, init: RequestInit & { auth?: boolean } = {}): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';
      if (init.auth !== false) {
        if (!settings.token) throw new Error('No API token set (run `lexicon serve --show` and paste it in Options).');
        headers.Authorization = `Bearer ${settings.token}`;
      }
      const res = await deps.fetch(`${settings.baseUrl}${path}`, { ...init, headers, signal: ctrl.signal });
      if (res.status === 401 || res.status === 403) throw new Error('API rejected the token (401). Re-copy it from `lexicon serve --show`.');
      if (!res.ok) throw new Error(`API ${path} returned HTTP ${res.status}`);
      return (await res.json()) as unknown;
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') throw new Error(`API ${path} timed out`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function health(settings: Settings, force = false): Promise<HealthCache> {
    if (!force && healthCache && now() - healthCache.at < HEALTH_TTL_MS) return healthCache;
    try {
      const raw = (await fetchJson(settings, '/health', { auth: false })) as Partial<ServerHealth>;
      const h: ServerHealth = {
        ok: raw.ok === true,
        version: typeof raw.version === 'string' ? raw.version : '?',
        terms: typeof raw.terms === 'number' ? raw.terms : 0,
      };
      healthCache = { at: now(), health: h.ok ? h : null, error: h.ok ? undefined : 'server reports not ok' };
    } catch (err) {
      healthCache = { at: now(), health: null, error: errorMessage(err) };
    }
    return healthCache;
  }

  function embeddedNormalize(settings: Settings, text: string, dryRun: boolean, fallback?: string): NormalizeReply {
    const err = embedded.load(settings.yaml);
    if (err) return { ok: false, error: `Embedded lexicon does not parse: ${err}` };
    const r = embedded.normalize(text, dryRun);
    return { ok: true, input: r.input, output: r.output, changed: r.changed, replacements: r.replacements, mode: 'embedded', fallback };
  }

  async function apiNormalize(settings: Settings, text: string, dryRun: boolean): Promise<NormalizeReply> {
    const raw = (await fetchJson(settings, '/normalize', {
      method: 'POST',
      body: JSON.stringify(dryRun ? { text, dryRun: true } : { text }),
    })) as Partial<ApiNormalize>;
    if (typeof raw.output !== 'string' || !Array.isArray(raw.replacements)) {
      throw new Error('API /normalize returned an unexpected shape');
    }
    return {
      ok: true,
      input: text,
      output: raw.output,
      changed: raw.changed === true,
      replacements: raw.replacements,
      mode: 'api',
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
      if (!h.health) {
        reply = embeddedNormalize(settings, text, dryRun, h.error ?? 'local API unreachable');
      } else {
        try {
          reply = await apiNormalize(settings, text, dryRun);
        } catch (err) {
          healthCache = null;
          reply = embeddedNormalize(settings, text, dryRun, errorMessage(err));
        }
      }
    }
    if (!dryRun && reply.ok && reply.changed) await recordRecent(reply.replacements);
    return reply;
  }

  async function statusReq(): Promise<StatusReply> {
    const settings = await getSettings();
    const h = settings.mode === 'api' ? await health(settings, true) : await health(settings);
    const activeMode: Mode = settings.mode === 'api' && h.health ? 'api' : 'embedded';
    const embeddedError = embedded.load(settings.yaml);
    return {
      ok: true,
      configuredMode: settings.mode,
      activeMode,
      server: h.health,
      serverError: h.error,
      tokenSet: settings.token.length > 0,
      embeddedTerms: embedded.termCount(),
      embeddedError: embeddedError ?? undefined,
      recent: await getRecent(),
      live: settings.live,
      anySite: settings.anySite,
    };
  }

  async function learnReq(heard: string, meant: string): Promise<LearnReply | Failure> {
    const settings = await getSettings();
    const useApi = settings.mode === 'api' && (await health(settings)).health !== null;
    if (useApi) {
      try {
        // Server reply: { term, created, aliasAdded, path } (src/serve/server.ts LearnResponse).
        const raw = (await fetchJson(settings, '/learn', { method: 'POST', body: JSON.stringify({ heard, meant }) })) as {
          term?: { canonical?: string };
          created?: boolean;
          aliasAdded?: boolean;
        };
        healthCache = null; // term count changed
        const canonical = raw?.term?.canonical ?? meant;
        const message = raw?.created
          ? `Added new term ${canonical} with alias "${heard}".`
          : raw?.aliasAdded
            ? `Added "${heard}" as an alias of ${canonical}.`
            : `"${heard}" is already an alias of ${canonical}.`;
        return { ok: true, mode: 'api', message };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    }
    try {
      const out = learnIntoYaml(settings.yaml, heard, meant);
      await saveSettings({ yaml: out.yaml });
      return { ok: true, mode: 'embedded', message: out.message };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async function syncReq(): Promise<SyncReply | Failure> {
    const settings = await getSettings();
    try {
      const raw = (await fetchJson(settings, '/lexicon')) as { lexicon?: unknown };
      const lexicon = parseLexicon(raw?.lexicon);
      const yaml = lexiconToYaml(lexicon);
      await saveSettings({ yaml });
      return { ok: true, terms: lexicon.terms.length, yaml };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  async function handle(req: Request): Promise<Reply> {
    if (!req || typeof req !== 'object' || typeof (req as { type?: unknown }).type !== 'string') {
      return { ok: false, error: 'bad request' };
    }
    switch (req.type) {
      case 'normalize':
        return normalizeReq(req.text, req.dryRun === true);
      case 'status':
        return statusReq();
      case 'learn':
        return learnReq(String(req.heard ?? ''), String(req.meant ?? ''));
      case 'sync':
        return syncReq();
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
