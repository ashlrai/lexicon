/**
 * The lane-side conflict machinery: `.gitattributes` union-merges
 * CHANGELOG.md, and scripts/resolve-merge-conflicts.mjs settles CLAUDE.md and
 * README.md (main's version plus the PR's own hunks) and regenerates
 * lockfiles instead of hand-merging them. These tests run real git merges and
 * rebases in fixture repositories; no model is ever called.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classify, lockfileUrls, validateLockfile, OURS_PLUS, REGENERATE, UNION } from '../scripts/resolve-merge-conflicts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'resolve-merge-conflicts.mjs');
const ATTRS = path.join(ROOT, '.gitattributes');

const CHANGELOG_BASE = '# Changelog\n\n## Unreleased\n\n## 1.0.0\n\n- seed entry\n';
const DOC_BASE = Array.from({ length: 14 }, (_, i) => `doc line ${String(i + 1).padStart(2, '0')}`).join('\n') + '\n';
const PKG_BASE = '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n';
const LOCK_BASE =
  '{\n  "name": "fixture",\n  "version": "1.0.0",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "fixture",\n      "version": "1.0.0"\n    }\n  }\n}\n';

let dirs: string[] = [];
let gitEnv: NodeJS.ProcessEnv;

function setupEnv(): void {
  const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-merge-home-'));
  dirs.push(home);
  // A real but empty config file: GIT_CONFIG_GLOBAL=/dev/null is not portable.
  const empty = path.join(home, 'gitconfig');
  writeFileSync(empty, '');
  gitEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: empty,
    GIT_AUTHOR_NAME: 'Lexicon Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Lexicon Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_EDITOR: ':',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function git(dir: string, args: string[]) {
  return spawnSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8', timeout: 30_000 });
}

function mustGit(dir: string, args: string[]): string {
  const r = git(dir, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function write(dir: string, rel: string, text: string): void {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function commitAll(dir: string, msg: string): void {
  mustGit(dir, ['add', '-A']);
  mustGit(dir, ['commit', '-m', msg]);
}

/** A repo on `main` with the repo's real .gitattributes and the fixture files. */
function seedRepo(withAttrs = true): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lexicon-merge-repo-'));
  dirs.push(dir);
  mustGit(dir, ['init', '-b', 'main']);
  if (withAttrs) write(dir, '.gitattributes', readFileSync(ATTRS, 'utf8'));
  write(dir, 'CHANGELOG.md', CHANGELOG_BASE);
  write(dir, 'CLAUDE.md', DOC_BASE);
  write(dir, 'README.md', DOC_BASE);
  write(dir, 'package.json', PKG_BASE);
  write(dir, 'package-lock.json', LOCK_BASE);
  write(dir, 'src/app.ts', 'export const v = 1;\n');
  commitAll(dir, 'base');
  return dir;
}

/** Branches `pr` off main, applies edits there and on main, leaves main checked out. */
function fork(dir: string, prEdits: Record<string, string>, mainEdits: Record<string, string>): void {
  mustGit(dir, ['checkout', '-b', 'pr']);
  for (const [rel, text] of Object.entries(prEdits)) write(dir, rel, text);
  commitAll(dir, 'pr changes');
  mustGit(dir, ['checkout', 'main']);
  for (const [rel, text] of Object.entries(mainEdits)) write(dir, rel, text);
  commitAll(dir, 'main changes');
}

function runResolver(dir: string, extraArgs: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], { cwd: dir, env: { ...gitEnv, ...env }, encoding: 'utf8', timeout: 90_000 });
}

const docWith = (l2: string, l9: string, l13: string) =>
  DOC_BASE.split('\n')
    .map((l, i) => (i === 1 ? l2 : i === 8 ? l9 : i === 12 ? l13 : l))
    .join('\n');

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

beforeEach(setupEnv);

describe('.gitattributes', () => {
  it('scopes every attribute line to merge=union on CHANGELOG paths only', () => {
    const lines = readFileSync(ATTRS, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const [pattern, ...attrs] = line.split(/\s+/);
      expect(pattern).toMatch(/CHANGELOG/i);
      // The amendment: union only. No binary, -diff, -text, filter= or diff=.
      expect(attrs).toEqual(['merge=union']);
    }
  });
});

