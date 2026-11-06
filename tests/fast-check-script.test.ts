import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// Fast, hermetic coverage of the test-selection logic in scripts/fast-check.sh.
// tsc and vitest are replaced by stubs in a throwaway repo, so no real compile
// or test run happens; tests/fast-check.test.ts covers the real toolchain.
const script = fileURLToPath(new URL('../scripts/fast-check.sh', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'lexicon-fast-check-script-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' });

function write(cwd: string, file: string, body = 'x\n') {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), body);
}

let counter = 0;
let repo: string;

function stub(name: string, body: string) {
  const path = join(repo, 'node_modules/.bin', name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  repo = join(temporary, `repo-${counter++}`);
  mkdirSync(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  write(repo, '.gitignore', 'node_modules\n');
  for (const file of ['tests/old.test.ts', 'src/old.ts', 'scripts/fast-check.sh', 'README.md',
    'tsconfig.json', 'extension/tsconfig.json', 'site/tsconfig.json']) write(repo, file);
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'base');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  stub('tsc', 'exit "${FAKE_TSC_STATUS:-0}"');
  // Record argv one entry per line; fail when any selected test file says FAILME.
  stub('vitest', 'printf "%s\\n" "$@" > "$(git rev-parse --git-dir)/vitest-args"\n' +
    'for a in "$@"; do [[ -f $a ]] && grep -q FAILME "$a" && { echo "boom in $a" >&2; exit 1; }; done\nexit 0');
});

function run(env: Record<string, string> = {}) {
  const home = mkdtempSync(join(temporary, 'home-'));
  const result = spawnSync('bash', [script], {
    cwd: repo, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, HOME: home, ...env },
  });
  const argsFile = join(repo, '.git/vitest-args');
  const args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8').trim().split('\n') : null;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, args };
}

const CHANGED = ['run', '--changed', 'origin/main', '--passWithNoTests'];
const direct = (...files: string[]) => ['run', ...files, '--passWithNoTests'];

describe('fast-check.sh test selection', () => {
  it('runs only an untracked test file directly', () => {
    write(repo, 'tests/new.test.ts');
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^PASS typecheck\nPASS lint\nPASS tests\nTotal: \d+s\n$/);
    expect(r.args).toEqual(direct('tests/new.test.ts'));
  });

  it('selects tests changed in commits ahead of origin/main and in the working tree, once each', () => {
    write(repo, 'tests/committed.test.ts');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'ahead');
    write(repo, 'tests/old.test.ts', 'edited\n');
    write(repo, 'bench/b.test.ts');
    write(repo, 'src/inline.test.ts');
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect([...(r.args ?? [])].sort()).toEqual(
      direct('bench/b.test.ts', 'src/inline.test.ts', 'tests/committed.test.ts', 'tests/old.test.ts').sort());
  });

  it('handles file names containing spaces', () => {
    write(repo, 'tests/with space.test.ts');
    expect(run().args).toEqual(direct('tests/with space.test.ts'));
  });

  it('ignores a test file deleted in the working tree and falls back to --changed', () => {
    rmSync(join(repo, 'tests/old.test.ts'));
    expect(run().args).toEqual(CHANGED);
  });

  it('falls back to --changed when a source file changes alongside a test', () => {
    write(repo, 'tests/new.test.ts');
    write(repo, 'src/old.ts', 'changed\n');
    expect(run().args).toEqual(CHANGED);
  });

  it('falls back to --changed for non-test files that are not markdown', () => {
    write(repo, 'package.json', '{}');
    expect(run().args).toEqual(CHANGED);
  });

  it('treats markdown-only changes as having no direct tests', () => {
    write(repo, 'README.md', 'docs\n');
    expect(run().args).toEqual(CHANGED);
  });

  it('does not treat test-looking files outside tests, src and bench as tests', () => {
    write(repo, 'extension/x.test.ts');
    expect(run().args).toEqual(CHANGED);
  });

  it('selects tests/fast-check.test.ts when the script itself changes', () => {
    write(repo, 'tests/fast-check.test.ts');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'add test');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    write(repo, 'scripts/fast-check.sh', 'edited\n');
    expect(run().args).toEqual(direct('tests/fast-check.test.ts'));
  });

  it('falls back to --changed when the script changes but tests/fast-check.test.ts is absent', () => {
    write(repo, 'scripts/fast-check.sh', 'edited\n');
    expect(run().args).toEqual(CHANGED);
  });

  it('falls back to --changed on a clean tree', () => {
    expect(run().args).toEqual(CHANGED);
  });
});

describe('fast-check.sh exit status', () => {
  it('exits nonzero and reports the failure when a selected test fails', () => {
    write(repo, 'tests/bad.test.ts', 'FAILME\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^PASS typecheck\nPASS lint\nFAIL tests\nTotal: \d+s\n$/);
    expect(r.stderr).toContain('boom in tests/bad.test.ts');
  });

  it('fails when only one of several selected tests fails', () => {
    write(repo, 'tests/good.test.ts');
    write(repo, 'tests/bad.test.ts', 'FAILME\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.args).toEqual(expect.arrayContaining(['tests/good.test.ts', 'tests/bad.test.ts']));
  });

  it('propagates a failure from the --changed fallback', () => {
    write(repo, 'src/old.ts', 'changed\n');
    stub('vitest', 'echo "changed run failed" >&2; exit 1');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL tests\n');
    expect(r.stderr).toContain('changed run failed');
  });

  it('fails closed without origin/main and never runs vitest', () => {
    git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
    write(repo, 'tests/new.test.ts');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL tests\n');
    expect(r.stderr).toContain('Missing origin/main');
    expect(r.args).toBeNull();
  });

  it('stops at a failed typecheck before selecting tests', () => {
    write(repo, 'tests/new.test.ts');
    const r = run({ FAKE_TSC_STATUS: '2' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^FAIL typecheck\nTotal: \d+s\n$/);
    expect(r.args).toBeNull();
  });
});
