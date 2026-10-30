#!/usr/bin/env node
/** Verify a production build, including the actual HTML and serialized sitemap.
 * Requires Node 22+ and the repository's existing jsdom dev dependency.
 * Usage: node web/scripts/check-seo.mjs http://127.0.0.1:3000
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const site = 'https://lexicon.ashlr.ai';
const sourcePrefix = 'https://github.com/ashlrai/lexicon/blob/main/';

/** Fail closed: a label or URL alone is not evidence of an existing source. */
export function validateSource(source) {
  assert.equal(typeof source?.path, 'string', 'A claim source needs a repository path');
  assert(source.path.length > 0 && !source.path.includes('..'), 'Source path must stay in the repository');
  assert(/^(docs\/|bench\/|src\/|tests\/|examples\/|packs\/|SECURITY\.md$|README\.md$)/.test(source.path), `Unsupported source: ${source.path}`);
  const file = resolve(root, source.path);
  assert(file.startsWith(`${root}${sep}`), 'Source escaped the repository');
  assert(existsSync(file) && statSync(file).isFile(), `Missing source: ${source.path}`);
  assert(readFileSync(file, 'utf8').trim().length > 0, `Empty source: ${source.path}`);
  assert(typeof source.label === 'string' && source.label.trim().length > 0, 'Source needs an accessible label');
}

export function validateUseCases(guides) {
  assert(guides.length >= 2 && guides.length <= 4, 'Expected two to four distinct use cases');
  for (const field of ['slug', 'title', 'description']) {
    const values = guides.map((guide) => guide[field]);
    assert(values.every((value) => typeof value === 'string' && value.trim().length > 0), `Missing ${field}`);
    assert.equal(new Set(values).size, values.length, `Duplicate ${field}`);
  }
  for (const guide of guides) {
    assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(guide.slug), 'Use-case slug must be a URL segment');
    assert(guide.sections.length >= 2, `${guide.slug}: needs a workflow and limitations`);
    assert.equal(new Set(guide.sections.map((section) => section.id)).size, guide.sections.length, 'Duplicate section id');
    const blocks = [guide.intro, ...guide.sections.flatMap((section) => section.blocks)];
    assert(blocks.some((block) => block.code?.trim()), `${guide.slug}: needs a worked example`);
    for (const block of blocks) {
      assert(typeof block.text === 'string' && block.text.trim(), `${guide.slug}: empty claim`);
      assert(Array.isArray(block.sources) && block.sources.length > 0, `${guide.slug}: claim has no source`);
      block.sources.forEach(validateSource);
    }
    assert(guide.docs.length > 0, `${guide.slug}: needs documentation links`);
    guide.docs.forEach(validateSource);
    assert(!JSON.stringify(guide).includes('\u2014'), `${guide.slug}: em dash in copy`);
  }
}

/** DOM-based checks are shared by live verification and negative fixture tests. */
export function validatePage(document, pathname, guidePaths) {
  const canonical = document.querySelectorAll('link[rel="canonical"]');
  assert.equal(canonical.length, 1, `${pathname}: expected exactly one canonical`);
  assert.equal(canonical[0].getAttribute('href'), `${site}${pathname === '/' ? '' : pathname}`, `${pathname}: canonical must be absolute and self-referencing`);
  assert.equal(document.querySelectorAll('h1').length, 1, `${pathname}: expected one h1`);
  assert(document.querySelector('title')?.textContent.trim(), `${pathname}: missing title`);
  assert(document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim(), `${pathname}: missing description`);
  const claims = [...document.querySelectorAll('[data-claim]')];
  for (const claim of claims) {
    const sources = [...claim.querySelectorAll('a[data-source]')]
      .filter((source) => source.closest('[data-claim]') === claim);
    assert(sources.length > 0, `${pathname}: claim has no source link`);
    for (const source of sources) {
      const href = source.getAttribute('href');
      assert(href?.startsWith(sourcePrefix), `${pathname}: claim source is not a repository link`);
      validateSource({ path: href.slice(sourcePrefix.length), label: source.textContent });
    }
  }
  if (pathname.startsWith('/use-cases/')) {
    assert(claims.length >= 3, `${pathname}: no substantive claim blocks rendered`);
    assert(document.querySelector('a[href="/#install"]'), `${pathname}: install is unreachable`);
    assert(document.querySelector(`a[href^="${sourcePrefix}docs/"]`), `${pathname}: docs are unreachable`);
  }
  for (const guide of guidePaths.filter((path) => path !== pathname)) {
    assert(document.querySelector(`a[href="${guide}"]`), `${pathname}: missing internal link to ${guide}`);
  }
}

