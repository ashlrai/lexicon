/**
 * The Firefox manifest of the extension, from the Chromium one
 * (scripts/build-extension.mjs writes it to extension/dist-firefox).
 */

/**
 * Firefox 140 provides built-in consent for the data sent outside the browser.
 * API mode sends chat text (/normalize), vocabulary (/learn), and the local
 * server's bearer credential. Loopback traffic still counts as transmission:
 * https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
 */
export const FIREFOX_MIN_VERSION = '140.0';

/** `manifest` with `background.scripts` (Firefox has no MV3 service worker yet) and the gecko id and minimum version. */
export function firefoxManifest(manifest) {
  return {
    ...manifest,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: 'lexicon@ashlr.ai',
        strict_min_version: FIREFOX_MIN_VERSION,
        data_collection_permissions: {
          required: ['personalCommunications', 'websiteContent', 'authenticationInfo'],
        },
      },
    },
  };
}
