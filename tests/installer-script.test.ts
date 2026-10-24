import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const installer = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
const hasPython = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }).status === 0;
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
    expect(result.stderr).toContain('fix PATH (command -v lexicon shows which one runs) before running setup');
    expect(result.stdout).not.toContain('installed lexicon');
  });

  // Catches: the permissions fallback `curl ... | sudo sh` went on to run
  // `lexicon setup` as root, writing root's lexicon and agent configs.
  it('installs under sudo but leaves setup to the user', () => {
    stub('id', `if [ "$1" = "-u" ]; then printf '%s\\n' "$TEST_UID"; else exit 99; fi`);
    const root = run({ LEXICON_NO_SETUP: '0', SUDO_USER: 'alice', TEST_UID: '0' });
    expect(root.status).toBe(0);
    expect(root.calls).toContain('install -g @ashlr/lexicon@0.5.4\n');
    expect(root.stdout).toContain('skipping setup under sudo: it would configure root, not alice; as alice, without sudo, run: lexicon setup');
    expect(root.stderr).not.toContain('unexpected setup');
    // A plain user with a stale SUDO_USER in the environment is not root.
    const user = run({ LEXICON_NO_SETUP: '0', SUDO_USER: 'alice', TEST_UID: '501' });
    expect(user.stdout).not.toContain('under sudo');
    expect(user.stdout).toContain('no terminal to ask the setup questions on; run: lexicon setup');
  });

  // Catches: a readable but unopenable /dev/tty (no controlling terminal, as
  // under setsid or some CI runners) counted as a terminal, so the redirect
  // failed and the run ended "setup finished with warnings" instead of
  // skipping setup. stdout is a pty here, stdin a pipe, and the session has no
  // controlling terminal, so `-r /dev/tty` holds but opening it fails.
  it.skipIf(!hasPython)('skips setup when /dev/tty is readable but cannot be opened', () => {
    const helper = [
      'import os, subprocess, sys',
      'master, slave = os.openpty()',
      'p = subprocess.Popen(["/bin/sh", sys.argv[1]], stdin=subprocess.PIPE, stdout=slave, stderr=subprocess.PIPE, start_new_session=True)',
      'os.close(slave)',
      'p.stdin.close()',
      'out = b""',
      'while True:',
      '    try:',
      '        chunk = os.read(master, 4096)',
      '    except OSError:',
      '        break',
      '    if not chunk:',
      '        break',
      '    out += chunk',
      'err = p.stderr.read()',
      'code = p.wait()',
      'sys.stdout.write(out.decode())',
      'sys.stderr.write(err.decode())',
      'sys.exit(code)',
    ].join('\n');
    const result = spawnSync('python3', ['-c', helper, installer], {
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
        LEXICON_NO_SETUP: '0',
        SUDO_USER: '',
        TEST_NPM_LOG: log,
        TEST_NODE_VERSION: 'v22.22.3',
        TEST_NPM_CODE: '0',
        TEST_NPM_VERSION: '0.5.4',
        TEST_INSTALL_CODE: '0',
        TEST_INSTALLED_VERSION: '0.5.4',
        TEST_VERSION_CODE: '0',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('installed lexicon 0.5.4');
    expect(result.stdout).toContain('no terminal to ask the setup questions on; run: lexicon setup');
    expect(result.stdout).not.toContain('finished with warnings');
    expect(result.stderr).not.toContain('unexpected setup');
  });

  // Catches: an unreadable `node --version` stopped with no next step.
  it('names how to install Node when its version cannot be read', () => {
    const result = run({ TEST_NODE_VERSION: 'garbage' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not read the Node version from: garbage');
    expect(result.stderr).toContain('Install Node 20 or newer first:');
    expect(result.stderr).toContain('nvm install --lts');
    expect(result.calls).toBe('');
  });

  it('reports a failed version probe before claiming success', () => {
    const result = run({ TEST_VERSION_CODE: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not answer --version');
    // Catches: the failure named no next step.
    expect(result.stderr).toContain(
      'lexicon install: the installed lexicon did not answer --version; run lexicon --version to see its error, then rerun this installer\n',
    );
  });

  it('names the npm bin directory when lexicon is there but not on PATH', () => {
    rmSync(path.join(home, 'bin', 'lexicon'));
    mkdirSync(path.join(home, 'prefix', 'bin'), { recursive: true });
    writeFileSync(path.join(home, 'prefix', 'bin', 'lexicon'), '#!/bin/sh\n', { mode: 0o755 });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`lexicon is installed in ${path.join(home, 'prefix', 'bin')} but that directory is not on PATH`);
  });

  // Catches: on Windows (Git Bash, MSYS) npm's shims are in the prefix
  // itself, so `$(npm prefix -g)/bin/lexicon` was never there and the hint
  // named a bin directory that does not exist.
  it('on MINGW/MSYS names the npm prefix itself, converted with cygpath', () => {
    rmSync(path.join(home, 'bin', 'lexicon'));
    stub('uname', `printf 'MINGW64_NT-10.0-19045\\n'`);
    mkdirSync(path.join(home, 'prefix'), { recursive: true });
    writeFileSync(path.join(home, 'prefix', 'lexicon'), '#!/bin/sh\n', { mode: 0o755 });
    const plain = run();
    expect(plain.status).toBe(1);
    expect(plain.stderr).toContain(`lexicon is installed in ${path.join(home, 'prefix')} but that directory is not on PATH`);
    expect(plain.stderr).toContain('add the directory npm prefix -g prints (npm on Windows has no bin/ under it)\n');
    expect(plain.stderr).not.toContain('bin directory under');

    stub('npm', `case "$1" in install) exit 0 ;; view) printf '0.5.4\\n' ;; prefix) printf '%s\\n' 'C:\\Users\\me\\AppData\\Roaming\\npm' ;; esac`);
    stub('cygpath', `[ "$1" = "-u" ] && [ "$2" = 'C:\\Users\\me\\AppData\\Roaming\\npm' ] && printf '%s\\n' "$HOME/prefix"`);
    const converted = run();
    expect(converted.stderr).toContain(`lexicon is installed in ${path.join(home, 'prefix')} but that directory is not on PATH`);
  });

  it('names a next step when the installed lexicon is not on PATH', () => {
    rmSync(path.join(home, 'bin', 'lexicon'));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'lexicon install: lexicon not on PATH; open a new terminal (or run: hash -r) and run: lexicon --version, and if it is still missing, add the bin directory under: npm prefix -g\n',
    );
  });
});

// Catches: docs said the installer "then runs lexicon setup", which it does
// not without a terminal, under sudo or with LEXICON_NO_SETUP=1.
describe('install docs describe when the script runs setup', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  it.each(['docs/FAQ.md', 'README.md', 'docs/QUICKSTART.md', 'docs/AGENTS.md', 'web/lib/site.ts'])('%s names the cases it skips setup', (file) => {
    const text = readFileSync(path.join(repo, file), 'utf8');
    expect(text).not.toMatch(/CLI and then runs `lexicon setup`/);
    expect(text).not.toMatch(/CLI, then runs\s+`lexicon setup`\./);
    expect(text).toMatch(/terminal/);
    expect(text).toMatch(/`sudo`/);
    expect(text).toContain('LEXICON_NO_SETUP=1');
  });
});

// Catches: the branches that skip setup told the user to run it in two forms,
// `run: lexicon setup` (sudo, LEXICON_NO_SETUP) and `next: run  lexicon setup`
// (no terminal, with two spaces), and the docs quoted a third, `run lexicon setup`.
describe('every branch that skips setup names it the same way', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  it('the script ends each skip line with run: lexicon setup', () => {
    const script = readFileSync(installer, 'utf8');
    const lines = script.split('\n').filter((l) => /^\s*say ".*lexicon setup"$/.test(l) && !/rerun/.test(l));
    expect(lines.length).toBe(3);
    for (const l of lines) expect(l).toMatch(/[;,] run: lexicon setup"$/);
    expect(script).not.toContain('next: run');
  });
  it.each(['docs/FAQ.md', 'docs/AGENTS.md', 'web/lib/site.ts'])('%s quotes the line the script prints', (file) => {
    const text = readFileSync(path.join(repo, file), 'utf8');
    expect(text).toContain('`run: lexicon setup`');
    expect(text).not.toContain('`run lexicon setup`');
    expect(text).not.toContain('next: run');
  });
});
