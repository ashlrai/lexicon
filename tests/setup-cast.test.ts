import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('runs the documented cast commands with the recorded answers in an isolated home', () => {
  const outline = readFileSync(path.join(process.cwd(), 'docs/setup-cast-outline.md'), 'utf8');
  const commands = [...outline.matchAll(/^   (node "\$cast_cli" (?:setup|normalize) .+)$/gm)].map((m) => m[1]);
  expect(commands).toHaveLength(2);
  const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-cast-'));
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    LEXICON_PATH: path.join(home, 'lexicon.yaml'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href}`,
    cast_cli: path.join(process.cwd(), 'src/cli/index.ts'),
  };
  try {
    // Interactive prompt wording and answers are exercised in setup.test.ts.
    const setup = spawnSync('sh', ['-c', `${commands[0]} --yes --company Ashlr.AI --phonetic ASH-ler`], { cwd: home, env, encoding: 'utf8' });
    expect(setup.status, setup.stderr).toBe(0);
    expect(setup.stdout).toContain('Does it work?');
    expect(setup.stdout).toContain('Ashlr.AI');
    const normalize = spawnSync('sh', ['-c', commands[1]], { cwd: home, env, encoding: 'utf8' });
    expect(normalize.status, normalize.stderr).toBe(0);
    expect(normalize.stdout.trim()).toBe('ping Ashlr.AI about the launch');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 90_000);
