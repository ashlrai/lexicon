/**
 * `lexicon` with no arguments, the first thing a new user types. It must
 * print the usage text and exit on its own, never with a stack trace. The
 * test spawns the real CLI (through tsx) against a temp HOME, never the real one.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let home: string;

beforeAll(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lexicon-no-args-')));
});
afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function bareLexicon(): { status: number | null; signal: NodeJS.Signals | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  delete env.LEXICON_PATH;
  delete env.LEXICON_TRUST_ALL;
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts'], { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, signal: r.signal, output: `${r.stdout}${r.stderr}` };
}

describe('lexicon with no arguments', () => {
  it('ignores a literal top-level home directory and tracks no files in it', () => {
    const ignored = spawnSync('git', ['check-ignore', '--no-index', '-q', '~/.npm/_update-notifier-last-checked'], { cwd: repoRoot });
    const tracked = spawnSync('git', ['ls-files', '--', '~'], { cwd: repoRoot, encoding: 'utf8' });
    expect(ignored.status).toBe(0);
    expect(tracked.status).toBe(0);
    expect(tracked.stdout).toBe('');
  });
  // Catches: a bare `lexicon` that crashed with an unhandled error (a stack
  // trace on stderr) instead of showing the usage a new user needs.
  it('prints the usage text and exits on its own, without a stack trace', () => {
    const run = bareLexicon();
    expect(run.signal).toBeNull();
    expect(run.status).not.toBeNull();
    expect(run.output).toContain('Usage: lexicon [options] [command]');
    expect(run.output).toContain('Commands:');
    expect(run.output).not.toMatch(/^\s+at\s/m);
    expect(run.output).not.toMatch(/\b(TypeError|ReferenceError|SyntaxError|RangeError):/);
    expect(run.output).not.toMatch(/^Error: /m);
  }, 30_000);

  // Catches: the bare run exiting 0, which scripts read as success for a
  // command that was never given. Commander's "no command" exit is 1.
  it('exits 1, the code for a run with no command', () => {
    expect(bareLexicon().status).toBe(1);
  }, 30_000);
});
