/// <reference lib="dom" />
/**
 * Types and constants shared by the background worker, content script, popup
 * and options page. No chrome.* access here: everything that touches the
 * extension API takes it as a dependency so the jsdom tests can stub it.
 *
 * The DOM lib reference above is deliberate: tests/extension.test.ts pulls
 * these modules into the root tsconfig, whose lib is ES2022 only.
 */
import type { MatchReason } from '../../src/core/types.js';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:41733';

/** Which engine corrects text. `api` falls back to `embedded` when /health fails. */
export type Mode = 'api' | 'embedded';

export interface Settings {
  baseUrl: string;
  /** Bearer token from `lexicon serve --show`. Never sent to a content script. */
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
} as const;

export const RECENT_LIMIT = 5;
export const LIVE_DEBOUNCE_MS = 400;
export const PRECHECK_DEBOUNCE_MS = 250;
export const TOAST_MS = 3000;
export const HEALTH_TTL_MS = 10_000;
export const FETCH_TIMEOUT_MS = 1500;

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
  | { type: 'status' }
  | { type: 'learn'; heard: string; meant: string }
  | { type: 'sync' }
  | { type: 'anySite'; enabled: boolean };

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
}

export type Reply = NormalizeReply | StatusReply | LearnReply | SyncReply | Failure | { ok: true };

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
    token: typeof r.token === 'string' ? r.token : d.token,
    mode: r.mode === 'embedded' ? 'embedded' : 'api',
    live: r.live === true,
    yaml: typeof r.yaml === 'string' ? r.yaml : d.yaml,
    sites: r.sites && typeof r.sites === 'object' ? { ...(r.sites as Record<string, boolean>) } : {},
    anySite: r.anySite === true,
  };
}

/** `www.perplexity.ai` and `perplexity.ai` share one switch. */
export function hostKey(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

export function siteEnabled(settings: Pick<Settings, 'sites'>, hostname: string): boolean {
  return settings.sites[hostKey(hostname)] !== false;
}

export function describeCorrection(c: Pick<Correction, 'original' | 'replacement'>): string {
  return `${c.original} → ${c.replacement}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
