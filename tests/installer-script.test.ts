import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const installer = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
let home: string;
let log: string;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function stub(name: string, body: string): void {
  writeFileSync(path.join(home, 'bin', name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-script-install-'));
  mkdirSync(path.join(home, 'bin'));
  log = path.join(home, 'npm.log');
  writeFileSync(log, '');
  // The real shell script runs, but no npm install, HTTP request or setup does.
  // Node's JSON/version parsers still execute in the real Node runtime.
  stub('node', `if [ "$1" = "--version" ]; then printf '%s\\n' "$TEST_NODE_VERSION"; else exec ${shellQuote(process.execPath)} "$@"; fi`);
  stub('npm', `printf '%s\\n' "$*" >> "$TEST_NPM_LOG"
case "$1" in
  view) printf '%s\\n' "$TEST_NPM_VERSION"; exit "$TEST_NPM_CODE" ;;
  install) exit "$TEST_INSTALL_CODE" ;;
  prefix) printf '%s\\n' "$HOME/prefix" ;;
  *) exit 99 ;;
esac`);
  stub('curl', `printf '%s' "$TEST_RELEASE_JSON"; exit "$TEST_CURL_CODE"`);
  stub('lexicon', `if [ "$1" = "--version" ]; then printf '%s\\n' "$TEST_INSTALLED_VERSION"; exit "$TEST_VERSION_CODE"; else printf 'unexpected setup\\n' >&2; exit 99; fi`);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('/bin/sh', [installer], {
    encoding: 'utf8',
    timeout: 10_000,
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      LEXICON_PATH: path.join(home, 'config', 'lexicon.yaml'),
      PATH: `${path.join(home, 'bin')}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      LEXICON_REF: '',
      LEXICON_NO_SETUP: '1',
      TEST_NPM_LOG: log,
      TEST_NODE_VERSION: 'v22.22.3',
      TEST_NPM_CODE: '0',
      TEST_NPM_VERSION: '0.5.4',
      TEST_INSTALL_CODE: '0',
      TEST_RELEASE_JSON: '{"tag_name":"v0.5.4","draft":false,"prerelease":false}',
      TEST_CURL_CODE: '0',
      TEST_INSTALLED_VERSION: '0.5.4',
      TEST_VERSION_CODE: '0',
      ...overrides,
    },
  });
  expect(result.error).toBeUndefined();
  return { ...result, calls: readFileSync(log, 'utf8') };
}

describe.skipIf(process.platform === 'win32')('POSIX install script version and first-run lifecycle', () => {
  it('pins the registry version it discovered instead of a mutable dist-tag', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.calls).toContain('install -g @ashlr/lexicon@0.5.4\n');
    expect(result.calls).not.toContain('install -g @ashlr/lexicon\n');
    expect(result.stdout).toContain('skipping setup');
  });

  it('accepts compact release JSON and pins its stable tag when npm fails with partial valid output', () => {
    const result = run({ TEST_NPM_CODE: '1' });
    expect(result.status).toBe(0);
    expect(result.calls).toContain('install -g github:ashlrai/lexicon#v0.5.4\n');
  });

  it('stops without installing when both discovery routes fail, even with partial curl output', () => {
    const result = run({ TEST_NPM_CODE: '1', TEST_CURL_CODE: '22' });
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain('install -g');
    expect(result.stderr).toContain('could not resolve a published version');
    expect(result.stderr).toContain('LEXICON_REF');
  });

  it.each([
    'not JSON',
    '{}',
    '{"tag_name":"main"}',
    '{"tag_name":"v0.5.4-beta.1"}',
    '{"tag_name":"v0.5.4","draft":true}',
    '{"tag_name":"v0.5.4","prerelease":true}',
  ])('never falls back to a branch for invalid release data: %s', (release) => {
    const result = run({ TEST_NPM_CODE: '1', TEST_RELEASE_JSON: release });
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain('install -g');
    expect(result.stderr).toContain('stable version');
  });

  it.each(['latest', '--version'])('requires a valid stable version even when npm exits successfully: %s', (version) => {
    const result = run({ TEST_NPM_VERSION: version, TEST_RELEASE_JSON: '{}' });
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain('install -g');
  });

  it('retains an explicit reviewed ref as the only branch-install route', () => {
    const result = run({ LEXICON_REF: 'main', TEST_NPM_CODE: '1', TEST_CURL_CODE: '22' });
    expect(result.status).toBe(0);
    expect(result.calls).toBe('install -g github:ashlrai/lexicon#main\n');
  });

  it('refuses setup when PATH still selects an older Lexicon executable', () => {
    const result = run({ TEST_INSTALLED_VERSION: '0.5.3' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expected 0.5.4');
    expect(result.stdout).not.toContain('installed lexicon');
  });

  it('reports a failed version probe before claiming success', () => {
    const result = run({ TEST_VERSION_CODE: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not answer --version');
  });
});
