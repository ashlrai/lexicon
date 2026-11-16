import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('.');

test('macOS signing scripts use only the specified keychain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lexicon-signing-test-'));
  try {
    const bin = join(dir, 'bin');
    const repo = join(dir, 'repo');
    const keychain = join(dir, 'keychains with spaces', 'signing.keychain-db');
    const log = join(dir, 'calls.jsonl');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(repo, 'scripts'), { recursive: true });
    mkdirSync(join(repo, 'apps/macos/LexiconBar/Packaging'), { recursive: true });
    for (const file of ['build-macos-app.sh', 'make-signing-identity.sh']) {
      // Use a plain directory in the fixture: some hosts restrict creating .app bundles.
      const source = readFileSync(join(root, 'scripts', file), 'utf8').replaceAll('LexiconBar.app', 'LexiconBar.test-bundle').replaceAll('Smoke.app', 'Smoke.test-bundle');
      writeFileSync(join(repo, 'scripts', file), source);
    }
    writeFileSync(join(repo, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
    writeFileSync(join(repo, 'apps/macos/LexiconBar/Packaging/Info.plist.in'), 'test');
    const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (name === 'security' || name === 'codesign') fs.appendFileSync(process.env.CALL_LOG, JSON.stringify([name, ...args]) + '\\n');
if (name === 'security' && args[0] === 'find-identity' && fs.existsSync(process.env.IDENTITY_READY)) console.log('  1) ABCDEF "LexiconBar Local Signing"');
if (name === 'security' && args[0] === 'import') fs.writeFileSync(process.env.IDENTITY_READY, 'yes');
if (name === 'mktemp') console.log(fs.mkdtempSync(path.join(process.env.TMPDIR, 'work-')));
if (name === 'openssl' && args[0] === 'rand') console.log('stub-password');
if (name === 'swift' && args.includes('--show-bin-path')) console.log(process.env.FAKE_BIN);
`;
    for (const name of ['security', 'codesign', 'openssl', 'swift', 'plutil', 'ditto', 'mktemp']) {
      writeFileSync(join(bin, name), stub, { mode: 0o755 });
    }
    const fakeBin = join(dir, 'swift-output');
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, 'LexiconBar'), '#!/bin/sh\n', { mode: 0o755 });
    const env = { ...process.env, HOME: dir, TMPDIR: dir, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log,
      IDENTITY_READY: join(dir, 'ready'), FAKE_BIN: fakeBin, LEXICONBAR_SIGN_KEYCHAIN: keychain,
      LEXICONBAR_SIGN_PASSWORD_FILE: join(dir, 'password'), SKIP_ICON: '1' };
    for (const script of ['make-signing-identity.sh', 'build-macos-app.sh']) {
      const result = spawnSync('bash', [join(repo, 'scripts', script)], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const probes = calls.filter(c => c[0] === 'security' && c[1] === 'find-identity');
    assert.ok(probes.length >= 2);
    for (const probe of probes) assert.deepEqual(probe, ['security', 'find-identity', '-p', 'codesigning', keychain]);
    const signs = calls.filter(c => c[0] === 'codesign' && c.includes('--sign'));
    assert.equal(signs.length, 2);
    assert.deepEqual(signs.map(c => c.slice(0, -1)), Array(2).fill(['codesign', '--force', '--options', 'runtime', '--timestamp=none', '--sign', 'LexiconBar Local Signing', '--keychain', keychain]));
    assert.equal(calls.some(c => c[0] === 'security' && c[1] === 'list-keychains' && c.includes('-s')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
