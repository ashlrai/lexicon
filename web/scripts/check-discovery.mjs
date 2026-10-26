#!/usr/bin/env node
/**
 * The discoverability check: validates the built site the way an agent or an
 * answer engine meets it. Run after `npm run build`:
 *
 *   npm run check:discovery           # check .next/server/app
 *   npm run check:discovery -- --stage /tmp/site   # also copy the public
 *                                                # surface to /tmp/site with
 *                                                # its real URL file names
 *
 * What it asserts, per emitted page and per machine payload:
 *
 *   every page       one absolute <link rel="canonical">, exactly one <h1>,
 *                    no skipped heading levels, <title>, meta description,
 *                    og:title/description/type/url/image, twitter:card, and
 *                    every application/ld+json block parses
 *   JSON-LD          a named SoftwareApplication whose softwareVersion matches
 *                    the repo's package.json, with license, codeRepository,
 *                    operatingSystem and a truthful price-0 offer
 *   llms.txt family  H1, at least one ## section, 3+ markdown links, no em-dash
 *   sitemap.xml      <urlset> of absolute <loc>s, each landing on a built page
 *   robots.txt       declares Sitemap:
 *   capabilities.json   parses, 2+ of name/version/description/capabilities/
 *                       install/commands/tools
 *   server.json      parses, namespaced name + description + version +
 *                    packages or remotes, at /server.json and
 *                    /.well-known/mcp/server.json
 *   AGENTS.md        400+ bytes, 2+ headings
 *   mcp.json         parses; .mcpServers.lexicon.command is lexicon-mcp
 *
 * Exits 1 with one line per failure. This is the site's half of the
 * agent-readiness rubric (phantom docs/AGENT-READINESS.md) enforced in-tree.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '..');
const appDir = resolve(web, '.next/server/app');

const argv = process.argv.slice(2);
const stageAt = argv.includes('--stage') ? argv[argv.indexOf('--stage') + 1] : null;

if (!existsSync(appDir)) {
  process.stderr.write(
    `${relative(web, appDir)} does not exist. Run \`npm run build\` first; this checks built output.\n`,
  );
  process.exit(1);
}

const SITE_URL = 'https://lexicon.ashlr.ai';
const EM_DASH = /\u2014|&mdash;/;

// ---------------------------------------------------------------------------
// What Next emitted. Static pages are `name.html`; prerendered route-handler
// payloads are `name.body` beside a `name/` directory holding the route code.
// ---------------------------------------------------------------------------

/** Every built file, as repo-slash paths relative to appDir. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const allFiles = walk(appDir);

/**
 * The public surface: pages are the .html files minus Next's internal
 * error pages (_not-found, _global-error are plumbing, not content);
 * payloads are the .body files whose public name is the directory basename.
 */
const pages = allFiles
  .filter((f) => f.endsWith('.html'))
  .map((f) => ({ file: f, name: relative(appDir, f) }))
  .filter((p) => !p.name.split('/').some((seg) => seg.startsWith('_')));

const payloads = new Map();
for (const f of allFiles) {
  if (!f.endsWith('.body')) continue;
  const rel = relative(appDir, f).replace(/\.body$/, '');
  const publicName = rel.replace(/\/route\.js$/, '');
  // `.next/server/app/llms.txt.body` serves /llms.txt; nested routes serve
  // under their directories: `.well-known/mcp/server.json.body`.
  payloads.set(publicName, f);
}

const readBody = (name) => {
  const f = payloads.get(name);
  return f ? readFileSync(f, 'utf8') : undefined;
};

// ---------------------------------------------------------------------------
// Check harness: each check returns findings; empty means pass.
// ---------------------------------------------------------------------------
const results = [];
const check = (name, fn) => {
  const findings = [];
  const fail = (message) => findings.push(message);
  try {
    fn(fail);
  } catch (err) {
    findings.push(`${name} threw: ${err.message}`);
  }
  results.push({ name, findings });
};

