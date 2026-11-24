/**
 * Install smoke. Checksums are verified before the package is installed and
 * before the CLI runs. A missing or mismatched checksum fails closed.
 *
 *   node scripts/ci-install-smoke.mjs commit
 *   node scripts/ci-install-smoke.mjs release
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function verifyDigest(bytes, algorithm, expected, encoding) {
  if (typeof expected !== 'string' || expected.length === 0) throw new Error(`${algorithm} checksum missing`);
  let actual;
  try {
    actual = createHash(algorithm).update(bytes).digest(encoding);
  } catch {
    throw new Error(`${algorithm} checksum rejected`);
  }
  const left = Buffer.from(encoding === 'hex' ? actual.toLowerCase() : actual);
  const right = Buffer.from(encoding === 'hex' ? expected.toLowerCase() : expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error(`${algorithm} checksum mismatch`);
  }
}

export function verifyIntegrity(bytes, integrity) {
  if (typeof integrity !== 'string') throw new Error('checksum missing');
  const dash = integrity.indexOf('-');
  if (dash <= 0) throw new Error('checksum missing');
  verifyDigest(bytes, integrity.slice(0, dash), integrity.slice(dash + 1), 'base64');
}

export function npmPath() {
  const dir = dirname(process.execPath);
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  for (const name of names) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('npm was not found next to node');
}

function npm(args, options = {}) {
  const run = spawnSync(npmPath(), args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  if (run.status !== 0) {
    const detail = (run.stderr || run.stdout || 'npm failed').split('\n').map((line) => line.trim()).find(Boolean);
    throw new Error(detail || 'npm failed');
  }
  return run.stdout || '';
}

function jsonAfter(text, opener) {
  const start = text.indexOf(opener);
  if (start < 0) throw new Error('checksum metadata missing');
  return JSON.parse(text.slice(start));
}

function requireChecksums(meta) {
  if (!meta?.integrity || !meta?.shasum) throw new Error('checksum missing');
  return meta;
}

function assertBytes(bytes, meta) {
  verifyDigest(bytes, 'sha1', meta.shasum, 'hex');
  verifyIntegrity(bytes, meta.integrity);
}

function installAndRun(bytes, filename, expectedVersion) {
  const dir = mkdtempSync(join(tmpdir(), 'lexicon-smoke-'));
  const tarball = join(dir, filename);
  const prefix = join(dir, 'prefix');
  writeFileSync(tarball, bytes);
  npm(['install', '--global', '--prefix', prefix, tarball], { cwd: dir });
  const entry = join(prefix, 'node_modules', '@ashlr', 'lexicon', 'dist', 'cli', 'index.js');
  if (!existsSync(entry)) throw new Error('installed CLI entry was not found');
  const run = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error((run.stderr || 'lexicon --version failed').trim() || 'lexicon --version failed');
  const version = (run.stdout || '').trim();
  if (version !== expectedVersion) throw new Error(`installed ${version}, expected ${expectedVersion}`);
  console.log(`install smoke ok ${expectedVersion}`);
}

function commitSmoke() {
  const expected = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const packed = jsonAfter(npm(['pack', '--ignore-scripts', '--json']), '[');
  const item = requireChecksums(Array.isArray(packed) ? packed[packed.length - 1] : packed);
  if (!item.filename) throw new Error('checksum missing');
  const bytes = readFileSync(join(root, item.filename));
  assertBytes(bytes, item);
  installAndRun(bytes, item.filename, expected);
}

async function releaseSmoke() {
  const viewed = jsonAfter(npm(['view', '@ashlr/lexicon', 'version', 'dist.integrity', 'dist.shasum', 'dist.tarball', '--json']), '{');
  const version = viewed.version;
  const integrity = viewed['dist.integrity'];
  const shasum = viewed['dist.shasum'];
  const tarball = viewed['dist.tarball'];
  if (!version || !integrity || !shasum || typeof tarball !== 'string' || !tarball.startsWith('https://')) {
    throw new Error('release checksum missing');
  }
  const response = await fetch(tarball);
  if (!response.ok) throw new Error(`release download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assertBytes(bytes, { integrity, shasum });
  const filename = new URL(tarball).pathname.split('/').pop() || 'lexicon.tgz';
  installAndRun(bytes, filename, version);
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'commit') commitSmoke();
  else if (mode === 'release') await releaseSmoke();
  else throw new Error('install smoke mode must be commit or release');
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exit(1);
  });
}
