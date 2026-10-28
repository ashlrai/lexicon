#!/usr/bin/env node
/**
 * Lane-side resolver for the files that always conflict and never need a
 * human (or a model) to decide. Run it inside the worktree while a `git
 * merge` or `git rebase` is stopped on conflicts:
 *
 *   node scripts/resolve-merge-conflicts.mjs [--offline] [--dry-run]
 *
 * Strategies, chosen by basename:
 *
 *   CHANGELOG.md            union merge. .gitattributes already wires
 *                           `merge=union` for this file; this path exists for
 *                           trees where the attribute is not yet present (for
 *                           example mid-rebase of the commit that adds it).
 *   CLAUDE.md, README.md    `git merge-file --ours`: main's version wins
 *                           every conflicting hunk and the PR's own hunks are
 *                           re-applied where they still fit. ("Ours" is main
 *                           in both supported flows: rebasing a PR onto main,
 *                           and merging a PR into main.)
 *   package-lock.json,      take main's side of the file, then regenerate with
 *   npm-shrinkwrap.json,    the package manager against the resolved
 *   bun.lock, bun.lockb,    manifest. Lockfiles are never merged by hand.
 *   Cargo.lock              Every `resolved`/source URL in the result must
 *                           stay on registry.npmjs.org (npm, bun) or
 *                           crates.io (cargo); anything else is left
 *                           conflicted. The manifest must come out of the
 *                           regeneration byte-identical: a package manager
 *                           that edits it is refused.
 *
 * Modify/delete conflicts and every other path are left for a human and
 * listed on stderr. Exits 0 only when nothing unmerged remains. --dry-run
 * reports the strategy per file without touching the tree; --offline passes
 * the package manager's offline flag through for network-less lanes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const UNION = 'union';
export const OURS_PLUS = 'ours+theirs-hunks';
export const REGENERATE = 'regenerate';

const DOC_FILES = new Set(['CLAUDE.md', 'README.md']);

const LOCKFILES = new Map([
  ['package-lock.json', { pm: 'npm', manifest: 'package.json' }],
  ['npm-shrinkwrap.json', { pm: 'npm', manifest: 'package.json' }],
  ['bun.lock', { pm: 'bun', manifest: 'package.json' }],
  ['bun.lockb', { pm: 'bun', manifest: 'package.json' }],
  ['Cargo.lock', { pm: 'cargo', manifest: 'Cargo.toml' }],
]);

const MARKER = /^(<{7}|={7}|>{7})/m;

/** Which strategy a conflicted path gets, or null for "leave it conflicted". */
export function classify(rel) {
  const base = path.basename(rel);
  if (base === 'CHANGELOG.md') return UNION;
  if (DOC_FILES.has(base)) return OURS_PLUS;
  if (LOCKFILES.has(base)) return REGENERATE;
  return null;
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function die(msg) {
  console.error(`resolve-merge-conflicts: ${msg}`);
  process.exit(2);
}

/** path -> {1: baseSha, 2: oursSha, 3: theirsSha} for every unmerged file. */
function unmerged(root) {
  const r = git(['ls-files', '-u', '-z'], root);
  if (r.status !== 0) die(`git ls-files -u failed: ${(r.stderr || r.stdout).trim()}`);
  const map = new Map();
  for (const rec of r.stdout.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const parts = rec.slice(0, tab).split(' ');
    const file = rec.slice(tab + 1);
    if (!map.has(file)) map.set(file, {});
    map.get(file)[parts[2]] = parts[1];
  }
  return map;
}

function blob(root, sha) {
  const r = git(['cat-file', 'blob', sha], root);
  if (r.status !== 0) throw new Error(`git cat-file blob ${sha}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

function stage(root, rel) {
  const r = git(['add', '--', rel], root);
  if (r.status !== 0) throw new Error(`git add ${rel}: ${(r.stderr || '').trim()}`);
}

/**
 * `git merge-file -p --<favor> ours base theirs`. Exit status is the count of
 * conflicted hunks even when a favor resolves them, so success means a clean
 * run with no markers left in the output.
 */
function mergeFile(tmp, ours, base, theirs, favor) {
  const file = (name, text) => {
    const p = path.join(tmp, name);
    writeFileSync(p, text);
    return p;
  };
  const r = git(['merge-file', '-p', `--${favor}`, file('ours', ours), file('base', base), file('theirs', theirs)], tmp);
  if (r.error || r.status == null || r.status < 0) return { ok: false, reason: `git merge-file: ${(r.error || r.stderr || '').toString().trim()}` };
  if (MARKER.test(r.stdout)) return { ok: false, reason: 'conflict markers remain after merge' };
  return { ok: true, text: r.stdout };
}

function resolveByMerge(root, tmp, rel, stages, favor, dry) {
  if (!stages['2'] || !stages['3']) return { ok: false, reason: 'modify/delete conflict; keeping it for a human' };
  const merged = mergeFile(tmp, blob(root, stages['2']), stages['1'] ? blob(root, stages['1']) : '', blob(root, stages['3']), favor);
  if (!merged.ok) return merged;
  if (!dry) {
    writeFileSync(path.join(root, rel), merged.text);
    stage(root, rel);
  }
  return { ok: true, note: favor === 'union' ? 'union merge' : "main's version, PR hunks re-applied" };
}

/** Package managers are .cmd shims on Windows, which plain spawn refuses. */
function pmRun(cmd, args, cwd) {
  if (process.platform === 'win32') {
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd, ...args], { cwd, encoding: 'utf8' });
  }
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' });
}

const onPath = (bin) => pmRun(bin, ['--version'], undefined).status === 0;

/**
 * Regenerate a lockfile with its package manager. The resolved side's bytes
 * are already in place, so every manager here treats them as the frozen
 * baseline: npm re-locks only what the manifest demands, bun does the same
 * with --lockfile-only, and cargo first proves the lockfile still satisfies
 * the manifest with --locked before generate-lockfile is allowed to touch it.
 */
function regenerate(pm, dir, offline) {
  if (pm === 'npm') {
    if (!onPath('npm')) return { ran: false, note: 'npm not on PATH; kept the resolved side' };
    const args = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'];
    if (offline) args.push('--offline');
    const r = pmRun('npm', args, dir);
    return r.status === 0 ? { ran: true, note: 'npm install --package-lock-only' } : { ran: false, note: `npm regen failed; kept the resolved side` };
  }
  if (pm === 'bun') {
    if (!onPath('bun')) return { ran: false, note: 'bun not on PATH; kept the resolved side' };
    const r = pmRun('bun', ['install', '--lockfile-only'], dir);
    return r.status === 0 ? { ran: true, note: 'bun install --lockfile-only' } : { ran: false, note: 'bun regen failed; kept the resolved side' };
  }
  if (pm === 'cargo') {
    if (!onPath('cargo')) return { ran: false, note: 'cargo not on PATH; kept the resolved side' };
    const check = pmRun('cargo', ['metadata', '--format-version', '1', '--locked', ...(offline ? ['--offline'] : [])], dir);
    if (check.status === 0) return { ran: true, note: 'cargo metadata --locked (lockfile already satisfies the manifest)' };
    const r = pmRun('cargo', ['generate-lockfile', ...(offline ? ['--offline'] : [])], dir);
    return r.status === 0 ? { ran: true, note: 'cargo generate-lockfile' } : { ran: false, note: 'cargo regen failed; kept the resolved side' };
  }
  return { ran: false, note: 'no package manager known' };
}

/** Every fetch URL a lockfile records, however that format spells it. */
export function lockfileUrls(base, text) {
  if (base === 'Cargo.lock') return [...text.matchAll(/^source\s*=\s*"([^"]+)"/gm)].map((m) => m[1]);
  if (base === 'bun.lockb') return [];
  try {
    const urls = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (typeof o.resolved === 'string') urls.push(o.resolved);
      for (const v of Object.values(o)) walk(v);
    })(JSON.parse(text));
    return urls;
  } catch {
    // bun.lock is JSONC, not JSON.
    return [...text.matchAll(/"(?:resolved|registry)"\s*:\s*"(https?:[^"]*)"/g)].map((m) => m[1]);
  }
}

/**
 * The amendment's registry rule: npm and bun lockfiles may only resolve to
 * registry.npmjs.org, cargo only to crates.io. Non-registry refs (file:,
 * link:, workspace:) carry no fetch URL and are allowed.
 */
export function validateLockfile(base, text) {
  const bad = lockfileUrls(base, text).filter((url) => {
    if (base === 'Cargo.lock') {
      return url !== 'registry+https://github.com/rust-lang/crates.io-index' && !/^sparse\+https:\/\/index\.crates\.io\/?$/.test(url);
    }
    if (/^(file|link|workspace):/.test(url)) return false;
    try {
      return new URL(url).host !== 'registry.npmjs.org';
    } catch {
      return true;
    }
  });
  return { ok: bad.length === 0, bad };
}

function resolveLockfile(root, rel, stages, pending, dry, offline) {
  const spec = LOCKFILES.get(path.basename(rel));
  const dir = path.posix.dirname(rel);
  const manifestRel = dir === '.' ? spec.manifest : `${dir}/${spec.manifest}`;
  if (pending.has(manifestRel)) return { ok: false, reason: `${manifestRel} is still conflicted; resolve the manifest first` };
  const sha = stages['2'] || stages['3'];
  if (!sha) return { ok: false, reason: 'nothing to resolve from' };
  if (dry) return { ok: true, note: `would regenerate with ${spec.pm}` };

  const abs = path.join(root, rel);
  const manifestAbs = path.join(root, manifestRel);
  const snapshot = readFileSync(abs, 'utf8');
  const manifestBefore = existsSync(manifestAbs) ? readFileSync(manifestAbs, 'utf8') : null;
  const resolved = blob(root, sha);
  writeFileSync(abs, resolved);

  const regen = regenerate(spec.pm, path.dirname(abs), offline);
  // A failed or partial regen is not allowed to leave junk behind.
  if (!regen.ran) writeFileSync(abs, resolved);
  // The manifest must come out byte-identical: regen never edits it.
  if (manifestBefore !== null && readFileSync(manifestAbs, 'utf8') !== manifestBefore) {
    writeFileSync(manifestAbs, manifestBefore);
    writeFileSync(abs, snapshot);
    return { ok: false, reason: `${spec.pm} rewrote ${manifestRel}; refusing to stage` };
  }
  const check = validateLockfile(path.basename(rel), readFileSync(abs, 'utf8'));
  if (!check.ok) {
    writeFileSync(abs, snapshot);
    return { ok: false, reason: `off-registry URL in ${path.basename(rel)}: ${check.bad.join(', ')}` };
  }
  stage(root, rel);
  return { ok: true, note: regen.note };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('usage: node scripts/resolve-merge-conflicts.mjs [--offline] [--dry-run]');
    console.log('resolves CHANGELOG.md (union), CLAUDE.md/README.md (main + PR hunks) and lockfiles (package-manager regen)');
    process.exit(0);
  }
  const flags = new Set(['--offline', '--dry-run']);
  const unknown = argv.filter((a) => !flags.has(a));
  if (unknown.length) die(`unknown argument(s): ${unknown.join(' ')}`);
  const dry = argv.includes('--dry-run');
  const offline = argv.includes('--offline');

  const top = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (top.status !== 0) die('not inside a git worktree');
  const root = top.stdout.trim();

  const pending = unmerged(root);
  if (pending.size === 0) {
    console.log('resolve-merge-conflicts: nothing unmerged');
    process.exit(0);
  }
  const tmp = mkdtempSync(path.join(tmpdir(), 'lexicon-merge-'));
  try {
    let bad = 0;
    for (const [rel, st] of [...pending.entries()].sort()) {
      const kind = classify(rel);
      if (!kind) {
        bad++;
        console.error(`left conflicted ${rel}: no strategy for this file`);
        continue;
      }
      let res;
      try {
        res = kind === REGENERATE ? resolveLockfile(root, rel, st, pending, dry, offline) : resolveByMerge(root, tmp, rel, st, kind === UNION ? 'union' : 'ours', dry);
      } catch (e) {
        res = { ok: false, reason: e.message };
      }
      if (res.ok) console.log(`${dry ? 'would resolve' : 'resolved'} ${rel}${res.note ? ` (${res.note})` : ''}`);
      else {
        bad++;
        console.error(`left conflicted ${rel}: ${res.reason}`);
      }
    }
    const left = dry ? bad : unmerged(root).size;
    if (left) {
      console.error(`resolve-merge-conflicts: ${left} path(s) still conflicted`);
      process.exit(1);
    }
    console.log(`resolve-merge-conflicts: all conflicts ${dry ? 'would be ' : ''}resolved`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
