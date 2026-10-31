import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMarkers, blockNames, loadTruth, markedFiles, planFreshness, renderBlock, repoRoot } from '../scripts/freshness/lib.mjs';

const syncScript = fileURLToPath(new URL('../scripts/freshness/sync.mjs', import.meta.url));
const checkScript = fileURLToPath(new URL('../scripts/freshness/check.mjs', import.meta.url));

// A truth where source and latest release differ on purpose: the generators
// that name a git tag follow package.json, the ones a user can install from
// follow the dated CHANGELOG section.
const truth = {
  source: '9.9.9',
  latest: '1.2.3',
  latestDate: '2026-01-02',
  releases: [
    { version: '1.2.3', date: '2026-01-02' },
    { version: '1.2.2', date: '2025-12-01' },
    { version: '1.2.1', date: null },
  ],
};

const fixtureDirs: string[] = [];
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'freshness-'));
  fixtureDirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
afterAll(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

const README_STALE = `# Fixture

<!-- fresh:begin pin:github -->\`npm i -g github:ashlrai/lexicon#v0.0.0\`<!-- fresh:end --> is the pinned tag install.
`;

const PKG = { name: 'fixture', version: '2.0.0' };
const CHANGELOG = `# Changelog

## Unreleased

## 2.0.0 (2026-03-01)

### Added

- Things.

## 1.0.0 (2025-01-01)

### Added

- Older things.
`;

describe('freshness block generators', () => {
  it('badge: a static shields badge at the latest released version', () => {
    expect(renderBlock('badge:release', truth)).toEqual({
      inline: true,
      text: '[![release](https://img.shields.io/badge/release-v1.2.3-blue)](https://github.com/ashlrai/lexicon/releases)',
    });
    expect(renderBlock('badge:npm', truth).text).toContain('badge/npm-v1.2.3-blue');
  });

  it('install: a fenced snippet pinned to the latest released version', () => {
    const npm = renderBlock('install:npm', truth);
    expect(npm.inline).toBe(false);
    expect(npm.text).toBe('```bash\nnpm install -g @ashlr/lexicon@1.2.3\n```');
    // The github-tag install pins the tag this source tree becomes.
    expect(renderBlock('install:github', truth).text).toContain('#v9.9.9');
  });

  it('table: a releases table from the dated CHANGELOG sections', () => {
    const { text } = renderBlock('table:releases', truth);
    expect(text).toBe(
      '| Version | Released |\n|---|---|\n| 1.2.3 | 2026-01-02 |\n| 1.2.2 | 2025-12-01 |\n| 1.2.1 | unreleased |',
    );
    expect(renderBlock('table:releases:2', truth).text.split('\n')).toHaveLength(4);
  });

  it('pin: inline version pins, git tags at source version and npm pins at latest', () => {
    expect(renderBlock('pin:github', truth).text).toBe('`npm i -g github:ashlrai/lexicon#v9.9.9`');
    expect(renderBlock('pin:npm', truth).text).toBe('`npm i -g @ashlr/lexicon@1.2.3`');
    expect(renderBlock('pin:version', truth).text).toBe('9.9.9');
    expect(renderBlock('pin:tag', truth).text).toBe('v9.9.9');
    expect(renderBlock('pin:latest', truth).text).toBe('1.2.3');
  });

  it('rejects unknown, nested and unclosed markers', () => {
    const bad = applyMarkers('<!-- fresh:begin nope:x -->x<!-- fresh:end -->', truth);
    expect(bad.problems[0].message).toContain("unknown fresh block 'nope:x'");

    const unclosed = applyMarkers('a\n<!-- fresh:begin pin:version -->\nb\n', truth);
    expect(unclosed.problems[0].message).toContain("unclosed fresh:begin 'pin:version'");

    const nested = applyMarkers(
      '<!-- fresh:begin pin:version -->\n<!-- fresh:begin pin:tag -->\n<!-- fresh:end -->\n<!-- fresh:end -->',
      truth,
    );
    expect(nested.problems.map((p) => p.message).join('\n')).toContain('do not nest');

    const strayEnd = applyMarkers('text <!-- fresh:end --> text', truth);
    expect(strayEnd.problems[0].message).toContain('without a matching fresh:begin');

    const inlineTable = applyMarkers('x <!-- fresh:begin table:releases -->y<!-- fresh:end --> z', truth);
    expect(inlineTable.problems[0].message).toContain('multi-line block');
  });
});

describe('freshness sync/check lifecycle', () => {
  it('check exits 1 on a seeded drift fixture, sync rewrites it, check exits 0', () => {
    const dir = fixture({
      'package.json': JSON.stringify(PKG),
      'CHANGELOG.md': CHANGELOG,
      'README.md': README_STALE,
    });

    const drifted = run(checkScript, ['--root', dir]);
    expect(drifted.status).toBe(1);
    expect(drifted.stderr).toContain("README.md:3  'pin:github' is stale");
    expect(drifted.stderr).toContain('npm run fresh:sync');

    const synced = run(syncScript, ['--root', dir]);
    expect(synced.status).toBe(0);
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toContain(
      '`npm i -g github:ashlrai/lexicon#v2.0.0`',
    );

    const clean = run(checkScript, ['--root', dir]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('in sync');
    // Idempotent: a second sync writes nothing.
    expect(run(syncScript, ['--root', dir]).stdout).toContain('already in sync');
  });

  it('loadTruth skips Unreleased and (unreleased) sections', () => {
    const dir = fixture({
      'package.json': JSON.stringify(PKG),
      'CHANGELOG.md': '# Changelog\n\n## Unreleased\n\n## 3.0.0 (unreleased)\n\n## 2.0.0 (2026-03-01)\n',
    });
    const t = loadTruth(dir);
    expect(t.source).toBe('2.0.0');
    expect(t.latest).toBe('2.0.0');
    expect(t.releases).toEqual([{ version: '2.0.0', date: '2026-03-01' }]);
  });

  it('the committed docs are in sync', () => {
    // planFreshness never writes, so this cannot mutate the worktree on drift.
    const { files, problems } = planFreshness(repoRoot);
    expect(problems).toEqual([]);
    expect(files.flatMap((f) => f.blocks.filter((b) => b.stale))).toEqual([]);
    expect(run(checkScript, []).status).toBe(0);
  });

  it('--list names every accepted block', () => {
    expect(blockNames()).toContain('table:releases');
    const listed = run(checkScript, ['--list']);
    expect(listed.status).toBe(0);
    for (const name of blockNames()) expect(listed.stdout).toContain(name);
  });
});

describe('freshness ordering', () => {
  it('lists block names in UTF-16 order', () => {
    const names = blockNames();
    for (let i = 1; i < names.length; i++) expect(names[i - 1] < names[i]).toBe(true);
  });

  it('scans marked files in UTF-16 order', () => {
    const dir = fixture({
      'docs/z.md': '<!-- fresh:begin pin:tag -->',
      'docs/B.md': '<!-- fresh:begin pin:tag -->',
      'docs/10.md': '<!-- fresh:begin pin:tag -->',
      'docs/2.md': '<!-- fresh:begin pin:tag -->',
      'docs/é.md': '<!-- fresh:begin pin:tag -->',
      'docs/ignored.md': '# No markers',
    });
    // markedFiles returns filesystem paths; keep the ordering assertion while
    // comparing with the native separator on both Windows and POSIX.
    expect(markedFiles(dir)).toEqual(['10.md', '2.md', 'B.md', 'z.md', 'é.md'].map((name) => path.join('docs', name)));
  });
});
