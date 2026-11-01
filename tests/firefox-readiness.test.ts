import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

describe('Firefox readiness documentation', () => {
  it('distinguishes the roadmap outcome from unverified issue requirements', () => {
    const doc = read('docs/firefox-distribution-scope.md');
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/12');
    expect(doc).toContain('listed Firefox Add-ons (AMO) listing');
    expect(doc).toMatch(/prerequisites and any additional acceptance criteria remain \*\*unverified\*\*/);
    expect(doc).toContain('not claims about what issue');
    expect(read('docs/README.md')).toContain('(firefox-distribution-scope.md)');
  });

  it('records publication questions without asserting issue details or publication', () => {
    const doc = read('docs/firefox-extension-publication-questions.md');
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/12');
    expect(doc).toContain('Firefox Add-ons (AMO) listing');
    expect(doc).toMatch(/exact requirements\s+and any additional acceptance criteria remain unverified/);
    expect(doc).toContain('not a submission or publication');
    expect(doc).toContain('## Packaging questions');
    expect(doc).toContain('## Review and listing questions');
    expect(doc).toContain('source archive');
    expect(doc).toContain('permission revocation and regrant');
    expect(read('docs/README.md')).toContain('(firefox-extension-publication-questions.md)');
  });

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

  it('keeps the submission checklist aligned with the Firefox build and unverified status', async () => {
    const doc = read('docs/firefox-addon-submission-checklist.md');
    const source = JSON.parse(read('extension/manifest.json')) as Record<string, unknown>;
    const mod = await import(pathToFileURL(resolve(root, 'scripts/extension-manifest.mjs')).href);
    const gecko = mod.firefoxManifest(source).browser_specific_settings.gecko;
    for (const value of [gecko.id, ...gecko.data_collection_permissions.required, ...(source.permissions as string[]), ...(source.optional_host_permissions as string[])]) {
      expect(doc).toContain(`\`${value}\``);
    }
    expect(doc).toContain('listed Firefox Add-ons (AMO) listing');
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/12');
    expect(doc).toContain('extension/lexicon-extension-firefox.zip');
    expect(doc).toContain('All boxes are unverified');
    expect(doc).not.toMatch(/^- \[[xX]\]/m);
    expect(read('docs/README.md')).toContain('(firefox-addon-submission-checklist.md)');
  });
});
