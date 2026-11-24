import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { classifyPaths, isOsPath } from '../scripts/ci-os-paths.mjs';
import { evaluateOsGate } from '../scripts/ci-os-gate.mjs';
import { verifyDigest, verifyIntegrity } from '../scripts/ci-install-smoke.mjs';

test('docs and unrelated sources skip the OS leg', () => {
  assert.equal(classifyPaths(['docs/QUICKSTART.md', 'README.md', 'src/core/matcher.ts']), false);
  assert.equal(isOsPath('docs/install.md'), false);
});

test('installer, path, shell, manifest, lockfile and workflow files open the leg', () => {
  for (const file of [
    'scripts/install.sh',
    'src/cli/cmd-install.ts',
    'src/util/xdg.ts',
    'src/util/shell.ts',
    'package.json',
    'package-lock.json',
    '.github/workflows/ci.yml',
    '.github/workflows/windows-app.yml',
    'apps/macos/LexiconBar/Package.swift',
    'apps/windows/src/LexiconBar.App/LexiconBar.App.csproj',
  ]) {
    assert.equal(isOsPath(file), true, file);
  }
});

test('a path skip passes and a failure or cancellation does not', () => {
  assert.deepEqual(evaluateOsGate({
    classify: 'success',
    flag: 'false',
    event: 'pull_request',
    jobs: { checks: 'skipped', smoke: 'skipped' },
    optionalWhenMeasuring: ['checks'],
  }), []);
  assert.deepEqual(evaluateOsGate({
    classify: 'success',
    flag: 'true',
    event: 'pull_request',
    jobs: { checks: 'failure', smoke: 'success' },
    optionalWhenMeasuring: ['checks'],
  }), ['checks=failure']);
  assert.deepEqual(evaluateOsGate({
    classify: 'success',
    flag: 'true',
    event: 'pull_request',
    jobs: { checks: 'cancelled', smoke: 'success' },
    optionalWhenMeasuring: [],
  }), ['checks=cancelled']);
  assert.deepEqual(evaluateOsGate({
    classify: 'success',
    flag: 'true',
    event: 'schedule',
    jobs: { checks: 'skipped', smoke: 'success' },
    optionalWhenMeasuring: ['checks'],
  }), []);
});

test('checksum verification fails closed', () => {
  const bytes = Buffer.from('lexicon');
  const sha1 = createHash('sha1').update(bytes).digest('hex');
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  verifyDigest(bytes, 'sha1', sha1, 'hex');
  verifyIntegrity(bytes, `sha512-${sha512}`);
  assert.throws(() => verifyIntegrity(bytes, ''), /checksum missing/);
  assert.throws(() => verifyIntegrity(bytes, 'sha512-AAAA'), /checksum mismatch/);
  assert.throws(() => verifyDigest(bytes, 'sha1', '', 'hex'), /checksum missing/);
});
