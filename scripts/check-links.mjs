#!/usr/bin/env node
/**
 * Relative-link checker for the markdown in this repo.
 *
 * Walks every root-level *.md (README.md, AGENTS.md, INTEGRATION.md, the
 * design notes, ...) plus CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md,
 * CLAUDE.md and every docs/*.md, and checks that each relative markdown link
 * resolves: the file exists on disk, and when the link carries a `#fragment`
 * the target document actually has a heading (or an explicit anchor) with
 * that slug.
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

/** Every .md under dir, recursively, as paths relative to rootDir. (No fs.globSync: Node 20.) */
function markdownUnder(rootDir, dir) {
  const abs = path.join(rootDir, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownUnder(rootDir, rel));
    else if (/\.md$/i.test(entry.name)) out.push(rel);
  }
  return out.sort();
}

/**
 * Files whose links we check: every markdown file at the repository root (the
 * fixed list used to miss INTEGRATION.md, AGENTS.md and the design notes, so
 * their links could rot unchecked) plus the doc trees.
 */
export function targets(rootDir = root) {
  const out = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isFile() && /\.md$/i.test(entry.name)) out.push(entry.name);
  }
  for (const dir of ['docs', '.github', 'examples', 'bench']) out.push(...markdownUnder(rootDir, dir));
  return [...new Set(out)].sort();
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

/** The heading and anchor slugs one markdown file offers link targets. */
export function anchorsOf(file) {
  const set = new Set();
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
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
  return set;
}

/** Markdown links and images, minus fenced code blocks and inline code spans. */
export function linksIn(text) {
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

/**
 * Check every target file under `root` (the repo root by default; tests pass a
 * fixture). Returns `{ files, checked, external, broken }` where `broken` is a
 * list of human-readable lines, empty when every relative link resolves.
 */
export function check(rootDir = root) {
  const anchorCache = new Map();
  const anchors = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(file));
    return anchorCache.get(file);
  };
  let checked = 0;
  let external = 0;
  const broken = [];
  const files = targets(rootDir);
  for (const rel of files) {
    const file = path.join(rootDir, rel);
    const dir = path.dirname(file);
    for (const { target, line } of linksIn(readFileSync(file, 'utf8'))) {
      if (/^(https?:|mailto:|tel:|data:|#|\/\/)/i.test(target)) {
        if (target.startsWith('#')) {
          checked++;
          const frag = decodeURIComponent(target.slice(1)).toLowerCase();
          if (!anchors(file).has(frag)) broken.push(`${rel}:${line}  no such heading in this file: ${target}`);
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
        if (!anchors(abs).has(frag)) broken.push(`${rel}:${line}  no such heading in ${path.relative(rootDir, abs)}: #${rawFrag}`);
      }
      if (verbose) console.log(`ok  ${rel}:${line}  ${target}`);
    }
  }
  return { files: files.length, checked, external, broken };
}

export function main(rootDir = root) {
  const { files, checked, external, broken } = check(rootDir);
  console.log(`check-links: ${files} files, ${checked} relative links checked, ${external} external links skipped`);
  if (broken.length) {
    console.error(`\n${broken.length} broken link${broken.length === 1 ? '' : 's'}:`);
    for (const b of broken) console.error(`  ${b}`);
    return 1;
  }
  console.log('check-links: all relative links resolve');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
