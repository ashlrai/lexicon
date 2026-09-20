#!/usr/bin/env node
/**
 * Relative-link checker for the markdown in this repo.
 *
 * Walks README.md, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, CLAUDE.md
 * and every docs/*.md, and checks that each relative markdown link resolves:
 * the file exists on disk, and when the link carries a `#fragment` the target
 * document actually has a heading (or an explicit anchor) with that slug.
 *
 * Absolute URLs, mailto: and protocol-relative links are not fetched; they are
 * only counted. Exits 1 and prints one line per broken link.
 *
 * Usage: node scripts/check-links.mjs [--verbose]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

/** Every .md under dir, recursively, as paths relative to the repo root. (No fs.globSync: Node 20.) */
function markdownUnder(dir) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownUnder(rel));
    else if (/\.md$/i.test(entry.name)) out.push(rel);
  }
  return out.sort();
}

/** Files whose links we check. */
function targets() {
  const out = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CLAUDE.md', 'CHANGELOG.md'];
  out.push(...markdownUnder('docs'), ...markdownUnder('.github'), ...markdownUnder('examples'), ...markdownUnder('bench'));
  return out.filter((f) => existsSync(path.join(root, f)));
}

/** GitHub's heading slug: lowercase, strip anything but word chars/space/dash, spaces to dashes. */
function slug(heading) {
  return heading
    .trim()
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ +/g, '-');
}

const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const set = new Set();
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    anchorCache.set(file, set);
    return set;
  }
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (h) {
      const base = slug(h[2]);
      // GitHub de-duplicates repeated headings with -1, -2, ...
      let s = base;
      let n = 1;
      while (set.has(s)) s = `${base}-${n++}`;
      set.add(s);
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(m[1].toLowerCase());
  }
  anchorCache.set(file, set);
  return set;
}

/** Markdown links and images, minus fenced code blocks and inline code spans. */
function linksIn(text) {
  const out = [];
  let fenced = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const stripped = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    for (const m of stripped.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      out.push({ target: m[1], line: i + 1 });
    }
  }
  return out;
}

let checked = 0;
let external = 0;
const broken = [];

for (const rel of targets()) {
  const file = path.join(root, rel);
  const dir = path.dirname(file);
  for (const { target, line } of linksIn(readFileSync(file, 'utf8'))) {
    if (/^(https?:|mailto:|tel:|data:|#|\/\/)/i.test(target)) {
      if (target.startsWith('#')) {
        checked++;
        const frag = decodeURIComponent(target.slice(1)).toLowerCase();
        if (!anchorsOf(file).has(frag)) broken.push(`${rel}:${line}  no such heading in this file: ${target}`);
      } else {
        external++;
      }
      continue;
    }
    checked++;
    const [rawPath, rawFrag] = target.split('#');
    const abs = path.resolve(dir, decodeURIComponent(rawPath));
    if (!existsSync(abs)) {
      broken.push(`${rel}:${line}  missing file: ${target}`);
      continue;
    }
    if (rawFrag) {
      if (statSync(abs).isDirectory()) continue;
      if (!/\.md$/i.test(abs)) continue;
      const frag = decodeURIComponent(rawFrag).toLowerCase();
      if (!anchorsOf(abs).has(frag)) broken.push(`${rel}:${line}  no such heading in ${path.relative(root, abs)}: #${rawFrag}`);
    }
    if (verbose) console.log(`ok  ${rel}:${line}  ${target}`);
  }
}

console.log(`check-links: ${targets().length} files, ${checked} relative links checked, ${external} external links skipped`);
if (broken.length) {
  console.error(`\n${broken.length} broken link${broken.length === 1 ? '' : 's'}:`);
  for (const b of broken) console.error(`  ${b}`);
  process.exit(1);
}
console.log('check-links: all relative links resolve');
