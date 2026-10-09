import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE = '@ashlr/lexicon';
const REPOSITORY = 'ashlrai/lexicon';
export function releaseVersion(value) {
  assert.match(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'release requires an exact stable version');
  return value;
}
export function checkSource(root, tag) {
  const text = (name) => readFileSync(join(root, name), 'utf8');
  const json = (name) => JSON.parse(text(name));
  const pkg = json('package.json');
  const version = releaseVersion(pkg.version);
  assert.equal(pkg.name, PACKAGE);
  assert.equal(tag, `v${version}`, 'tag and package version differ');
  const lock = json('package-lock.json');
  const server = json('server.json');
  const surfaces = [
    lock.version, lock.packages?.['']?.version,
    json('.claude-plugin/plugin.json').version,
    json('.claude-plugin/marketplace.json').plugins?.find((p) => p.name === 'lexicon')?.version,
    server.version, server.packages?.find((p) => p.identifier === PACKAGE)?.version,
    text('README.md').match(/github:ashlrai\/lexicon#v(\d+\.\d+\.\d+)/)?.[1],
    text('apps/windows/Directory.Build.props').match(/<Version>([^<]+)<\/Version>/)?.[1],
    text('web/lib/site.ts').match(/export const VERSION = ['"]([^'"]+)['"]/)?.[1],
    text('docs/CLI.md').match(/Generated from `lexicon --help` \(v([^()]+)\)/)?.[1],
  ];
  for (const value of surfaces) assert.equal(value, version, 'source version carrier differs');
  assert.match(text('CHANGELOG.md'), new RegExp(`^## ${version.replaceAll('.', '\\.')} \\(\\d{4}-\\d{2}-\\d{2}\\)$`, 'm'), 'release changelog must be dated');
  return version;
}
export function assetNames(version, part = 'all') {
  releaseVersion(version);
  const ubuntu = [`ashlr-lexicon-${version}.tgz`, 'lexicon-extension.zip', 'lexicon-extension-firefox.zip'];
  if (part === 'ubuntu') return ubuntu;
  if (part === 'macos') return ['LexiconBar.app.zip'];
  assert.equal(part, 'all');
  return [...ubuntu, 'LexiconBar.app.zip'];
}
function bytes(root, name) {
  const file = join(root, name);
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 256 * 1024 * 1024, 'release asset must be a bounded regular file');
  return readFileSync(file);
}
function inventory(root, names, manifest) {
  assert.deepEqual(readdirSync(root).sort(), [...names, ...(manifest ? ['SHA256SUMS'] : [])].sort(), 'release asset inventory differs');
  return names.map((name) => `${createHash('sha256').update(bytes(root, name)).digest('hex')}  ${name}\n`).join('');
}
export function checksum(root, version, part) {
  const sums = inventory(root, assetNames(version, part), false);
  writeFileSync(join(root, 'SHA256SUMS'), sums);
}
export function validateAssets(root, version, part = 'all') {
  const sums = inventory(root, assetNames(version, part), true);
  assert.equal(bytes(root, 'SHA256SUMS').toString('utf8'), sums, 'release checksum closure differs');
  return sums;
}
export function assemble(staged, output, version) {
  const qualifiedSums = ['ubuntu', 'macos'].map((part) => validateAssets(join(staged, part), version, part)).join('');
  assert.ok(!existsSync(output), 'release output already exists');
  mkdirSync(output);
  for (const part of ['ubuntu', 'macos']) {
    for (const name of assetNames(version, part)) copyFileSync(join(staged, part, name), join(output, name));
  }
  checksum(output, version, 'all');
  assert.equal(validateAssets(output, version), qualifiedSums, 'copied release bytes differ from qualified producer checksums');
}
export function verifyHosted(root, version, receipt, draft) {
  validateAssets(root, version);
  assert.equal(receipt.tagName, `v${version}`);
  assert.equal(receipt.isDraft, draft);
  assert.equal(receipt.isPrerelease, false);
  const expected = [...assetNames(version), 'SHA256SUMS'];
  assert.deepEqual(receipt.assets.map((a) => a.name).sort(), expected.sort(), 'hosted asset inventory differs');
  for (const asset of receipt.assets) assert.equal(asset.size, bytes(root, asset.name).length, 'hosted asset size differs');
}
async function request(url, options = {}, fetcher = fetch) {
  return fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
}
export async function preflight(version, env = process.env, fetcher = fetch) {
  releaseVersion(version);
  assert.ok(env.NODE_AUTH_TOKEN?.trim(), 'existing NPM_TOKEN is required before publication');
  assert.ok(env.GH_TOKEN?.trim(), 'workflow GitHub token is required');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, 'unexpected release repository');
  const release = await request(`https://api.github.com/repos/${REPOSITORY}/releases/tags/v${version}`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
  }, fetcher);
  assert.equal(release.status, 404, 'release absence could not be proven; existing releases must not be overwritten');
  const registry = await request(`https://registry.npmjs.org/@ashlr%2Flexicon/${version}`, {}, fetcher);
  assert.equal(registry.status, 404, 'npm version absence could not be proven; use a new fix-forward version');
}
export async function verifyRegistry(root, version, fetcher = fetch) {
  validateAssets(root, version);
  const expected = `sha512-${createHash('sha512').update(bytes(root, `ashlr-lexicon-${version}.tgz`)).digest('base64')}`;
  const response = await request(`https://registry.npmjs.org/@ashlr%2Flexicon/${version}`, {}, fetcher);
  assert.equal(response.status, 200, 'exact npm version is not readable');
  const pkg = await response.json();
  assert.equal(pkg.name, PACKAGE);
  assert.equal(pkg.version, version);
  assert.equal(pkg.dist?.integrity, expected, 'npm archive integrity differs');
  assert.equal(pkg.dist?.tarball, `https://registry.npmjs.org/@ashlr/lexicon/-/lexicon-${version}.tgz`, 'unexpected npm tarball URL');
  const tarball = await request(pkg.dist.tarball, {}, fetcher);
  assert.equal(tarball.status, 200, 'npm archive is not readable');
  let size = 0;
  const hash = createHash('sha512');
  for await (const chunk of tarball.body) {
    size += chunk.length;
    assert.ok(size <= 256 * 1024 * 1024, 'npm archive exceeds bound');
    hash.update(chunk);
  }
  assert.equal(`sha512-${hash.digest('base64')}`, expected, 'downloaded npm archive differs');
}
async function main() {
  const [command, root, version, part] = process.argv.slice(2);
  if (command === 'source') console.log(checkSource(root, version));
  else if (command === 'checksum') checksum(root, version, part);
  else if (command === 'assemble') assemble(root, version, part);
  else if (command === 'assets') validateAssets(root, version);
  else if (command === 'hosted') verifyHosted(root, version, JSON.parse(readFileSync(part)), process.argv[6] === 'draft');
  else if (command === 'preflight') await preflight(root);
  else if (command === 'registry') {
    let passed = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      try { await verifyRegistry(root, version); passed = true; break; }
      catch { if (attempt < 11) await new Promise((done) => setTimeout(done, 10_000)); }
    }
    assert.ok(passed, 'exact npm archive acceptance failed; release remains unpublished');
  } else throw new Error('unknown release contract command');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Release contract failed; no credentials or response bodies are logged.'); process.exitCode = 1; });
}