describe('CHANGELOG.md union merge', () => {
  it('rebases a fixture CHANGELOG.md conflict cleanly, no model call', () => {
    const dir = seedRepo();
    fork(
      dir,
      { 'CHANGELOG.md': CHANGELOG_BASE.replace('## Unreleased\n\n', '## Unreleased\n\n- pr entry\n\n') },
      { 'CHANGELOG.md': CHANGELOG_BASE.replace('## Unreleased\n\n', '## Unreleased\n\n- main entry\n\n') },
    );
    mustGit(dir, ['checkout', 'pr']);
    const r = git(dir, ['rebase', 'main']);
    expect(r.status).toBe(0);
    const text = readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    expect(text).toContain('- main entry');
    expect(text).toContain('- pr entry');
    expect(text).not.toMatch(/^(<{7}|={7}|>{7})/m);
    expect(mustGit(dir, ['ls-files', '-u']).trim()).toBe('');
    expect(mustGit(dir, ['status', '--porcelain']).trim()).toBe('');
  });

  it('resolves CHANGELOG.md by union even when the attribute is absent', () => {
    const dir = seedRepo(false);
    fork(
      dir,
      { 'CHANGELOG.md': CHANGELOG_BASE.replace('## Unreleased\n\n', '## Unreleased\n\n- pr entry\n\n') },
      { 'CHANGELOG.md': CHANGELOG_BASE.replace('## Unreleased\n\n', '## Unreleased\n\n- main entry\n\n') },
    );
    const r = git(dir, ['merge', '--no-edit', 'pr']);
    expect(r.status).not.toBe(0);
    const res = runResolver(dir);
    expect(res.status).toBe(0);
    const text = readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    expect(text).toContain('- main entry');
    expect(text).toContain('- pr entry');
    expect(mustGit(dir, ['ls-files', '-u']).trim()).toBe('');
  });
});

describe('CLAUDE.md and README.md', () => {
  it.each(['CLAUDE.md', 'README.md'])("resolves %s to main's version with the PR's hunks re-applied", (file) => {
    const dir = seedRepo();
    fork(dir, { [file]: docWith('doc line 02 pr', 'doc line 09 pr', 'doc line 13') }, { [file]: docWith('doc line 02 main', 'doc line 09', 'doc line 13 main') });
    const r = git(dir, ['merge', '--no-edit', 'pr']);
    expect(r.status).not.toBe(0);
    expect(mustGit(dir, ['ls-files', '-u'])).toContain(file);

    const res = runResolver(dir);
    expect(res.status).toBe(0);
    const text = readFileSync(path.join(dir, file), 'utf8');
    // The conflicting hunk goes to main; the PR's clean hunk still lands.
    expect(text).toContain('doc line 02 main');
    expect(text).toContain('doc line 09 pr');
    expect(text).toContain('doc line 13 main');
    expect(text).not.toMatch(/^(<{7}|={7}|>{7})/m);
    expect(mustGit(dir, ['ls-files', '-u']).trim()).toBe('');
    mustGit(dir, ['commit', '--no-edit']);
    expect(mustGit(dir, ['status', '--porcelain']).trim()).toBe('');
  });
});

