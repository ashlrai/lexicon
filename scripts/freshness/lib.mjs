#!/usr/bin/env node
/**
 * Freshness engine: the shared core behind `fresh:sync` and `fresh:check`.
 *
 * Some doc content is a claim about the current release -- a badge, an install
 * line pinned to a version, a table of releases, an example pin like
 * `github:ashlrai/lexicon#vX.Y.Z`. Left alone it rots: README carried `#v0.4.0`
 * through two releases, and the release checklist (docs/RELEASING.md) grew a
 * row whose only job is remembering to bump that pin by hand.
 *
 * A block a generator owns is marked in the doc itself:
 *
 *     <!-- fresh:begin pin:github -->
 *     `npm i -g github:ashlrai/lexicon#v0.5.6`
 *     <!-- fresh:end -->
 *
 * (markers in this file are never scanned: scripts/ is not a scan root).
 * Both markers on one line make an inline block, which replaces just the text
 * between them.
 *
 * Ground truth, same sources as `check:facts` and `check:server-json`:
 *   package.json `version`      the source version, `truth.source`
 *   CHANGELOG.md `## X.Y.Z (date)` sections, newest first, `truth.releases`
 *   the first of those is `truth.latest`; `## X.Y.Z (unreleased)` and the
 *   `## Unreleased` heading are records of work in flight, not a release
 *
 * Which truth a generator reads is deliberate: `#vX.Y.Z` names the git tag this
 * source tree becomes, so it tracks package.json (and `check:facts` fails on
 * any other value); an npm `@x.y.z` pin or a badge advertises what is actually
 * released, so it tracks the latest dated CHANGELOG section.
 *
 * Known block names:
 *   badge:release    shields badge -> GitHub releases, latest released version
 *   badge:npm        shields badge -> the npm package, latest released version
 *   install:npm      fenced `npm install -g @ashlr/lexicon@<latest>`
 *   install:github   fenced `npm install -g github:ashlrai/lexicon#v<source>`
 *   table:releases   `| Version | Released |` over CHANGELOG; `:N` caps at N rows
 *   pin:npm          inline code span, npm install pinned to <latest>
 *   pin:github       inline code span, git-tag install pinned to <source>
 *   pin:tag          bare `v<source>`
 *   pin:version      bare <source> (the version the release checklist bumps)
 *   pin:latest       bare <latest released>
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Markers live in prose and doc comments, so scan every text-capable file under the doc roots. */
const SCAN_ROOTS = ['README.md', 'llms-install.md', 'CHANGELOG.md', 'docs', 'examples'];
const TEXT_FILE = /\.(md|mdx|markdown|txt|html|ts|tsx|js|mjs|cjs|json|jsonc|ya?ml)$/i;
const SKIP_DIR = /^(node_modules|dist|\.next|\.build|\.git)$/;

const MARKER = /<!--\s*fresh:(begin|end)(?:\s+([A-Za-z][\w:-]*))?\s*-->/g;

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

/**
 * `{ source, latest, latestDate, releases }`. `source` is package.json's
 * version; `releases` is every dated `## X.Y.Z` section of CHANGELOG.md,
 * newest first. A section dated `(unreleased)` is skipped: it is being written
 * now, not shipped. No releases at all is only an error when a generator needs
 * one -- truth loading stays usable for a source-only fixture.
 */
export function loadTruth(root = repoRoot) {
  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) throw new Error(`${pkgPath} is missing`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (typeof pkg.version !== 'string' || !pkg.version) {
    throw new Error(`${pkgPath} has no "version" string`);
  }

  const releases = [];
  const changelogPath = path.join(root, 'CHANGELOG.md');
  if (existsSync(changelogPath)) {
    const text = readFileSync(changelogPath, 'utf8');
    const heading = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?\s*(?:\(([^)]*)\)|-\s*(\S+))?\s*$/gm;
    for (const m of text.matchAll(heading)) {
      const label = (m[2] ?? m[3] ?? '').trim();
      if (/unreleased/i.test(label)) continue;
      releases.push({ version: m[1], date: /^\d{4}-\d{2}-\d{2}$/.test(label) ? label : null });
    }
  }
  return {
    source: pkg.version,
    latest: releases[0]?.version ?? null,
    latestDate: releases[0]?.date ?? null,
    releases,
  };
}

