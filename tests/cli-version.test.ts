/**
 * `lexicon --version` must print the version in package.json, exactly, and
 * nothing else. Scripts and the doctor read this string, so a stale or wrong
 * value is a bug users feel. The test spawns the real CLI (through tsx) against
 * a temp HOME, never the real one, and reads package.json itself so it does not
 * trust the helper it is checking.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected: string = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
let home: string;

beforeAll(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lexicon-version-')));
});
afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function runCli(entry: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  delete env.LEXICON_PATH;
  delete env.LEXICON_TRUST_ALL;
  const r = spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('lexicon --version', () => {
  // Catches: the printed version drifting from package.json, e.g. a hard-coded
  // string left behind after a release bump, or the helper falling back to 0.0.0.
  it('prints exactly the package.json version on stdout', () => {
    const run = runCli('src/cli/index.ts', ['--version']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${expected}\n`);
    expect(run.stderr).toBe('');
  }, 30_000);

  // Catches: the short aliases answered by a different code path that reads
  // the version from somewhere else (or not at all).
  it.each(['-V', '-v'])('prints the same version for %s', (flag) => {
    const run = runCli('src/cli/index.ts', [flag]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${expected}\n`);
  }, 30_000);

  // Catches: the MCP server's --version drifting from the CLI's, since both
  // are shipped from this package and users compare them.
  it('lexicon-mcp --version prints the same package.json version', () => {
    const run = runCli('src/mcp/server.ts', ['--version']);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`${expected}\n`);
  }, 30_000);
});
