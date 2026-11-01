import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'lexicon-fast-check-'));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function checkout(name: string) {
  const cwd = join(temporary, name);
  execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', root, cwd]);
  // Smoke-test the gate with real configs and a dependency-free source file.
  // The parent gate checks the full product; repeating it here wastes its budget.
  execFileSync('git', ['sparse-checkout', 'set', '--no-cone',
    '/.gitignore', '/package.json', '/tsconfig.json', '/vitest.config.ts',
    '/src/util/errors.ts', '/extension/tsconfig.json', '/extension/src/modules.d.ts',
    '/site/tsconfig.json', '/site/modules.d.ts'], { cwd });
  execFileSync('git', ['checkout', '--quiet'], { cwd });
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd });
  appendFileSync(join(cwd, '.git/info/exclude'), '\nnode_modules\n');
  symlinkSync(resolve(root, 'node_modules'), join(cwd, 'node_modules'), 'junction');
  return cwd;
}

async function check(cwd: string) {
  const home = mkdtempSync(join(temporary, 'home-'));
  const start = performance.now();
  const result = await new Promise<{
    status: number | string | null; stdout: string; stderr: string; error: Error | undefined;
  }>((done) => {
    execFile('bash', [join(root, 'scripts/fast-check.sh').replaceAll('\\', '/')], {
      cwd, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
    }, (error, stdout, stderr) => done({
      status: error ? error.code ?? null : 0, stdout, stderr,
      error: error && typeof error.code !== 'number' ? error : undefined,
    }));
  });
  expect(result.error, result.stdout + result.stderr).toBeUndefined();
  expect(performance.now() - start).toBeLessThanOrEqual(120_000);
  expect(result.stdout).toMatch(/Total: \d+s\n$/);
  return result;
}

describe('fast-check', () => {
  it.concurrent('passes a clean checkout within 120 seconds', async () => {
    const cwd = checkout('clean');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })).toBe('');
    const result = await check(cwd);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^PASS typecheck\nPASS lint\nPASS tests\n/);
  }, 125_000);

  it.concurrent('fails fast for a seeded type error in a temporary copy', async () => {
    const cwd = checkout('type-error');
    writeFileSync(join(cwd, 'src/fast-check-error.ts'), 'export const broken: string = 123;\n');
    const result = await check(cwd);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^FAIL typecheck\nTotal: \d+s\n$/);
    expect(result.stderr).toContain('TS2322');
  }, 125_000);

  it.concurrent('runs an affected test and propagates its failure', async () => {
    const cwd = checkout('test-failure');
    mkdirSync(join(cwd, 'tests'));
    writeFileSync(join(cwd, 'src/probe.ts'), 'export const value = 1;\n');
    writeFileSync(join(cwd, 'tests/affected.test.ts'),
      "import { test, expect } from 'vitest';\n" +
      "import { value } from '../src/probe.js';\n" +
      "test('fast-check affected probe', () => expect(value).toBe(2));\n");
    const result = await check(cwd);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^PASS typecheck\nPASS lint\nFAIL tests\n/);
    expect(result.stderr).toContain('fast-check affected probe');
  }, 125_000);

});