function needLatest(truth, name) {
  if (!truth.latest) {
    throw new Error(`fresh block '${name}' needs a released section (## X.Y.Z (YYYY-MM-DD)) in CHANGELOG.md and found none`);
  }
  return truth.latest;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const GENERATORS = {
  badge: {
    inline: true,
    variants: {
      release: (t) =>
        `[![release](https://img.shields.io/badge/release-v${needLatest(t, 'badge:release')}-blue)](https://github.com/ashlrai/lexicon/releases)`,
      npm: (t) =>
        `[![npm](https://img.shields.io/badge/npm-v${needLatest(t, 'badge:npm')}-blue)](https://www.npmjs.com/package/@ashlr/lexicon)`,
    },
    default: 'release',
  },
  install: {
    inline: false,
    variants: {
      npm: (t) => `\`\`\`bash\nnpm install -g @ashlr/lexicon@${needLatest(t, 'install:npm')}\n\`\`\``,
      github: (t) => `\`\`\`bash\nnpm install -g github:ashlrai/lexicon#v${t.source}\n\`\`\``,
    },
    default: 'npm',
  },
  table: {
    inline: false,
    variants: {
      releases: (t, limit) => {
        const rows = limit === undefined ? t.releases : t.releases.slice(0, limit);
        if (rows.length === 0) needLatest(t, 'table:releases'); // throws the helpful error
        const body = rows.map((r) => `| ${r.version} | ${r.date ?? 'unreleased'} |`).join('\n');
        return `| Version | Released |\n|---|---|\n${body}`;
      },
    },
    default: 'releases',
  },
  pin: {
    inline: true,
    variants: {
      npm: (t) => `\`npm i -g @ashlr/lexicon@${needLatest(t, 'pin:npm')}\``,
      github: (t) => `\`npm i -g github:ashlrai/lexicon#v${t.source}\``,
      tag: (t) => `v${t.source}`,
      version: (t) => t.source,
      latest: (t) => needLatest(t, 'pin:latest'),
    },
    default: 'version',
  },
};

/** Every accepted marker name, for error messages and `--list`. */
export function blockNames() {
  const names = [];
  for (const [type, spec] of Object.entries(GENERATORS)) {
    for (const variant of Object.keys(spec.variants)) names.push(`${type}:${variant}`);
  }
  return names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Render one block's replacement text. `name` is the marker's `type:variant`
 * (a bare `type` uses its default variant); a third segment is the variant's
 * argument (only `table:releases:N` takes one, the row cap).
 */
export function renderBlock(name, truth) {
  const [type, variant, arg] = name.split(':');
  const spec = GENERATORS[type];
  if (!spec) throw new Error(`unknown fresh block '${name}'. Known: ${blockNames().join(', ')}`);
  const render = spec.variants[variant ?? spec.default];
  if (!render) {
    throw new Error(`unknown fresh block '${name}'. '${type}' variants: ${Object.keys(spec.variants).join(', ')}`);
  }
  let limit;
  if (arg !== undefined) {
    limit = Number(arg);
    if (!/^\d+$/.test(arg) || !(limit >= 1)) {
      throw new Error(`fresh block '${name}' takes a positive integer argument, got '${arg}'`);
    }
  }
  return { text: render(truth, limit), inline: spec.inline };
}

// ---------------------------------------------------------------------------
// Marker engine
// ---------------------------------------------------------------------------

/** 1-based line number of offset `i` in `text`. */
function lineAt(text, i) {
  let n = 1;
  for (let k = 0; k < i && k < text.length; k += 1) if (text[k] === '\n') n += 1;
  return n;
}

/**
 * Regenerate every marked block in `text`. Returns
 * `{ text, blocks, problems }`: `blocks` is one entry per marker pair
 * (`{ name, line, stale }`), `problems` one `{ line, message }` per malformed
 * marker. The file text is only changed where a block's content differs.
 */
export function applyMarkers(text, truth) {
  // Git can check docs out as CRLF; generated regions must keep that style.
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const problems = [];
  const blocks = [];
  let out = '';
  let cursor = 0;
  let open = null; // { name, markStart, contentStart, line }
  MARKER.lastIndex = 0;
  let m;
  while ((m = MARKER.exec(text)) !== null) {
    const [full, kind, name] = m;
    const line = lineAt(text, m.index);
    if (kind === 'begin') {
      if (!name) {
        problems.push({ line, message: 'fresh:begin needs a block name: <!-- fresh:begin pin:github -->' });
        // Consume the matching end silently; one problem per broken pair.
        open = { name: null, markStart: m.index, contentStart: m.index + full.length, line };
      } else if (open) {
        problems.push({ line, message: `fresh:begin '${name}' opens inside '${open.name}' (line ${open.line}); blocks do not nest` });
      } else {
        open = { name, markStart: m.index, contentStart: m.index + full.length, line };
      }
      continue;
    }
    // kind === 'end'
    if (!open) {
      problems.push({ line, message: 'fresh:end without a matching fresh:begin' });
      continue;
    }
    const endLine = lineAt(text, m.index + full.length);
    const oldRegion = text.slice(open.contentStart, m.index);
    if (open.name === null) {
      open = null;
      continue;
    }
    let newRegion;
    try {
      const { text: rendered, inline } = renderBlock(open.name, truth);
      const sameLine = open.line === endLine;
      if (sameLine && !inline) {
        throw new Error(`'${open.name}' generates a multi-line block; put fresh:begin and fresh:end on their own lines`);
      }
      newRegion = sameLine ? rendered : eol + rendered.replace(/\n/g, eol) + eol;
    } catch (err) {
      problems.push({ line: open.line, message: err.message });
      open = null;
      continue;
    }
    out += text.slice(cursor, open.contentStart) + newRegion;
    cursor = m.index;
    blocks.push({ name: open.name, line: open.line, stale: oldRegion !== newRegion });
    open = null;
  }
  if (open) problems.push({ line: open.line, message: `unclosed fresh:begin '${open.name}'` });
  out += text.slice(cursor);
  return { text: out, blocks, problems };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) {
    if (TEXT_FILE.test(rel)) out.push(rel);
    return;
  }
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIR.test(entry.name)) continue;
    walk(root, path.join(rel, entry.name), out);
  }
}

