import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Large enough to exercise persistent parse caches on an ordinary read.
const seed = 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler, Ashlar]\n' + '# padding\n'.repeat(1200);

function fixture(t) {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lexicon-cli-preview-')));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const repo = path.join(home, 'repo');
  const global = path.join(home, '.config', 'lexicon', 'lexicon.yaml');
  const project = path.join(repo, '.lexicon.yaml');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'), LEXICON_PATH: global,
    LEXICON_TRUST_ALL: '', NODE_DISABLE_COMPILE_CACHE: '1',
  };
  function cli(args, status = 0) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--cwd', repo, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    return result;
  }
  function write(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, seed);
  }
  // Comparing metadata too catches rewriting identical bytes. The whole home
  // catches newly created lexicons, trust pins, backups, locks and caches.
  function snapshot() {
    return readdirSync(home, { recursive: true }).sort().map((name) => {
      const file = path.join(home, name);
      const stat = statSync(file, { bigint: true });
      return [name, {
        ...(stat.isDirectory() ? { directory: true } : { bytes: readFileSync(file) }),
        mtime: stat.mtimeNs, ctime: stat.ctimeNs, mode: stat.mode,
      }];
    });
  }
  function preview(args, text, proposed, status = 0) {
    const before = snapshot();
    const plain = cli([...args, '--dry-run'], status);
    assert.match(status === 0 ? plain.stdout : plain.stderr, text);
    assert.deepEqual(snapshot(), before, `${args[0]} text preview wrote to HOME`);
    const json = cli([...args, '--dry-run', '--json'], status);
    const result = JSON.parse(json.stdout);
    for (const [key, value] of Object.entries(proposed)) assert.deepEqual(result[key], value, key);
    assert.deepEqual(snapshot(), before, `${args[0]} JSON preview wrote to HOME`);
  }
  return { cli, write, snapshot, preview, global, project };
}

for (const scope of ['global', 'project']) {
  const flags = scope === 'project' ? ['--project'] : [];
  test(`init --dry-run previews a missing ${scope} file without creating it`, (t) => {
    const f = fixture(t);
    f.preview(['init', ...flags], new RegExp(`would create ${scope} lexicon`), {
      ok: true, dryRun: true, created: true, scope, path: f[scope],
      ...(scope === 'project' ? { trust: 'trusted' } : {}),
    });
    f.cli(['init', ...flags]);
    assert.match(readFileSync(f[scope], 'utf8'), /terms: \[\]/);
    f.preview(['init', ...flags], /lexicon already exists/, {
      ok: true, dryRun: true, created: false, scope, path: f[scope],
    });
  });

  for (const command of ['add', 'remove', 'learn']) {
    test(`${command} --dry-run previews the ${scope} change and preserves both lexicons and trust`, (t) => {
      const f = fixture(t);
      f.write(f.global);
      f.write(f.project);
      f.cli(['trust', '--yes']);
      const args = command === 'add' ? ['add', 'Ashlr.AI', 'Ashlur']
        : command === 'learn' ? ['learn', 'Ashlur', 'Ashlr.AI'] : ['remove', 'Ashlr.AI'];
      // Learn defaults to the existing project term; --global is available
      // only on remove, so isolate the global learning case by revoking trust.
      if (command === 'learn' && scope === 'global') f.cli(['untrust']);
      const scopeFlags = command === 'remove' && scope === 'global' ? ['--global'] : flags;
      f.preview([...args, ...scopeFlags], new RegExp(`would ${command === 'add' ? 'merge' : command} .*Ashlr\\.AI`), {
        ok: true, dryRun: true,
        ...(command === 'remove' ? { removed: true } : { path: f[scope] }),
        ...(command === 'add' || command === 'learn'
          ? { term: { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar', 'Ashlur'] } } : {}),
      });
      const before = readFileSync(f[scope]);
      f.cli([...args, ...scopeFlags]);
      assert.notDeepEqual(readFileSync(f[scope]), before, 'a real run must apply the proposed change');
    });
  }
}

test('untrust --dry-run previews revocation without changing the lexicon or trust registry', (t) => {
  const f = fixture(t);
  f.write(f.global);
  f.write(f.project);
  f.cli(['trust', '--yes']);
  for (const args of [['untrust'], ['untrust', f.project]]) {
    f.preview(args, /would untrust .*\.lexicon\.yaml/, { ok: true, dryRun: true, removed: true, path: f.project });
  }
  const registry = path.join(path.dirname(f.global), 'trust.json');
  const before = readFileSync(registry);
  f.cli(['untrust']);
  assert.notDeepEqual(readFileSync(registry), before);
});

test('project mutation dry runs retain the trust gate and preserve unreviewed files', (t) => {
  const f = fixture(t);
  f.write(f.global);
  f.write(f.project);
  for (const args of [['add', 'Ashlr.AI', 'Ashlur'], ['remove', 'Ashlr.AI'], ['learn', 'Ashlur', 'Ashlr.AI']]) {
    f.preview([...args, '--project'], /untrusted/, { ok: false }, 1);
  }
});