export function validateSitemap(document, routes) {
  // This is the standard XML namespace identifier, not a network request.
  const namespace = 'http://www.sitemaps.org/schemas/sitemap/0.9'; // NOSONAR: the identifier must match the sitemap specification.
  assert.equal(document.documentElement.localName, 'urlset', 'Sitemap root must be urlset');
  assert.equal(document.documentElement.namespaceURI, namespace, 'Sitemap namespace is invalid');
  const entries = [...document.getElementsByTagNameNS(namespace, 'url')];
  const urls = entries.map((entry) => {
    const locations = entry.getElementsByTagNameNS(namespace, 'loc');
    assert.equal(locations.length, 1, 'Sitemap entry needs exactly one loc');
    const url = locations[0].textContent;
    const parsed = new URL(url);
    assert.equal(parsed.origin, site, 'Sitemap URL must use the production HTTPS origin');
    assert(!parsed.hash && !parsed.search, 'Sitemap URL cannot have query or fragment');
    const dates = entry.getElementsByTagNameNS(namespace, 'lastmod');
    assert.equal(dates.length, 1, `${url}: expected a Git-derived lastmod in this checkout`);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(dates[0].textContent), `${url}: lastmod must be an ISO timestamp`);
    assert(Number.isFinite(Date.parse(dates[0].textContent)), `${url}: invalid date`);
    return url;
  });
  assert.equal(new Set(urls).size, urls.length, 'Duplicate sitemap URL');
  const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  assert.deepEqual(urls.sort(compareText), routes.map((path) => `${site}${path === '/' ? '' : path}`).sort(compareText), 'Sitemap must cover every built page exactly once');
}

function builtPages(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? builtPages(file) : entry.name.endsWith('.html') ? [file] : [];
  });
}

async function main() {
  const { JSDOM } = await import('jsdom');
  const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:3000');
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Run against a local production server');
  const app = resolve(root, 'web/.next/server/app');
  const routes = builtPages(app)
    .map((file) => relative(app, file).split(sep).join('/').replace(/\.html$/, ''))
    .filter((path) => !path.startsWith('_'))
    .map((path) => path === 'index' ? '/' : `/${path}`);
  assert(routes.includes('/'), 'Build the site before checking SEO');
  const guides = routes.filter((path) => path.startsWith('/use-cases/'));
  assert(guides.length >= 2 && guides.length <= 4, 'Build must include two to four use cases');
  let claims = 0;
  for (const pathname of routes) {
    const response = await fetch(new URL(pathname, origin));
    assert.equal(response.status, 200, `${pathname}: non-200 response`);
    const document = new JSDOM(await response.text()).window.document;
    validatePage(document, pathname, guides);
    claims += document.querySelectorAll('[data-claim]').length;
    for (const anchor of document.querySelectorAll('a[href^="#"]')) {
      const id = decodeURIComponent(anchor.getAttribute('href').slice(1));
      assert(!id || document.getElementById(id), `${pathname}: broken #${id} anchor`);
    }
  }
  const response = await fetch(new URL('/sitemap.xml', origin));
  assert.equal(response.status, 200, 'Sitemap did not return 200');
  const xml = new JSDOM(await response.text(), { contentType: 'application/xml' }).window.document;
  validateSitemap(xml, routes);
  const commitDates = new Set(execFileSync('git', ['log', '--format=%cI'], { cwd: root, encoding: 'utf8' }).trim().split('\n').map(Date.parse));
  for (const date of xml.getElementsByTagName('lastmod')) {
    assert(commitDates.has(Date.parse(date.textContent)), 'Sitemap lastmod does not match a reachable Git commit');
  }
  console.log(`SEO passed: ${routes.length} pages, ${claims} sourced claim blocks, sitemap and canonical coverage.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
