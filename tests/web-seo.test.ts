import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { useCases, useCasePath } from '../web/lib/use-cases.js';

// Import the dependency-free validators only. The production check loads jsdom
// inside main(), keeping this suite usable on every supported package runtime.
const validators = await import(new URL('../web/scripts/check-seo.mjs', import.meta.url).href) as {
  validateUseCases: (guides: unknown) => void;
  validateSource: (source: unknown) => void;
  validatePage: (document: unknown, pathname: string, guides: string[]) => void;
  validateSitemap: (document: unknown, routes: string[]) => void;
};
const root = fileURLToPath(new URL('..', import.meta.url));

describe('use-case evidence contract', () => {
  it('has substantive, distinct guides with an existing source for every claim and example', () => {
    expect(() => validators.validateUseCases(useCases)).not.toThrow();
  });

  it.each(useCases)('$slug uses a unique stable route', (guide) => {
    expect(useCasePath(guide.slug)).toBe(`/use-cases/${guide.slug}`);
    expect(new URL(useCasePath(guide.slug), 'https://lexicon.ashlr.ai').pathname).toBe(useCasePath(guide.slug));
  });

  it('rejects a factual block with no source instead of silently publishing it', () => {
    const guides = structuredClone(useCases);
    const first = guides[0];
    const broken = { ...first, intro: { ...first.intro, sources: [] } };
    expect(() => validators.validateUseCases([broken, ...guides.slice(1)])).toThrow('claim has no source');
  });

  it('rejects a command example with no source', () => {
    const guides = structuredClone(useCases);
    const first = guides[0];
    const sections = first.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map((block) => block.code ? { ...block, sources: [] } : block),
    }));
    expect(() => validators.validateUseCases([{ ...first, sections }, ...guides.slice(1)])).toThrow('claim has no source');
  });

  it('rejects duplicate routes', () => {
    expect(() => validators.validateUseCases([useCases[0], useCases[0]])).toThrow('Duplicate slug');
  });

  it.each([
    { path: 'docs/DOES-NOT-EXIST.md', label: 'Missing evidence' },
    { path: '../README.md', label: 'Outside repository' },
    { path: 'https://example.com/claim', label: 'External claim' },
    { path: 'docs/CLI.md', label: '' },
  ])('rejects invalid evidence: $path ($label)', (source) => {
    expect(() => validators.validateSource(source)).toThrow();
  });

  it('keeps new use-case files free of em dashes', () => {
    for (const file of [
      'web/lib/use-cases.ts',
      'web/components/UseCasePage.tsx',
      'web/app/use-cases/[slug]/page.tsx',
    ]) {
      expect(readFileSync(resolve(root, file), 'utf8'), file).not.toContain('\u2014');
    }
  });
});

describe('sitemap namespace', () => {
  it('requires the standard namespace identifier', () => {
    const document = {
      documentElement: { localName: 'urlset', namespaceURI: 'http://www.sitemaps.org/schemas/sitemap/0.9' },
      getElementsByTagNameNS: () => [],
    };
    expect(() => validators.validateSitemap(document, [])).not.toThrow();
    document.documentElement.namespaceURI = 'https://www.sitemaps.org/schemas/sitemap/0.9';
    expect(() => validators.validateSitemap(document, [])).toThrow('Sitemap namespace is invalid');
  });
});

describe('canonical acceptance guard', () => {
  it('rejects a rendered claim whose source link was removed', () => {
    const pathname = '/use-cases/voice-coding';
    const nodes: Record<string, unknown[]> = {
      'link[rel="canonical"]': [{ getAttribute: () => `https://lexicon.ashlr.ai${pathname}` }],
      h1: [{}],
      '[data-claim]': [{ querySelectorAll: () => [] }],
    };
    const document = {
      querySelectorAll: (selector: string) => nodes[selector] ?? [],
      querySelector: () => ({ textContent: 'Guide', getAttribute: () => 'Description' }),
    };
    expect(() => validators.validatePage(document, pathname, [])).toThrow('claim has no source link');
  });

  it('rejects a page without a canonical', () => {
    const document = { querySelectorAll: () => [] };
    expect(() => validators.validatePage(document, '/use-cases/voice-coding', [])).toThrow('exactly one canonical');
  });

  it('rejects duplicate canonical elements', () => {
    const document = { querySelectorAll: () => [{}, {}] };
    expect(() => validators.validatePage(document, '/', [])).toThrow('exactly one canonical');
  });

  it.each(['/', 'https://lexicon.ashlr.ai', 'https://example.com/use-cases/voice-coding'])('rejects incorrect canonical %s', (href) => {
    const document = { querySelectorAll: () => [{ getAttribute: () => href }] };
    expect(() => validators.validatePage(document, '/use-cases/voice-coding', [])).toThrow('absolute and self-referencing');
  });

});
