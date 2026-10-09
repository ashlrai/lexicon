import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { assetNames, assemble, checkSource, checksum, preflight, releaseVersion, validateAssets, verifyHosted, verifyRegistry } from './release-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const owned = (t) => { const dir = mkdtempSync(join(tmpdir(), 'lexicon release fixture ')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
function fixtures(t) {
  const dir = owned(t);
  const staged = join(dir, 'staged');
  for (const part of ['ubuntu', 'macos']) {
    mkdirSync(join(staged, part), { recursive: true });
    for (const name of assetNames(version, part)) writeFileSync(join(staged, part, name), `synthetic qualified bytes: ${name}\n`);
    checksum(join(staged, part), version, part);
  }
  return { dir, staged, release: join(dir, 'release') };
}
function complete(t) { const f = fixtures(t); assemble(f.staged, f.release, version); return f; }
const env = { NODE_AUTH_TOKEN: 'synthetic-npm-token', GH_TOKEN: 'synthetic-github-token', GITHUB_REPOSITORY: 'ashlrai/lexicon' };

test('stable version rejects tag injection and prerelease ambiguity', () => {
  for (const value of ['1.2.3;echo x', '../1.2.3', 'v1.2.3', '01.2.3', '1.2.3-beta', '1.2', '1.2.3\n']) assert.throws(() => releaseVersion(value));
  assert.equal(releaseVersion('1.2.3'), '1.2.3');
});
test('all eleven version fields agree before build; every stale carrier refuses', (t) => {
  const dir = owned(t);
  const paths = ['package.json', 'package-lock.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'server.json', 'README.md', 'apps/windows/Directory.Build.props', 'web/lib/site.ts', 'docs/CLI.md', 'CHANGELOG.md'];
  for (const name of paths) { mkdirSync(join(dir, name, '..'), { recursive: true }); cpSync(join(root, name), join(dir, name)); }
  // A candidate PR may intentionally still have an unreleased changelog.
  // Exercise a synthetic dated release while the real source CLI remains strict.
  writeFileSync(join(dir, 'CHANGELOG.md'), `## ${version} (2026-10-09)\n`);
  assert.equal(checkSource(dir, `v${version}`), version);
  const jsonMutations = [
    ['package.json', (v) => v.version = '9.9.9'],
    ['package-lock.json', (v) => v.version = '9.9.9'],
    ['package-lock.json', (v) => v.packages[''].version = '9.9.9'],
    ['.claude-plugin/plugin.json', (v) => v.version = '9.9.9'],
    ['.claude-plugin/marketplace.json', (v) => v.plugins[0].version = '9.9.9'],
    ['server.json', (v) => v.version = '9.9.9'],
    ['server.json', (v) => v.packages[0].version = '9.9.9'],
  ];
  for (const [name, mutate] of jsonMutations) {
    const original = readFileSync(join(dir, name));
    const value = JSON.parse(original); mutate(value); writeFileSync(join(dir, name), JSON.stringify(value));
    assert.throws(() => checkSource(dir, `v${version}`), undefined, name);
    writeFileSync(join(dir, name), original);
  }
  for (const name of ['README.md', 'apps/windows/Directory.Build.props', 'web/lib/site.ts', 'docs/CLI.md']) {
    const original = readFileSync(join(dir, name), 'utf8');
    writeFileSync(join(dir, name), original.replaceAll(version, '9.9.9'));
    assert.throws(() => checkSource(dir, `v${version}`), undefined, name);
    writeFileSync(join(dir, name), original);
  }
  writeFileSync(join(dir, 'CHANGELOG.md'), `## ${version} (unreleased)\n`);
  assert.throws(() => checkSource(dir, `v${version}`), /dated/);
  assert.throws(() => checkSource(root, 'v9.9.9'), /tag/);
});
test('assembly preserves both original producer bytes and complete checksum closure', (t) => {
  const { staged, release } = complete(t);
  validateAssets(release, version);
  for (const part of ['ubuntu', 'macos']) for (const name of assetNames(version, part)) assert.deepEqual(readFileSync(join(release, name)), readFileSync(join(staged, part, name)));
  assert.throws(() => assemble(staged, release, version), /already exists/);
});
test('assembly refuses a producer file changed between validation and copying', (t) => {
  const { staged, release } = fixtures(t);
  const originalCopy = fs.copyFileSync;
  let changed = false;
  try {
    fs.copyFileSync = (source, target, ...args) => {
      if (!changed) { changed = true; writeFileSync(source, 'synthetic after-validation mutation'); }
      return originalCopy(source, target, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => assemble(staged, release, version), /qualified producer checksums/);
  } finally { fs.copyFileSync = originalCopy; syncBuiltinESMExports(); }
  assert.equal(changed, true);
});
for (const mutation of ['missing-mac', 'tampered-mac', 'tampered-npm', 'extra-asset', 'wrong-checksum-name', 'duplicate-checksum', 'symlink']) {
  test(`assembly refuses ${mutation} before creating final output`, (t) => {
    const { dir, staged, release } = fixtures(t);
    const mac = join(staged, 'macos', 'LexiconBar.app.zip');
    const sums = join(staged, 'macos', 'SHA256SUMS');
    if (mutation === 'missing-mac') rmSync(mac);
    if (mutation === 'tampered-mac') writeFileSync(mac, 'changed');
    if (mutation === 'tampered-npm') writeFileSync(join(staged, 'ubuntu', `ashlr-lexicon-${version}.tgz`), 'changed');
    if (mutation === 'extra-asset') writeFileSync(join(staged, 'ubuntu', 'unqualified.zip'), 'extra');
    if (mutation === 'wrong-checksum-name') writeFileSync(sums, readFileSync(sums, 'utf8').replace('LexiconBar.app.zip', 'other.zip'));
    if (mutation === 'duplicate-checksum') writeFileSync(sums, readFileSync(sums, 'utf8').repeat(2));
    if (mutation === 'symlink') { const target = join(dir, 'outside.zip'); cpSync(mac, target); rmSync(mac); symlinkSync(target, mac); }
    assert.throws(() => assemble(staged, release, version));
    assert.throws(() => lstatSync(release), /ENOENT/);
  });
}
test('missing token refuses before any network read or external write', async () => {
  let calls = 0;
  await assert.rejects(preflight(version, { ...env, NODE_AUTH_TOKEN: '' }, async () => { calls++; }), /NPM_TOKEN/);
  assert.equal(calls, 0);
});
for (const status of [200, 401, 403, 500]) {
  test(`existing or unverifiable release HTTP${status} refuses before npm lookup`, async () => {
    let calls = 0;
    await assert.rejects(preflight(version, env, async () => { calls++; return { status }; }));
    assert.equal(calls, 1);
  });
}
test('preflight requires absence of both release and exact npm version', async () => {
  let calls = 0;
  await preflight(version, env, async () => { calls++; return { status: 404 }; });
  assert.equal(calls, 2);
  for (const status of [200, 401, 429, 500]) {
    let call = 0;
    await assert.rejects(preflight(version, env, async () => ({ status: ++call === 1 ? 404 : status })));
  }
});
test('hosted draft/public receipt and bytes require exact complete asset set', (t) => {
  const { release } = complete(t);
  const assets = [...assetNames(version), 'SHA256SUMS'].map((name) => ({ name, size: lstatSync(join(release, name)).size }));
  const receipt = { tagName: `v${version}`, isDraft: true, isPrerelease: false, assets };
  verifyHosted(release, version, receipt, true);
  verifyHosted(release, version, { ...receipt, isDraft: false }, false);
  for (const broken of [{ ...receipt, isDraft: false }, { ...receipt, tagName: 'v9.9.9' }, { ...receipt, assets: assets.slice(1) }, { ...receipt, assets: [...assets, assets[0]] }, { ...receipt, assets: assets.map((a) => ({ ...a, size: 1 })) }]) assert.throws(() => verifyHosted(release, version, broken, true));
  writeFileSync(join(release, 'LexiconBar.app.zip'), 'changed-hosted-byte');
  assert.throws(() => verifyHosted(release, version, receipt, true));
});
test('registry exact-version SHA512 and downloaded bytes must equal original archive', async (t) => {
  const { release } = complete(t);
  const original = readFileSync(join(release, `ashlr-lexicon-${version}.tgz`));
  const pkg = { name: '@ashlr/lexicon', version, dist: { integrity: `sha512-${createHash('sha512').update(original).digest('base64')}`, tarball: `https://registry.npmjs.org/@ashlr/lexicon/-/lexicon-${version}.tgz` } };
  const fetcher = (metadata = pkg, archive = original, status = 200) => async (url) => url.endsWith('.tgz') ? { status, body: [archive] } : { status, json: async () => metadata };
  await verifyRegistry(release, version, fetcher());
  for (const metadata of [{ ...pkg, version: '9.9.9' }, { ...pkg, name: 'other' }, { ...pkg, dist: { ...pkg.dist, integrity: 'sha512-other' } }, { ...pkg, dist: { ...pkg.dist, tarball: 'https://evil.invalid/file.tgz' } }]) await assert.rejects(verifyRegistry(release, version, fetcher(metadata)));
  await assert.rejects(verifyRegistry(release, version, fetcher(pkg, Buffer.from('different registry bytes'))));
  await assert.rejects(verifyRegistry(release, version, fetcher(pkg, original, 404)));
});
test('workflow qualifies both read-only producers before a single privileged publication job', () => {
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const ubuntu = workflow.slice(workflow.indexOf('  ubuntu:'), workflow.indexOf('  macos:'));
  const macos = workflow.slice(workflow.indexOf('  macos:'), workflow.indexOf('  publish:'));
  const publish = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /tags: \['v\*'\]/);
  for (const job of [ubuntu, macos]) { assert.doesNotMatch(job, /secrets\.|npm publish|gh release|id-token: write|contents: write/); assert.match(job, /release-contract\.mjs source/); assert.match(job, /upload-artifact/); }
  assert.match(publish, /needs: \[ubuntu, macos\]/);
  assert.match(publish, /npm publish "\.\/release\/ashlr-lexicon-\$\{VERSION\}\.tgz" --provenance/);
  assert.doesNotMatch(publish, /--clobber|npm pack|npm ci|npm run build|Skipped npm publish/);
  const stages = ['mjs assemble', 'mjs preflight', 'npm publish', 'mjs registry', 'gh release create', 'gh release upload', 'mjs hosted', 'gh release edit'];
  let last = -1;
  for (const stage of stages) { const position = publish.indexOf(stage); assert.ok(position > last, stage); last = position; }
});
