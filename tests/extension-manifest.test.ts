/**
 * The Firefox manifest scripts/build-extension.mjs writes: Firefox grants a
 * Manifest V3 add-on's host permissions at install only from 127 on.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Gecko {
  id: string;
  strict_min_version: string;
}
interface ManifestModule {
  FIREFOX_MIN_VERSION: string;
  firefoxManifest(m: Record<string, unknown>): Record<string, unknown> & { browser_specific_settings: { gecko: Gecko }; background: unknown };
}

const modPath = resolve(process.cwd(), 'scripts/extension-manifest.mjs');

describe('Firefox manifest', () => {
  // Catches: strict_min_version 121 let Firefox 121 to 126 install the add-on
  // with none of its host permissions granted, so the chat sites and the
  // loopback server stayed blocked until allowed one by one in about:addons.
  it('requires a Firefox that grants host_permissions at install', async () => {
    const mod = (await import(pathToFileURL(modPath).href)) as ManifestModule;
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'extension/manifest.json'), 'utf8')) as Record<string, unknown>;
    const ff = mod.firefoxManifest(manifest);
    const min = ff.browser_specific_settings.gecko.strict_min_version;
    expect(min).toBe(mod.FIREFOX_MIN_VERSION);
    expect(Number(min.split('.')[0])).toBeGreaterThanOrEqual(127);
    expect(ff.browser_specific_settings.gecko.id).toBe('lexicon@ashlr.ai');
    expect(ff.background).toEqual({ scripts: ['background.js'], type: 'module' });
    expect(ff.host_permissions).toEqual(manifest.host_permissions);
    // The build uses this module rather than its own copy.
    expect(readFileSync(resolve(process.cwd(), 'scripts/build-extension.mjs'), 'utf8')).toContain('firefoxManifest(manifest)');
  });
});
