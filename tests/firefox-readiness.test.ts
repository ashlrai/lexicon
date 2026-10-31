import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('Firefox readiness documentation', () => {
  it('tracks the generated Firefox manifest and the documented review boundary', async () => {
    const doc = read('docs/firefox-extension-readiness.md');
    const source = JSON.parse(read('extension/manifest.json')) as Record<string, unknown>;
    const mod = await import(pathToFileURL(resolve(root, 'scripts/extension-manifest.mjs')).href);
    const manifest = mod.firefoxManifest(source);
    const gecko = manifest.browser_specific_settings.gecko;
    for (const value of [gecko.id, gecko.strict_min_version, ...gecko.data_collection_permissions.required, ...(source.permissions as string[]), ...(source.optional_host_permissions as string[])]) {
      expect(doc).toContain(`\`${value}\``);
    }
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/12');
    expect(doc).toMatch(/not evidence\s+of an AMO submission, approval, signing, or publication/);
    expect(doc).toContain('## Open questions before submission');
    expect(read('docs/README.md')).toContain('(firefox-extension-readiness.md)');
  });
});
