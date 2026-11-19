import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');
const DOC = 'docs/firefox-extension-distribution.md';

async function manifestValues(): Promise<{ gecko: { id: string; strict_min_version: string; data_collection_permissions: { required: string[] } }; source: Record<string, unknown> }> {
  const source = JSON.parse(read('extension/manifest.json')) as Record<string, unknown>;
  const mod = await import(pathToFileURL(resolve(root, 'scripts/extension-manifest.mjs')).href);
  return { gecko: mod.firefoxManifest(source).browser_specific_settings.gecko, source };
}

// Issue #12 (AMO distribution) used to be spread over five pages; they were
// folded into one. Every assertion the old per-page tests made that still
// describes the merged page is kept here.
describe('Firefox AMO distribution documentation', () => {
  it('is one indexed page; the folded pages are gone', () => {
    const index = read('docs/README.md');
    expect(index).toContain('(firefox-extension-distribution.md)');
    for (const old of [
      'firefox-distribution-scope.md',
      'firefox-extension-readiness.md',
      'firefox-extension-publication-questions.md',
      'firefox-addon-submission-checklist.md',
    ]) {
      expect(existsSync(resolve(root, 'docs', old))).toBe(false);
      expect(index).not.toContain(`(${old})`);
    }
  });

  it('names every generated Firefox manifest value the review depends on', async () => {
    const doc = read(DOC);
    const { gecko, source } = await manifestValues();
    for (const value of [gecko.id, gecko.strict_min_version, ...gecko.data_collection_permissions.required, ...(source.permissions as string[]), ...(source.optional_host_permissions as string[])]) {
      expect(doc).toContain(`\`${value}\``);
    }
  });

  it('states AMO distribution is proposed and never claims a submission or publication', () => {
    const doc = read(DOC);
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/12');
    expect(doc).toContain('Mozilla Add-ons (AMO)\ndistribution');
    expect(doc).toContain('Distribution is proposed, not done');
    expect(doc).toMatch(/not evidence\s+of an AMO submission, approval, signing, or publication/);
    expect(doc).toMatch(/not a submission\s+or publication/);
  });

  it('lists what maintainers verify before submission', () => {
    const doc = read(DOC);
    expect(doc).toContain('## Information maintainers must verify before submission');
    expect(doc).toContain('npx web-ext lint --source-dir extension/dist-firefox');
    expect(doc).toContain('npm run build:extension');
    expect(doc).toContain('Publishing to AMO');
    expect(doc).toContain('clean Firefox profile');
    expect(doc).toContain('extension/lexicon-extension-firefox.zip');
    expect(doc).toContain('source archive');
    expect(doc).toMatch(/permission revocation\s+and regrant/);
  });

  it('keeps the submission checklist unticked and aimed at a listed AMO listing', () => {
    const doc = read(DOC);
    expect(doc).toContain('## Submission checklist');
    expect(doc).toContain('listed Firefox Add-ons (AMO) listing');
    expect(doc).toContain('All boxes are unverified');
    expect(doc).toMatch(/^- \[ \]/m);
    expect(doc).not.toMatch(/^- \[[xX]\]/m);
  });
});
