import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
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
const env = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://synthetic', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic', GH_TOKEN: 'synthetic-github-token', GITHUB_REPOSITORY: 'ashlrai/lexicon' };

test('asset inspection refuses empty and oversized files before opening a descriptor', (t) => {
  for (const size of [0, 256 * 1024 * 1024 + 1]) {
    const dir = owned(t);
    for (const name of assetNames(version, 'ubuntu')) writeFileSync(join(dir, name), 'synthetic');
    fs.truncateSync(join(dir, assetNames(version, 'ubuntu')[0]), size);
    const original = fs.openSync; let opened = 0;
    try {
      fs.openSync = (...args) => { opened++; return original(...args); }; syncBuiltinESMExports();
      assert.throws(() => checksum(dir, version, 'ubuntu'), /bounded regular/);
      assert.equal(opened, 0);
    } finally { fs.openSync = original; syncBuiltinESMExports(); }
  }
});
test('asset inspection refuses same-size replacement between stat and open and closes the new FD', (t) => {
  const { staged } = fixtures(t); const dir = join(staged, 'ubuntu');
  rmSync(join(dir, 'SHA256SUMS'));
  const target = join(dir, assetNames(version, 'ubuntu')[0]);
  const originalOpen = fs.openSync; const originalClose = fs.closeSync; let tracked; let closed = 0; let changed = false;
  try {
    fs.openSync = (file, ...args) => {
      if (file === target && !changed) { changed = true; fs.renameSync(file, `${file}.old`); fs.copyFileSync(`${file}.old`, file); }
      const fd = originalOpen(file, ...args); if (file === target) tracked = fd; return fd;
    };
    fs.closeSync = (fd) => { if (fd === tracked) closed++; return originalClose(fd); }; syncBuiltinESMExports();
    assert.throws(() => checksum(dir, version, 'ubuntu'), /changed before opening/);
    assert.equal(changed, true); assert.equal(closed, 1);
  } finally { fs.openSync = originalOpen; fs.closeSync = originalClose; syncBuiltinESMExports(); }
});
for (const mutation of ['growth', 'shrink', 'mode', 'named-replacement', 'read-error']) {
  test(`asset FD refuses ${mutation} at the actual read and closes exactly once`, (t) => {
    const { staged } = fixtures(t); const dir = join(staged, 'ubuntu');
    rmSync(join(dir, 'SHA256SUMS'));
    const target = join(dir, assetNames(version, 'ubuntu')[0]); const originalSize = lstatSync(target).size;
    const originals = Object.fromEntries(['openSync', 'closeSync', 'readSync', 'readFileSync'].map((key) => [key, fs[key]]));
    let tracked; let closed = 0; let changed = false; let allocation = 0;
    const mutate = () => {
      if (changed) return; changed = true;
      if (mutation === 'growth') fs.appendFileSync(target, 'synthetic growth');
      if (mutation === 'shrink') fs.truncateSync(target, 0);
      if (mutation === 'mode') {
        if (process.platform === 'win32') fs.utimesSync(target, new Date(0), new Date(0));
        else fs.chmodSync(target, (lstatSync(target).mode & 0o777) === 0o600 ? 0o644 : 0o600);
      }
      if (mutation === 'named-replacement') { fs.renameSync(target, `${target}.old`); writeFileSync(target, originals.readFileSync(`${target}.old`)); }
      if (mutation === 'read-error') throw new Error('synthetic read refusal');
    };
    try {
      fs.openSync = (file, ...args) => { const fd = originals.openSync(file, ...args); if (file === target) tracked = fd; return fd; };
      fs.closeSync = (fd) => { if (fd === tracked) closed++; return originals.closeSync(fd); };
      fs.readSync = (fd, buffer, ...args) => { if (fd === tracked) { allocation = buffer.length; mutate(); } return originals.readSync(fd, buffer, ...args); };
      // The original path reader reaches the same actual mutation in red runs.
      fs.readFileSync = (file, ...args) => { if (file === target) mutate(); return originals.readFileSync(file, ...args); };
      syncBuiltinESMExports();
      assert.throws(() => checksum(dir, version, 'ubuntu'), mutation === 'read-error' ? /read refusal/ : /changed while reading/);
      assert.equal(changed, true); assert.equal(allocation, originalSize + 1); assert.equal(closed, 1);
    } finally { for (const [key, value] of Object.entries(originals)) fs[key] = value; syncBuiltinESMExports(); }
  });
}
test('actual regular-to-FIFO replacement is refused before reads at the unchanged child bound', (t) => {
  const dir = owned(t); const child = join(dir, 'fifo-reader.mjs');
  writeFileSync(child, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {execFileSync} from 'node:child_process';import {join} from 'node:path';import {assetNames,checksum} from ${JSON.stringify(new URL('./release-contract.mjs', import.meta.url).href)};
const dir=${JSON.stringify(dir)},version=${JSON.stringify(version)},target=join(dir,assetNames(version,'ubuntu')[0]);for(const n of assetNames(version,'ubuntu'))fs.writeFileSync(join(dir,n),'synthetic');fs.unlinkSync(${JSON.stringify(child)});
const originalStat=fs.lstatSync,originalOpen=fs.openSync,originalClose=fs.closeSync,originalRead=fs.readSync;let replaced=false,fd,closed=0,reads=0;
fs.lstatSync=(file,...args)=>{const s=originalStat(file,...args);if(file===target&&!replaced){replaced=true;fs.unlinkSync(file);if(process.platform==='win32')fs.mkdirSync(file);else execFileSync('/usr/bin/mkfifo',[file]);process.stderr.write('NONREGULAR_INSTALLED\\n');}return s};fs.openSync=(file,...args)=>{const opened=originalOpen(file,...args);if(file===target)fd=opened;return opened};fs.closeSync=(n)=>{if(n===fd)closed++;return originalClose(n)};fs.readSync=(n,...args)=>{if(n===fd)reads++;return originalRead(n,...args)};syncBuiltinESMExports();try{checksum(dir,version,'ubuntu');process.stdout.write(JSON.stringify({refused:false,closed,reads}))}catch{process.stdout.write(JSON.stringify({refused:true,closed,reads}))}`);
  const result = spawnSync(process.execPath, [child], { timeout: 1500, encoding: 'utf8', env: { HOME: dir, USERPROFILE: dir, PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } });
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.match(result.stderr, /NONREGULAR_INSTALLED/);
  const observation = JSON.parse(result.stdout); assert.equal(observation.refused, true); assert.equal(observation.reads, 0);
  // Windows may refuse a directory during open; POSIX opens its nonblocking FIFO
  // and must close it after fstat rejects the nonregular descriptor.
  if (process.platform !== 'win32') assert.equal(observation.closed, 1);
});

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
test('assembly preserves qualified source modes despite a restrictive writer umask', (t) => {
  const { staged, release } = fixtures(t);
  for (const part of ['ubuntu', 'macos']) for (const name of assetNames(version, part)) fs.chmodSync(join(staged, part, name), 0o740);
  const priorUmask = process.umask(0o077);
  try { assemble(staged, release, version); } finally { process.umask(priorUmask); }
  for (const part of ['ubuntu', 'macos']) for (const name of assetNames(version, part)) {
    assert.equal(lstatSync(join(release, name)).mode & 0o7777, lstatSync(join(staged, part, name)).mode & 0o7777);
    assert.deepEqual(readFileSync(join(release, name)), readFileSync(join(staged, part, name)));
  }
  validateAssets(release, version);
});
test('assembly refuses a destination collision without overwriting it', (t) => {
  const { staged, release } = fixtures(t); const name = assetNames(version, 'ubuntu')[0];
  const originalMkdir = fs.mkdirSync;
  try {
    fs.mkdirSync = (target, ...args) => { const result = originalMkdir(target, ...args); if (target === release) writeFileSync(join(release, name), 'synthetic collision'); return result; };
    syncBuiltinESMExports();
    assert.throws(() => assemble(staged, release, version), /EEXIST/);
    assert.equal(readFileSync(join(release, name), 'utf8'), 'synthetic collision');
  } finally { fs.mkdirSync = originalMkdir; syncBuiltinESMExports(); }
});
test('assembly closes an exclusively created destination when writing fails', (t) => {
  const { staged, release } = fixtures(t); const target = join(release, assetNames(version, 'ubuntu')[0]);
  const originals = Object.fromEntries(['openSync', 'closeSync', 'writeFileSync'].map((key) => [key, fs[key]]));
  let tracked; let closed = 0;
  try {
    fs.openSync = (file, ...args) => { const fd = originals.openSync(file, ...args); if (file === target) tracked = fd; return fd; };
    fs.closeSync = (fd) => { if (fd === tracked) closed++; return originals.closeSync(fd); };
    fs.writeFileSync = (file, ...args) => { if (typeof file === 'number' && file === tracked) throw new Error('synthetic write refusal'); return originals.writeFileSync(file, ...args); };
    syncBuiltinESMExports();
    assert.throws(() => assemble(staged, release, version), /write refusal/); assert.equal(closed, 1);
  } finally { for (const [key, value] of Object.entries(originals)) fs[key] = value; syncBuiltinESMExports(); }
});
test('assembly refuses a qualified source changed to FIFO before copying within the unchanged child bound', (t) => {
  const dir = owned(t); const child = join(dir, 'fifo-copy.mjs');
  writeFileSync(child, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {execFileSync} from 'node:child_process';import {join} from 'node:path';import {assetNames,checksum,assemble} from ${JSON.stringify(new URL('./release-contract.mjs', import.meta.url).href)};
const dir=${JSON.stringify(dir)},version=${JSON.stringify(version)},staged=join(dir,'staged'),release=join(dir,'release');for(const p of ['ubuntu','macos']){fs.mkdirSync(join(staged,p),{recursive:true});for(const n of assetNames(version,p))fs.writeFileSync(join(staged,p,n),'synthetic');checksum(join(staged,p),version,p)}const originalMkdir=fs.mkdirSync;fs.mkdirSync=(file,...args)=>{const result=originalMkdir(file,...args);if(file===release){const source=join(staged,'ubuntu',assetNames(version,'ubuntu')[0]);fs.unlinkSync(source);if(process.platform==='win32')fs.mkdirSync(source);else execFileSync('/usr/bin/mkfifo',[source]);process.stderr.write('NONREGULAR_INSTALLED_AFTER_QUALIFICATION\\n')}return result};syncBuiltinESMExports();try{assemble(staged,release,version);process.stdout.write(JSON.stringify({refused:false}))}catch{process.stdout.write(JSON.stringify({refused:true}))}`);
  const result = spawnSync(process.execPath, [child], { timeout: 1500, encoding: 'utf8', env: { HOME: dir, USERPROFILE: dir, PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } });
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.match(result.stderr, /NONREGULAR_INSTALLED_AFTER_QUALIFICATION/);
  assert.equal(JSON.parse(result.stdout).refused, true);
});
test('assembly refuses a producer file changed between validation and copying', (t) => {
  const { staged, release } = fixtures(t);
  const originalMkdir = fs.mkdirSync;
  let changed = false;
  try {
    // Output creation is after producer validation and before either copy path.
    fs.mkdirSync = (target, ...args) => {
      const result = originalMkdir(target, ...args);
      if (target === release && !changed) { changed = true; writeFileSync(join(staged, 'ubuntu', assetNames(version, 'ubuntu')[0]), 'synthetic after-validation mutation'); }
      return result;
    };
    syncBuiltinESMExports();
    assert.throws(() => assemble(staged, release, version), /qualified producer checksums/);
  } finally { fs.mkdirSync = originalMkdir; syncBuiltinESMExports(); }
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
test('trusted publishing OIDC satisfies the credential requirement without NPM_TOKEN', async () => {
  let calls = 0;
  await preflight(version, { ...env, NODE_AUTH_TOKEN: '', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://synthetic', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic' }, async () => { calls++; return { status: 404 }; });
  assert.equal(calls, 2);
});
test('missing OIDC refuses before any network read or external write, even with a long-lived token', async () => {
  let calls = 0;
  await assert.rejects(preflight(version, { ...env, ACTIONS_ID_TOKEN_REQUEST_URL: '', ACTIONS_ID_TOKEN_REQUEST_TOKEN: '', NODE_AUTH_TOKEN: 'synthetic-npm-token' }, async () => { calls++; }), /trusted publishing/);
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
