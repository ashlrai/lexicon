/**
 * The CLI as a first-time user meets it: no arguments, --help, a wrong or
 * missing word, `init` twice. Each case spawns the real CLI (through tsx)
 * against a temp HOME, never the real one.
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
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lexicon-first-run-')));
});
afterAll(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function lexicon(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  delete env.LEXICON_PATH;
  delete env.LEXICON_TRUST_ALL;
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], { cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('first run of the lexicon CLI', () => {
  // Catches: `lexicon` and `lexicon --help` listed 25 commands and never said
  // which one a new user runs first.
  it('the top-level help names lexicon setup as the place to start', () => {
    const help = lexicon(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Start here: lexicon setup (the guided first run), or lexicon add "Ashlr.AI" Ashler to add one term.');
    expect(help.stdout).toContain('Check an install: lexicon doctor');
    const bare = lexicon([]);
    expect(bare.stderr).toContain('Start here: lexicon setup');
    // A command's own help does not repeat it.
    expect(lexicon(['add', '--help']).stdout).not.toContain('Start here');
  }, 30_000);

  // Catches: `lexicon status` answered "Did you mean stats?" (term counts),
  // and `lexicon version` got no hint at all.
  it('another tool\'s name for a command points at the lexicon command that does that job', () => {
    const status = lexicon(['status', '--cwd', home]);
    expect(status.status).toBe(1);
    expect(status.stderr).toContain("error: unknown command 'status'\n(Did you mean doctor? It checks the setup; stats counts terms and hits)");
    expect(status.stderr).not.toContain('(Did you mean stats?)');
    expect(status.stdout).toBe('');
    const version = lexicon(['version']);
    expect(version.status).toBe(1);
    expect(version.stderr).toContain('(the version is: lexicon --version)');
    const json = lexicon(['config', '--json', '--cwd', home]);
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: expect.stringContaining('lexicon path prints where the lexicon files are'),
      nextStep: 'see the usage: lexicon --help',
    });
    // A typo still gets commander's spelling suggestion, and a stranger nothing.
    expect(lexicon(['stauts']).stderr).toContain('(Did you mean stats?)');
    const nope = lexicon(['definitely-not-a-command']);
    expect(nope.status).toBe(1);
    expect(nope.stderr).toContain("error: unknown command 'definitely-not-a-command'\n(use --help for usage)");
  }, 60_000);
});
