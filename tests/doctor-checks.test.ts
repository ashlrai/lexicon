/**
 * `lexicon doctor` checks driven against the real core: the conflict
 * summary, the `claude mcp list` match, and the state files next to the
 * global lexicon. Temp dirs only: both lexicons, HOME and every state file
 * are under a fresh directory, reached through the doctor's own env.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctorReport } from '../src/cli/cmd-doctor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(globalYaml = 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n'): {
  home: string;
  repo: string;
  cfg: string;
  bin: string;
  globalPath: string;
  env: NodeJS.ProcessEnv;
} {
  const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-doctor-checks-'));
  dirs.push(home);
  const cfg = path.join(home, 'cfg');
  const repo = path.join(home, 'repo');
  const bin = path.join(home, 'bin');
  mkdirSync(cfg);
  mkdirSync(bin);
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const globalPath = path.join(cfg, 'lexicon.yaml');
  writeFileSync(globalPath, globalYaml);
  return { home, repo, cfg, bin, globalPath, env: { PATH: '', LEXICON_PATH: globalPath } };
}

describe('doctor conflict summary', () => {
  // Catches: the "no alias/canonical conflicts" line was left out whenever
  // any failing check's text held the word "conflict", here a term named
  // "conflict kit" defined twice, though no alias equals another canonical.
  it('says there are no alias/canonical conflicts when the only failure merely names the word', async () => {
    const t = setup(
      'version: 1\nterms:\n  - canonical: conflict kit\n    aliases: [conflict kid]\n  - canonical: Conflict Kit\n    aliases: [konflikt kit]\n',
    );
    const report = await runDoctorReport({ cwd: t.repo }, { home: t.home, env: t.env, platform: 'linux', exec: () => '' });
    expect(report.checks).toContainEqual({ level: 'fail', message: '"conflict kit" is defined 2 times in the global lexicon' });
    expect(report.checks).toContainEqual({ level: 'ok', message: 'no alias/canonical conflicts' });
  });

  it('leaves the line out when an alias equals another canonical', async () => {
    const t = setup('version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Vercel]\n  - canonical: Vercel\n    aliases: [versel]\n');
    const report = await runDoctorReport({ cwd: t.repo }, { home: t.home, env: t.env, platform: 'linux', exec: () => '' });
    expect(report.checks.some((c) => c.level === 'fail' && c.message.endsWith('(conflict)'))).toBe(true);
    expect(report.checks.some((c) => c.message === 'no alias/canonical conflicts')).toBe(false);
  });
});

describe('doctor and claude mcp list', () => {
  function withClaude(): ReturnType<typeof setup> {
    const t = setup();
    const claude = path.join(t.bin, 'claude');
    writeFileSync(claude, '#!/bin/sh\nexit 0\n');
    chmodSync(claude, 0o755);
    t.env = { ...t.env, PATH: t.bin };
    return t;
  }
  const registered = (report: Awaited<ReturnType<typeof runDoctorReport>>): boolean =>
    report.checks.some((c) => c.message === 'lexicon MCP server is registered with claude');

  // Catches: any output holding the word "lexicon" (a `lexicon-foo` server,
  // or a path in another server's command) read as lexicon registered.
  it('takes only a server named exactly lexicon as registered', async () => {
    const t = withClaude();
    const run = (out: string) => runDoctorReport({ cwd: t.repo }, { home: t.home, env: t.env, platform: 'linux', exec: () => out });
    const foreign = await run('Checking MCP server health...\n\nlexicon-foo: node /opt/lexicon-foo/server.js - ✓ Connected\nnotes: node /home/me/lexicon/notes.js - ✓ Connected\n');
    expect(registered(foreign)).toBe(false);
    expect(foreign.checks).toContainEqual({ level: 'fail', message: 'lexicon MCP server not registered with claude (run: lexicon install claude --apply)' });
    expect(registered(await run('Checking MCP server health...\n\nlexicon: node /opt/lexicon/plugin/mcp-server.mjs - ✓ Connected\n'))).toBe(true);
    expect(registered(await run('plugin:lexicon:lexicon: node /x/plugin/mcp-server.mjs - ✓ Connected\n'))).toBe(true);
  });
});
