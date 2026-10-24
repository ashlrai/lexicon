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

describe('doctor and the state files beside the global lexicon', () => {
  const run = (t: ReturnType<typeof setup>) => runDoctorReport({ cwd: t.repo }, { home: t.home, env: t.env, platform: 'linux', exec: () => '' });
  const stateWarnings = (report: Awaited<ReturnType<typeof runDoctorReport>>): string[] =>
    report.checks
      .filter((c) => c.level === 'warn' && /^(serve\.json|hits\.json|pending corrections queue|index cache) /.test(c.message))
      .map((c) => c.message);

  it('says nothing of state files that are missing or fine', async () => {
    const t = setup();
    expect(stateWarnings(await run(t))).toEqual([]);
    writeFileSync(path.join(t.cfg, 'serve.json'), JSON.stringify({ port: 41733, token: 'ab'.repeat(16), createdAt: '2026-01-01T00:00:00.000Z' }));
    writeFileSync(path.join(t.cfg, 'hits.json'), JSON.stringify({ version: 1, projects: {}, global: { 'ashlr.ai': 3 } }));
    writeFileSync(path.join(t.cfg, 'pending-aliases.yaml'), 'version: 1\npending: []\n');
    writeFileSync(path.join(t.cfg, 'index-cache.json'), '{"version":1,"key":"x","index":{}}');
    expect(stateWarnings(await run(t))).toEqual([]);
  });

  // Catches: runDoctorReport never looked at serve.json, hits.json,
  // pending-aliases.yaml or the index cache, each of which is read as missing
  // or empty when broken, so a broken one was never mentioned.
  it('warns, naming the file and the fix, for each one that exists but cannot be used', async () => {
    const t = setup();
    const serve = path.join(t.cfg, 'serve.json');
    const hits = path.join(t.cfg, 'hits.json');
    const pending = path.join(t.cfg, 'pending-aliases.yaml');
    const cache = path.join(t.cfg, 'index-cache.json');
    writeFileSync(serve, '{ nope');
    writeFileSync(hits, '{"version":1,');
    writeFileSync(pending, 'pending: [oops');
    mkdirSync(cache);
    const report = await run(t);
    // Warnings: none of these files stops lexicon correcting.
    expect(report.checks.some((c) => c.level === 'fail')).toBe(false);
    const warnings = stateWarnings(report);
    expect(warnings).toEqual([
      `serve.json is not valid JSON; fix it, or delete it and lexicon serve makes a new token (the local API and its paired clients need a usable one): ${serve}`,
      expect.stringMatching(/^hits\.json is not valid JSON \(.*\), so every term reads as never used and new hits are not counted \(fix it, or move it aside to start the counts over\): /),
      `pending corrections queue is not valid YAML, so lexicon pending cannot list it and new corrections are not queued (fix it, or move it aside): ${pending}`,
      `index cache is not a file, so each match builds the index again (delete it; lexicon writes a new one): ${cache}`,
    ]);
    expect(warnings[1]?.endsWith(`: ${hits}`)).toBe(true);

    rmSync(hits);
    mkdirSync(hits);
    writeFileSync(serve, JSON.stringify({ token: 'short' }));
    writeFileSync(pending, 'pending:\n  - heard: x\n');
    rmSync(cache, { recursive: true });
    writeFileSync(cache, 'garbage');
    expect(stateWarnings(await run(t))).toEqual([
      expect.stringContaining('serve.json has no usable token ("token" is not 32 to 128 hex characters'),
      `hits.json cannot be read (EISDIR), so every term reads as never used and new hits are not counted (fix it, or move it aside to start the counts over): ${hits}`,
      `pending corrections queue has an entry that is not a pending alias, so lexicon pending cannot list it and new corrections are not queued (fix it, or move it aside): ${pending}`,
      `index cache does not start the way an index cache does, so the next match builds the index again (delete it; lexicon writes a new one): ${cache}`,
    ]);
  });
});