describe('lockfiles', () => {
  const LOCK_MAIN = LOCK_BASE.replace('"version": "1.0.0"\n    }\n  }', '"version": "1.0.0",\n      "license": "MIT"\n    }\n  }');
  const LOCK_PR = LOCK_BASE.replace('"version": "1.0.0"\n    }\n  }', '"version": "1.0.0",\n      "prField": true\n    }\n  }');

  it('regenerates package-lock.json instead of hand-merging it', () => {
    const dir = seedRepo();
    fork(dir, { 'package-lock.json': LOCK_PR }, { 'package-lock.json': LOCK_MAIN });
    const r = git(dir, ['merge', '--no-edit', 'pr']);
    expect(r.status).not.toBe(0);

    const res = runResolver(dir, ['--offline']);
    expect(res.status).toBe(0);
    expect(mustGit(dir, ['ls-files', '-u']).trim()).toBe('');
    const text = readFileSync(path.join(dir, 'package-lock.json'), 'utf8');
    expect(text).not.toMatch(/^(<{7}|={7}|>{7})/m);
    const lock = JSON.parse(text);
    expect(lock.packages[''].prField).toBeUndefined();
    // The manifest is frozen: byte-identical to what the merge left.
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(mustGit(dir, ['show', 'HEAD:package.json']));
    for (const url of lockfileUrls('package-lock.json', text)) {
      expect(new URL(url).host).toBe('registry.npmjs.org');
    }
  });

  it('refuses to stage a lockfile whose regen produces an off-registry URL', () => {
    const dir = seedRepo();
    fork(dir, { 'package-lock.json': LOCK_PR }, { 'package-lock.json': LOCK_MAIN });
    expect(git(dir, ['merge', '--no-edit', 'pr']).status).not.toBe(0);

    // A stub package manager "regenerates" the lockfile but poisons it with a
    // non-npmjs resolved URL; the resolver must restore the conflicted file.
    const bin = path.join(dir, 'stubbin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, 'npm-stub.mjs'),
      `import fs from 'node:fs';\nif (process.argv.includes('--version')) { console.log('0.0.0'); process.exit(0); }\nconst p = 'package-lock.json';\nconst j = JSON.parse(fs.readFileSync(p, 'utf8'));\nj.packages['evil'] = { resolved: 'https://evil.example.com/x.tgz' };\nfs.writeFileSync(p, JSON.stringify(j, null, 2));\n`,
    );
    writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nexec node "${bin.replace(/\\/g, '/')}/npm-stub.mjs" "$@"\n`, { mode: 0o755 });
    writeFileSync(path.join(bin, 'npm.cmd'), `@echo off\r\nnode "%~dp0npm-stub.mjs" %*\r\n`);

    const res = runResolver(dir, ['--offline'], { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    expect(res.status).toBe(1);
    expect(mustGit(dir, ['ls-files', '-u'])).toContain('package-lock.json');
    expect(readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).toMatch(/^(<{7})/m);
    expect(readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(mustGit(dir, ['show', 'HEAD:package.json']));
  });

  it('validates registry allowlists for every supported lockfile', () => {
    const npmGood = JSON.stringify({ packages: { '': {}, 'node_modules/x': { resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz' } } });
    expect(validateLockfile('package-lock.json', npmGood).ok).toBe(true);
    const npmBad = JSON.stringify({ packages: { 'node_modules/x': { resolved: 'https://evil.example.com/x.tgz' } } });
    expect(validateLockfile('package-lock.json', npmBad).bad).toEqual(['https://evil.example.com/x.tgz']);

    const cargoGood = '[[package]]\nname = "serde"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n[[package]]\nname = "y"\nsource = "sparse+https://index.crates.io/"\n';
    expect(validateLockfile('Cargo.lock', cargoGood).ok).toBe(true);
    expect(validateLockfile('Cargo.lock', 'source = "git+https://evil.example.com/x.git"\n').ok).toBe(false);

    const bunLock = '{\n  "packages": {\n    "x": ["x@1.0.0", "https://registry.npmjs.org/x/-/x-1.0.0.tgz", {}, "sha"],\n    "bad": { "resolved": "https://evil.example.com/b.tgz" }\n  }\n}\n';
    const urls = lockfileUrls('bun.lock', bunLock);
    expect(urls).toContain('https://evil.example.com/b.tgz');
    expect(validateLockfile('bun.lock', bunLock).ok).toBe(false);
  });
});

describe('other files', () => {
  it('leaves files with no strategy conflicted and exits nonzero', () => {
    const dir = seedRepo();
    fork(dir, { 'src/app.ts': 'export const v = 3;\n' }, { 'src/app.ts': 'export const v = 2;\n' });
    expect(git(dir, ['merge', '--no-edit', 'pr']).status).not.toBe(0);
    const res = runResolver(dir);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('src/app.ts');
    expect(mustGit(dir, ['ls-files', '-u'])).toContain('src/app.ts');
  });

  it('--dry-run reports the strategy without touching the tree', () => {
    const dir = seedRepo();
    fork(dir, { 'CLAUDE.md': docWith('doc line 02 pr', 'doc line 09 pr', 'doc line 13') }, { 'CLAUDE.md': docWith('doc line 02 main', 'doc line 09', 'doc line 13 main') });
    expect(git(dir, ['merge', '--no-edit', 'pr']).status).not.toBe(0);
    const res = runResolver(dir, ['--dry-run']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('would resolve CLAUDE.md');
    expect(mustGit(dir, ['ls-files', '-u'])).toContain('CLAUDE.md');
  });
});

describe('classify', () => {
  it('picks a strategy per basename', () => {
    expect(classify('CHANGELOG.md')).toBe(UNION);
    expect(classify('docs/CHANGELOG.md')).toBe(UNION);
    expect(classify('CLAUDE.md')).toBe(OURS_PLUS);
    expect(classify('README.md')).toBe(OURS_PLUS);
    expect(classify('package-lock.json')).toBe(REGENERATE);
    expect(classify('bun.lock')).toBe(REGENERATE);
    expect(classify('Cargo.lock')).toBe(REGENERATE);
    expect(classify('src/app.ts')).toBeNull();
    expect(classify('docs/OTHER.md')).toBeNull();
  });
});