/** Relative paths of every file under the scan roots that carries a marker. */
export function markedFiles(root = repoRoot) {
  const all = [];
  for (const rel of SCAN_ROOTS) walk(root, rel, all);
  return all
    .filter((rel) => {
      try {
        return readFileSync(path.join(root, rel), 'utf8').includes('fresh:');
      } catch {
        return false;
      }
    })
    // Report portable paths, then sort the representation callers receive.
    .map((rel) => rel.split(path.sep).join('/'))
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Scan the doc roots and regenerate every marked block in memory. Returns
 * `{ truth, files, problems }`: one `files` entry per marked file with its
 * regenerated `text` and per-block `stale` flags; `problems` collects malformed
 * markers and unreadable inputs as `{ file, line, message }`.
 */
export function planFreshness(root = repoRoot) {
  const truth = loadTruth(root);
  const files = [];
  const problems = [];
  for (const rel of markedFiles(root)) {
    const abs = path.join(root, rel);
    const { text, blocks, problems: fileProblems } = applyMarkers(readFileSync(abs, 'utf8'), truth);
    files.push({ file: rel, path: abs, text, blocks });
    for (const p of fileProblems) problems.push({ file: rel, ...p });
  }
  return { truth, files, problems };
}

/** Shared CLI argument handling: `--root <dir>`, plus the flags each script names. */
export function parseArgs(argv, extraFlags = []) {
  const opts = { root: repoRoot, flags: new Set() };
  const known = new Set(['--root', '--help', ...extraFlags]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--root needs a directory argument');
      opts.root = path.resolve(value);
      i += 1;
    } else if (arg.startsWith('--root=')) {
      opts.root = path.resolve(arg.slice('--root='.length));
    } else if (arg === '--help') {
      opts.help = true;
    } else if (known.has(arg)) {
      opts.flags.add(arg);
    } else {
      throw new Error(`unknown argument '${arg}'`);
    }
  }
  return opts;
}
