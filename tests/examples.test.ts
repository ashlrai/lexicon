/**
 * The files in examples/ are what people copy first, so they must keep
 * running. Each runs as a real child process against the real core, with
 * LEXICON_PATH and HOME cleared so a developer's own lexicon cannot leak in.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const home = mkdtempSync(path.join(tmpdir(), 'lexicon-examples-home-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function runExample(file: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  delete env.LEXICON_PATH;
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.join('examples', file)], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe('examples/', () => {
  it('stt-pipeline.ts fixes every misheard term before the LLM sees it', () => {
    const r = runExample('stt-pipeline.ts');
    expect(r.err).toBe('');
    expect(r.status).toBe(0);
    expect(r.out).toContain('-> LLM receives: ask Ashlr.AI to move the PostgreSQL cluster to Hetzner and ping Mason Wyatt');
  }, 60_000);

  it('library-usage.ts walks normalize, addTerm, harvest and export', () => {
    const r = runExample('library-usage.ts');
    expect(r.status).toBe(0);
    expect(r.out).toContain('output:   ask Ashlr.AI to deploy Pydantic on Hetzner');
    expect(r.out).toContain('addTerm(): created Deepgram');
    expect(r.out).toContain('send the Deepgram transcript to Mason Wyatt');
    expect(r.out).toMatch(/"keywords": \[/);
  }, 60_000);

  it('mcp-config.json points at the lexicon-mcp bin the package ships', () => {
    const cfg = JSON.parse(readFileSync(path.join(root, 'examples', 'mcp-config.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.bin)).toContain(cfg.mcpServers.lexicon.command);
  });

  it('claude-settings.hook.json runs plugin/hook.mjs on both hook events', () => {
    const cfg = JSON.parse(readFileSync(path.join(root, 'examples', 'claude-settings.hook.json'), 'utf8'));
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const cmd: string = cfg.hooks[event][0].hooks[0].command;
      expect(cmd).toMatch(/plugin\/hook\.mjs"$/);
    }
    expect(readFileSync(path.join(root, 'plugin', 'hook.mjs'), 'utf8').length).toBeGreaterThan(0);
  });
});
