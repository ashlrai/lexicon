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
import { ANY_SITE_DENIED_MESSAGE } from './shared.js';

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
 * `matchOriginAsFallback`) is replaced; on a browser without the key that
 * means one re-registration per call, which is harmless.
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
  if (registered.length) await api.scripting.unregisterContentScripts({ ids: [ANY_SITE_SCRIPT_ID] });
  try {
    await api.scripting.registerContentScripts([anySiteScript(true)]);
  } catch (err) {
    // A browser that does not know the key (Firefox, Chrome before 119)
    // refuses the whole registration; without it, frames with a host of
    // their own are still covered.
    if (/duplicate/i.test(err instanceof Error ? err.message : String(err))) throw err;
    await api.scripting.registerContentScripts([anySiteScript(false)]);
  }
}
