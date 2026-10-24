/**
 * The `/pair` content script for `lexicon serve --port` servers off the
 * default port (the manifest's static content script covers 41733 only).
 * One dynamic registration per port, so pairing a third port no longer
 * replaces the second one's: the registration used to live under a single
 * id. The chrome APIs are injected so the tests drive this with fakes;
 * `background.ts` passes `chrome.scripting` and `chrome.permissions`.
 * No new permission: each port's two loopback origins are still granted one
 * by one from Options (out of the optional `<all_urls>`), and a script is
 * registered only for origins `permissions.contains` says are granted.
 */
import { PAIR_PORT_DENIED_MESSAGE, pairScriptMatches } from './shared.js';

/** The slice of `chrome.scripting` and `chrome.permissions` this module uses. */
export interface PairPortApi {
  scripting: {
    getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<Array<{ id: string; matches?: string[] }>>;
    registerContentScripts(
      scripts: Array<{ id: string; matches: string[]; js: string[]; runAt: 'document_idle'; persistAcrossSessions: boolean }>,
    ): Promise<void>;
    unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
  };
  permissions: { contains(permissions: { origins?: string[] }): Promise<boolean> };
}

/**
 * Id prefix of the registrations. The bare prefix is the id the single-port
 * release used; it is replaced (when its port is paired again) or pruned
 * (when its access goes) like any other.
 */
export const PAIR_PORT_SCRIPT_ID = 'lexicon-pair-port';

/** The registration id for a port's origins (`pairPortOrigins`): `lexicon-pair-port-<port>`. */
export function pairPortScriptId(origins: readonly string[]): string {
  return `${PAIR_PORT_SCRIPT_ID}-${new URL(origins[0].replace(/\*$/, '')).port}`;
}

function isPairPortScript(id: string): boolean {
  return id === PAIR_PORT_SCRIPT_ID || id.startsWith(`${PAIR_PORT_SCRIPT_ID}-`);
}

/** The origins (`http://host:port/*`) a registration's `/pair*` matches were made from. */
function originsOf(matches: readonly string[]): string[] {
  return matches.map((m) => `${new URL(m.replace(/\*$/, '')).origin}/*`);
}

/**
 * Run `pair.js` on the `/pair` page of the port `origins` names, keeping every
 * other port's registration. Undefined (the default port, which the manifest
 * covers) changes nothing. Throws `PAIR_PORT_DENIED_MESSAGE`, registering
 * nothing, when the origins are not granted. A registration already covering
 * the same page (this port's, or the single-id release's) is replaced, so the
 * script never runs twice on one page.
 */
export async function registerPairPort(api: PairPortApi, origins: string[] | undefined): Promise<void> {
  if (!origins || origins.length === 0) return;
  if (!(await api.permissions.contains({ origins }))) throw new Error(PAIR_PORT_DENIED_MESSAGE);
  const matches = pairScriptMatches(origins);
  const id = pairPortScriptId(origins);
  const registered = (await api.scripting.getRegisteredContentScripts()).filter((s) => isPairPortScript(s.id));
  const stale = registered.filter((s) => s.id === id || (s.matches ?? []).some((m) => matches.includes(m))).map((s) => s.id);
  if (stale.length > 0) await api.scripting.unregisterContentScripts({ ids: stale });
  await api.scripting.registerContentScripts([{ id, matches, js: ['pair.js'], runAt: 'document_idle', persistAcrossSessions: true }]);
}

/** Unregister every port's `/pair` script whose origins are no longer all granted. */
export async function prunePairPorts(api: PairPortApi): Promise<void> {
  const registered = (await api.scripting.getRegisteredContentScripts()).filter((s) => isPairPortScript(s.id));
  const gone: string[] = [];
  for (const script of registered) {
    let origins: string[] = [];
    try {
      origins = originsOf(script.matches ?? []);
    } catch {
      // a match this module did not write: treat it as gone
    }
    if (origins.length === 0 || !(await api.permissions.contains({ origins }))) gone.push(script.id);
  }
  if (gone.length > 0) await api.scripting.unregisterContentScripts({ ids: gone });
}
