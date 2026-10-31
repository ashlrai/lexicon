import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundleDir = mkdtempSync(path.join(os.tmpdir(), 'lexicon-brand-cli-'));
const cli = path.join(bundleDir, 'cli.mjs');
after(() => rmSync(bundleDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
// Match bundleChildEntry in tests/helpers.ts: compile once so subprocesses do
// not repeatedly transform TypeScript or contend with each other's startup.
before(async () => {
  await build({
    entryPoints: [path.join(root, 'src/cli/index.ts')],
    outfile: cli,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    legalComments: 'none',
    logLevel: 'silent',
  });
});

// Issue #218: exercise the real CLI and saved YAML, including author parsing,
// rather than only the company-guess helper. The remote deliberately disagrees.
const cases = [
  ['@ashlr/lexicon', 'Ashlr.AI', 'Ashlr.AI'],
  ['@ashlr.ai/lexicon', 'Ashlr.AI <hello@example.com> (https://example.com)', 'Ashlr.AI'],
  ['@ashlr.ai/ashlr.ai', { name: 'Ashlr.AI', email: 'hello@example.com' }, 'Ashlr.AI'],
  ['@Ashlr.AI/lexicon', undefined, 'Ashlr.AI'],
  ['@ashlr.ai/lexicon', undefined, 'Ashlr.ai'],
  ['@acme.voice.ai/transcriber', 'Acme.Voice.AI', 'Acme.Voice.AI'],
  ['@acme.voice.ai/transcriber', 'Other.Voice.AI', 'Acme.voice.ai'],
  ['@ashlr.voice/transcriber', 'Ashlr.Voiceover.AI', 'Ashlr.voice'],
  ['@ash/lexicon', 'Ashlr.AI', 'Ash'],
  ['plain-package', 'Ashlr.AI', 'remote-org'],
];

for (const [name, author, expected] of cases) {
  test(`setup preserves the evidenced brand for ${name} with author ${JSON.stringify(author)}`, (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'lexicon-dotted-brand-'));
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'repo');
    mkdirSync(home);
    mkdirSync(cwd);
    const lexiconPath = path.join(home, '.config', 'lexicon', 'lexicon.yaml');
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      LEXICON_PATH: lexiconPath,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '0',
    };
    const run = (file, args) => {
      const result = spawnSync(file, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    run('git', ['init', '--quiet']);
    run('git', ['remote', 'add', 'origin', 'https://github.com/remote-org/repo.git']);
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name, author }));
    const command = (args) => run(process.execPath, [cli, '--cwd', cwd, ...args]);
    const setup = (...args) => JSON.parse(command([
      'setup', '--yes', '--json', '--person', 'Jane Doe', '--clients', 'none',
      '--no-packs', '--no-harvest', '--no-serve', '--app', 'none', ...args,
    ]));
    const brands = () => parse(readFileSync(lexiconPath, 'utf8')).terms
      .filter((term) => term.category === 'brand').map((term) => term.canonical);

    const preview = setup('--dry-run');
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.wouldSeed, ['Jane Doe', expected]);
    assert.equal(existsSync(lexiconPath), false, 'preview must not create the lexicon');

    const applied = setup();
    assert.equal(applied.ok, true);
    assert.deepEqual(applied.termsAdded, preview.wouldSeed);
    assert.deepEqual(brands(), [expected]);
    assert.equal(existsSync(path.join(cwd, '.lexicon.yaml')), false);

    if (expected === 'Ashlr.AI') {
      assert.equal(applied.demo.usedExample, false);
      assert.ok(applied.demo.corrected.includes(expected));
      assert.equal(command(['normalize', 'Ship Ashler today.']).trim(), 'Ship Ashlr.AI today.');
    }

    const repeated = setup('--reseed');
    assert.equal(repeated.ok, true);
    assert.deepEqual(repeated.termsAdded, []);
    assert.deepEqual(brands(), [expected], 'reseeding must preserve spelling without duplicates');
  });
}