const metaContent = (html, key) => {
  const m =
    new RegExp(`<meta[^>]+name="${key}"[^>]+content="([^"]*)"`, 'i').exec(html) ??
    new RegExp(`<meta[^>]+property="${key}"[^>]+content="([^"]*)"`, 'i').exec(html) ??
    new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:name|property)="${key}"`, 'i').exec(html);
  return m ? m[1] : undefined;
};

const canonicalHrefs = (html) =>
  [...html.matchAll(/<link\b[^>]*rel="canonical"[^>]*>/gi)].map((m) => {
    const h = /href="([^"]*)"/i.exec(m[0]);
    return h ? h[1] : '';
  });

const jsonLdBlocks = (html) =>
  [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => m[1],
  );

/** Every node in a JSON-LD value, through @graph and nested objects/arrays. */
function* jsonLdNodes(value) {
  if (Array.isArray(value)) {
    for (const v of value) yield* jsonLdNodes(v);
  } else if (value && typeof value === 'object') {
    yield value;
    for (const v of Object.values(value)) {
      if (v && typeof v === 'object') yield* jsonLdNodes(v);
    }
  }
}

const headingLevels = (html) =>
  [...html.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]));

// ---------------------------------------------------------------------------
// Per-page checks
// ---------------------------------------------------------------------------
let sawSoftwareApplication = null;

check('pages: one canonical, one h1, ordered headings, full meta', (fail) => {
  if (!pages.length) fail('no emitted .html pages found');
  for (const { file, name } of pages) {
    const html = readFileSync(file, 'utf8');
    const canonical = canonicalHrefs(html);
    if (canonical.length !== 1) {
      fail(`${name}: ${canonical.length} canonical link(s), expected 1`);
    } else if (!/^https:\/\/\S+$/.test(canonical[0])) {
      fail(`${name}: canonical "${canonical[0]}" is not an absolute https URL`);
    } else if (!canonical[0].startsWith(SITE_URL)) {
      fail(`${name}: canonical "${canonical[0]}" is outside ${SITE_URL}`);
    }

    const levels = headingLevels(html);
    const h1s = levels.filter((l) => l === 1).length;
    if (h1s !== 1) fail(`${name}: ${h1s} <h1> element(s), expected 1`);
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] > levels[i - 1] + 1) {
        fail(`${name}: heading level skips from h${levels[i - 1]} to h${levels[i]}`);
        break;
      }
    }

    for (const [label, ok] of [
      ['<title>', /<title[^>]*>[^<]*\S[^<]*<\/title>/i.test(html)],
      ['meta description', !!metaContent(html, 'description')],
      ['og:title', !!metaContent(html, 'og:title')],
      ['og:description', !!metaContent(html, 'og:description')],
      ['og:type', !!metaContent(html, 'og:type')],
      ['og:url', !!metaContent(html, 'og:url')],
      ['og:image', !!metaContent(html, 'og:image')],
      ['twitter:card', !!metaContent(html, 'twitter:card')],
    ]) {
      if (!ok) fail(`${name}: missing ${label}`);
    }

    for (const block of jsonLdBlocks(html)) {
      let parsed;
      try {
        parsed = JSON.parse(block);
      } catch (err) {
        fail(`${name}: a JSON-LD block does not parse (${err.message})`);
        continue;
      }
      for (const node of jsonLdNodes(parsed)) {
        const types = [].concat(node['@type'] ?? []).map((t) => String(t).toLowerCase());
        if (
          ['softwareapplication', 'webapplication', 'mobileapplication'].some((t) => types.includes(t)) &&
          node.name
        ) {
          sawSoftwareApplication = node;
        }
      }
    }
  }
});

check('JSON-LD: named SoftwareApplication, truthful fields', (fail) => {
  if (!sawSoftwareApplication) {
    fail('no named SoftwareApplication/WebApplication in any JSON-LD block');
    return;
  }
  const app = sawSoftwareApplication;
  const pkg = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8'));
  if (app.softwareVersion !== pkg.version) {
    fail(`softwareVersion "${app.softwareVersion}" != package.json ${pkg.version}`);
  }
  if (!app.license) fail('SoftwareApplication has no license');
  if (app.license && !String(pkg.license).length) fail('package.json has no license to compare');
  if (app.codeRepository !== pkg.repository?.url?.replace(/^git\+|\.git$/g, '')) {
    fail(`codeRepository "${app.codeRepository}" does not match package.json repository`);
  }
  if (!app.operatingSystem) fail('SoftwareApplication has no operatingSystem');
  const price = app.offers?.price;
  const isFree = pkg.license === 'MIT';
  if (isFree && price !== 0 && price !== '0') {
    fail(`offers.price is ${JSON.stringify(price)}; the package is MIT, so it must be 0`);
  }
  if (!isFree && (price === 0 || price === '0')) {
    fail('offers claims price 0 but the package is not free; remove the offer');
  }
});

// ---------------------------------------------------------------------------
// Machine payloads
// ---------------------------------------------------------------------------
const mdLinks = (text) => (text.match(/\[[^\]]+\]\(https?:[^)\s]+\)/g) ?? []).length;

for (const name of ['llms.txt', 'llms-full.txt']) {
  check(`${name}: index shape`, (fail) => {
    const text = readBody(name);
    if (text === undefined) return fail(`${name} was not emitted by the build`);
    if (!/(^|\n)#\s+\S/.test(text.slice(0, 4000))) fail('no H1 title');
    if (!/(^|\n)##\s+\S/.test(text)) fail('no ## section headings');
    const links = mdLinks(text);
    if (links < 3) fail(`only ${links} markdown link(s)`);
    if (EM_DASH.test(text)) fail('contains an em-dash; the repo rule is none');
  });
}

check('llms.txt: generated from the docs headings', (fail) => {
  const text = readBody('llms-full.txt');
  if (text === undefined) return fail('llms-full.txt missing');
  const docs = readdirSync(resolve(repo, 'docs')).filter((f) => f.endsWith('.md'));
  const missing = docs.filter((f) => !text.includes(`docs/${f}`));
  if (missing.length) fail(`doc(s) not in the generated map: ${missing.join(', ')}`);
  if (!/##\s+README map/.test(text)) fail('no README map section');
  if (!/##\s+Documentation map/.test(text)) fail('no Documentation map section');
});

check('sitemap.xml: valid urlset over real pages', (fail) => {
  const xml = readBody('sitemap.xml');
  if (xml === undefined) return fail('sitemap.xml was not emitted');
  if (!/<urlset\b/i.test(xml) && !/<sitemapindex\b/i.test(xml)) fail('no <urlset> or <sitemapindex>');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map((m) => m[1].trim());
  if (!locs.length) fail('no <loc> entries');
  const pageUrls = new Set(
    pages.map((p) => {
      const rel = p.name.replace(/\.html$/, '');
      return rel === 'index' ? `${SITE_URL}` : `${SITE_URL}/${rel.replace(/\/index$/, '')}`;
    }),
  );
  for (const loc of locs) {
    if (!/^https:\/\/\S+$/.test(loc)) fail(`<loc> ${loc} is not absolute https`);
    if (!loc.startsWith(SITE_URL)) fail(`<loc> ${loc} is outside ${SITE_URL}`);
    if (!pageUrls.has(loc)) fail(`<loc> ${loc} has no built page`);
  }
  for (const u of pageUrls) {
    if (!locs.includes(u)) fail(`built page ${u} is not in the sitemap`);
  }
});

check('robots.txt: declares the sitemap', (fail) => {
  const text = readBody('robots.txt');
  if (text === undefined) return fail('robots.txt was not emitted');
  if (!/^sitemap:\s*\S+/im.test(text)) fail('no Sitemap: line');
});

check('mcp.json: mergeable install manifest', (fail) => {
  const text = readBody('mcp.json');
  if (text === undefined) return fail('mcp.json was not emitted');
  const value = JSON.parse(text);
  if (value?.mcpServers?.lexicon?.command !== 'lexicon-mcp') {
    fail('mcpServers.lexicon.command is not lexicon-mcp');
  }
});

check('capabilities.json: machine-readable capabilities', (fail) => {
  const text = readBody('capabilities.json');
  if (text === undefined) return fail('capabilities.json was not emitted');
  const value = JSON.parse(text);
  const keys = ['name', 'version', 'description', 'capabilities', 'install', 'commands', 'tools']
    .filter((k) => value[k] !== undefined);
  if (keys.length < 2) fail(`declares only ${keys.join(', ') || 'nothing'}`);
});

for (const name of ['server.json', '.well-known/mcp/server.json']) {
  check(`${name}: MCP registry manifest`, (fail) => {
    const text = readBody(name);
    if (text === undefined) return fail(`${name} was not emitted`);
    const value = JSON.parse(text);
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\/[a-z0-9][a-z0-9._-]*$/i.test(value?.name ?? '')) {
      fail(`name "${value?.name}" is not namespace/name form`);
    }
    for (const k of ['description', 'version']) {
      if (typeof value?.[k] !== 'string' || !value[k].trim()) fail(`missing ${k}`);
    }
    const packages = Array.isArray(value?.packages) ? value.packages.length : 0;
    const remotes = Array.isArray(value?.remotes) ? value.remotes.length : 0;
    if (!packages && !remotes) fail('no packages or remotes');
    const source = JSON.parse(readFileSync(resolve(repo, 'server.json'), 'utf8'));
    if (value.name !== source.name || value.version !== source.version) {
      fail('does not match the repository server.json');
    }
  });
}

check('AGENTS.md: install instructions for agents', (fail) => {
  const text = readBody('AGENTS.md');
  if (text === undefined) return fail('AGENTS.md was not emitted');
  if (text.length < 400) fail(`only ${text.length} bytes`);
  const headings = (text.match(/(^|\n)#{1,3}\s+\S/g) ?? []).length;
  if (headings < 2) fail(`only ${headings} heading(s)`);
});

check('payloads: no em-dashes in machine text', (fail) => {
  for (const name of ['llms.txt', 'llms-full.txt', 'capabilities.json', 'server.json', 'mcp.json']) {
    const text = readBody(name);
    if (text !== undefined && EM_DASH.test(text)) fail(`${name} contains an em-dash`);
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let failures = 0;
for (const { name, findings } of results) {
  if (findings.length) {
    failures += findings.length;
    process.stdout.write(`FAIL ${name}\n${findings.map((f) => `     ${f}`).join('\n')}\n`);
  } else {
    process.stdout.write(`ok   ${name}\n`);
  }
}

if (stageAt) {
  const dest = resolve(stageAt);
  mkdirSync(dest, { recursive: true });
  for (const { file, name } of pages) copyFileSync(file, resolve(dest, name));
  for (const [name, file] of payloads) {
    const target = resolve(dest, name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
  process.stdout.write(`staged ${pages.length} page(s) and ${payloads.size} payload(s) at ${dest}\n`);
}

if (failures) {
  process.stderr.write(`check-discovery: ${failures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write(`check-discovery: all checks passed over ${pages.length} page(s)\n`);
