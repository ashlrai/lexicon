/**
 * The dynamic "Any site" content script registration. The chrome APIs are
 * injected so the tests drive this with fakes; `background.ts` passes
 * `chrome.scripting` and `chrome.permissions`.
 *
 * The registration covers frames (a composer in a same-origin iframe) and,
 * where the browser accepts `matchOriginAsFallback` (Chrome 119 and later),
 * frames whose URL has no host of its own (`about:blank`, `blob:`, `data:`),
 * matched by the page that made them. Rich text editors often build their
 * editable inside such a frame. A browser that refuses the key gets the same
 * registration without it.
 */
import { BUILTIN_MATCHES } from './adapters.js';
import { ANY_SITE_DENIED_MESSAGE, STORAGE_KEYS } from './shared.js';

export const ANY_SITE_SCRIPT_ID = 'lexicon-any-site';

/** One registration as this module writes it. */
export interface AnySiteScript {
  id: string;
  matches: string[];
  excludeMatches: string[];
  js: string[];
  allFrames: boolean;
  matchOriginAsFallback?: boolean;
  runAt: 'document_idle';
  persistAcrossSessions: boolean;
}

/** The slice of `chrome.scripting` and `chrome.permissions` this module uses. */
export interface AnySiteApi {
  scripting: {
    getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<Array<{ id: string; allFrames?: boolean; matchOriginAsFallback?: boolean }>>;
    registerContentScripts(scripts: AnySiteScript[]): Promise<void>;
    unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  };
  permissions: { contains(permissions: { origins?: string[] }): Promise<boolean> };
  /**
   * Where to remember that this browser refused `matchOriginAsFallback`
   * (`chrome.storage.local`). Without it the refusal is remembered for the
   * life of this module only.
   */
  store?: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  /** This browser and its version (`navigator.userAgent`): a refusal remembered for another one is tried again. */
  browser?: string;
}

/** Storage key: the `browser` string of the last browser that refused `matchOriginAsFallback`. */
export const ANY_SITE_NO_FALLBACK_KEY = STORAGE_KEYS.anySiteNoFallback;

/** The refusal remembered when no `store` is given. */
let noFallbackBrowser: string | undefined;

function browserOf(api: AnySiteApi): string {
  return api.browser ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
}

/** Whether this browser refused `matchOriginAsFallback` before (so registering without it is all it takes). */
async function refusedFallback(api: AnySiteApi): Promise<boolean> {
  const browser = browserOf(api);
  if (!api.store) return noFallbackBrowser === browser;
  try {
    return (await api.store.get([ANY_SITE_NO_FALLBACK_KEY]))[ANY_SITE_NO_FALLBACK_KEY] === browser;
  } catch {
    return false;
  }
}

async function rememberRefusal(api: AnySiteApi, refused: boolean): Promise<void> {
  const value = refused ? browserOf(api) : undefined;
  if (!api.store) {
    noFallbackBrowser = value;
    return;
  }
  try {
    if (refused || (await api.store.get([ANY_SITE_NO_FALLBACK_KEY]))[ANY_SITE_NO_FALLBACK_KEY] != null) {
      await api.store.set({ [ANY_SITE_NO_FALLBACK_KEY]: value ?? null });
    }
  } catch {
    // Not remembered: the next reconcile tries the key again, as before.
  }
}

function anySiteScript(fallback: boolean): AnySiteScript {
  return {
    id: ANY_SITE_SCRIPT_ID,
    matches: ['<all_urls>'],
    excludeMatches: [...BUILTIN_MATCHES],
    js: ['content.js'],
    // Frames too: a composer in a same-origin iframe. content-boot.ts
    // leaves a cross-origin frame alone unless it is a chat site.
    allFrames: true,
    ...(fallback ? { matchOriginAsFallback: true } : {}),
    runAt: 'document_idle',
    persistAcrossSessions: true,
  };
}

/**
 * Register (or, with `enabled` false, remove) the "Any site" script. Throws
 * `ANY_SITE_DENIED_MESSAGE` without registering when `<all_urls>` is not
 * granted. A registration from an earlier release (no frames, or no
 * `matchOriginAsFallback`) is replaced. A browser that refuses the key is
 * remembered (with its version, in `api.store`), so a frames registration
 * without the key is left as it is there: every reconcile used to
 * unregister and register it again.
 */
export async function setAnySite(api: AnySiteApi, enabled: boolean): Promise<void> {
  const registered = await api.scripting.getRegisteredContentScripts({ ids: [ANY_SITE_SCRIPT_ID] });
  if (!enabled) {
    if (registered.length) await api.scripting.unregisterContentScripts({ ids: [ANY_SITE_SCRIPT_ID] });
    return;
  }
  const granted = await api.permissions.contains({ origins: ['<all_urls>'] });
  if (!granted) throw new Error(ANY_SITE_DENIED_MESSAGE);
  if (registered.length && registered.every((r) => r.allFrames === true && r.matchOriginAsFallback === true)) return;
  // What this browser accepts is already registered: frames, and no key it refused.
  if (registered.length && registered.every((r) => r.allFrames === true && r.matchOriginAsFallback !== true) && (await refusedFallback(api))) return;
  if (registered.length) await api.scripting.unregisterContentScripts({ ids: [ANY_SITE_SCRIPT_ID] });
  try {
    await api.scripting.registerContentScripts([anySiteScript(true)]);
  } catch (err) {
    // A browser that does not know the key (Firefox, Chrome before 119)
    // refuses the whole registration; without it, frames with a host of
    // their own are still covered.
    if (/duplicate/i.test(err instanceof Error ? err.message : String(err))) throw err;
    await api.scripting.registerContentScripts([anySiteScript(false)]);
    await rememberRefusal(api, true);
    return;
  }
  await rememberRefusal(api, false);
}
