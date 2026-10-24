/**
 * The Firefox manifest of the extension, from the Chromium one
 * (scripts/build-extension.mjs writes it to extension/dist-firefox).
 */

/**
 * Firefox grants a Manifest V3 add-on's `host_permissions` at install only
 * from 127 on. Before that the chat sites and the loopback server stayed
 * unpermitted until the user allowed each one in about:addons, so pairing,
 * Test connection and Sync failed and every correction fell back. The
 * minimum is raised instead of asking at runtime: the manifest's list stays
 * the one the user approves at install.
 */
export const FIREFOX_MIN_VERSION = '127.0';

/** `manifest` with `background.scripts` (Firefox has no MV3 service worker yet) and the gecko id and minimum version. */
export function firefoxManifest(manifest) {
  return {
    ...manifest,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: { gecko: { id: 'lexicon@ashlr.ai', strict_min_version: FIREFOX_MIN_VERSION } },
  };
}
