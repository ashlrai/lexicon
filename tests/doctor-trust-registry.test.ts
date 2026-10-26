/**
 * `lexicon doctor` and a trust registry (`trust.json`) that cannot be used.
 * Real core, temp dirs only: the registry, both lexicons and HOME are under
 * a fresh directory, and LEXICON_PATH reaches the trust check through the
 * doctor's own env.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor, runDoctorReport } from '../src/cli/cmd-doctor.js';
import { trustProject } from '../src/core/index.js';
import { makeIO } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): { home: string; repo: string; globalPath: string; trustPath: string; projectPath: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-doctor-trust-'));
  dirs.push(home);
  const cfg = path.join(home, 'cfg');
  const repo = path.join(home, 'repo');
  mkdirSync(cfg);
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  const globalPath = path.join(cfg, 'lexicon.yaml');
  writeFileSync(globalPath, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
  const projectPath = path.join(repo, '.lexicon.yaml');
  writeFileSync(projectPath, 'version: 1\nterms:\n  - canonical: Hetzner\n    aliases: [hets ner]\n');
  return { home, repo, globalPath, trustPath: path.join(cfg, 'trust.json'), projectPath, env: { PATH: '', LEXICON_PATH: globalPath } };
}

describe('doctor with a trust registry it cannot use', () => {
  // Catches: a trust.json that is not valid JSON was read as empty without a word, so a trusted
  // project file was reported untrusted with `lexicon trust` as the fix, which then refused the file.
  it('fails a check naming the registry and its problem, and says to fix it before trusting', async () => {
    const t = setup();
    await trustProject(t.projectPath, { cwd: t.repo, globalPath: t.globalPath });
    writeFileSync(t.trustPath, '{ "trusted": { oops');
    const deps = { home: t.home, env: t.env, platform: 'linux' as const, exec: () => 'no servers' };
    const report = await runDoctorReport({ cwd: t.repo }, deps);
    expect(report.ok).toBe(false);
    expect(report.paths.trust).toBe(t.trustPath);
    const check = report.checks.find((c) => c.message.startsWith('trust registry '));
    expect(check?.level).toBe('fail');
    expect(check?.message).toMatch(/^trust registry is not valid JSON \(.*\), so every project lexicon reads as untrusted and trusting one fails/);
    expect(check?.message.endsWith(`: ${t.trustPath}`)).toBe(true);
    expect(report.summary).toMatch(/^The trust registry is not valid JSON .*, so this repo's project lexicon reads as untrusted and is not merged\.$/);
    expect(report.nextStep).toBe(`Fix the JSON in ${t.trustPath}, or move it aside, then run: lexicon trust  (it refuses to write over the broken file)`);
    const mcp = await runDoctorReport({ cwd: t.repo, audience: 'mcp' }, deps);
    expect(mcp.nextStep).toMatch(/^Ask the user to fix the JSON in .*trust\.json, or move it aside, then call trust_project with action "trust"/);
    const io = makeIO();
    expect(await runDoctor({ cwd: t.repo, json: true }, io, deps)).toBe(1);
  });

  it('names a registry that cannot be read at all (a directory)', async () => {
    const t = setup();
    mkdirSync(t.trustPath);
    const report = await runDoctorReport({ cwd: t.repo }, { home: t.home, env: t.env, platform: 'linux', exec: () => 'no servers' });
    expect(report.checks).toContainEqual({ level: 'fail', message: expect.stringMatching(/^trust registry cannot be read \(EISDIR\), so every project lexicon/) });
  });

  it('says nothing of a registry that is missing or fine, and reads trust through the doctor env', async () => {
    const t = setup();
    const deps = { home: t.home, env: t.env, platform: 'linux' as const, exec: () => 'no servers' };
    const missing = await runDoctorReport({ cwd: t.repo }, deps);
    expect(missing.checks.some((c) => c.message.startsWith('trust registry '))).toBe(false);
    expect(missing.checks.some((c) => c.message.startsWith('project lexicon is untrusted'))).toBe(true);
    await trustProject(t.projectPath, { cwd: t.repo, globalPath: t.globalPath });
    const trusted = await runDoctorReport({ cwd: t.repo }, deps);
    expect(trusted.checks).toContainEqual({ level: 'ok', message: 'project lexicon is trusted and merged' });
    expect(trusted.checks.some((c) => c.message.startsWith('trust registry '))).toBe(false);
  });
});

describe('doctor in a repo whose only terms are untrusted', () => {
  // Catches: with an empty global lexicon and an untrusted repo .lexicon.yaml, doctor
  // said "not set up yet ... Run: lexicon setup", which leaves the repo's terms unmerged,
  // and its trust next step named the MCP tool trust_project to a terminal user.
  it('names lexicon trust, not lexicon setup, as the next step, with the file named whole', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-doctor-untrusted-'));
    dirs.push(home);
    const cfg = path.join(home, 'cfg');
    // A deep repo: the untrusted-file check message runs past where a display
    // cap once cut the command after the path.
    const repo = path.join(home, 'projects', 'a-fairly-long-organisation-name', 'and-a-fairly-long-repository-name', 'packages', 'service');
    mkdirSync(cfg);
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    const globalPath = path.join(cfg, 'lexicon.yaml');
    writeFileSync(globalPath, 'version: 1\nterms: []\n');
    const projectPath = path.join(repo, '.lexicon.yaml');
    writeFileSync(projectPath, 'version: 1\nterms:\n  - canonical: Hetzner\n    aliases: [head sner]\n');
    const deps = { home, env: { PATH: '', LEXICON_PATH: globalPath }, platform: 'linux' as const, exec: () => 'no servers' };

    const report = await runDoctorReport({ cwd: repo }, deps);
    expect(report.ready).toBe(false);
    expect(report.summary).toContain('project lexicon (1 term) is not trusted');
    expect(report.summary).not.toMatch(/not set up yet/);
    expect(report.nextStep).toContain('lexicon trust');
    expect(report.nextStep).not.toContain('lexicon setup');
    expect(report.nextStep).not.toContain('trust_project');
    const check = report.checks.find((c) => /untrusted and not merged/.test(c.message));
    expect(check?.message).toContain(projectPath);
    const mcp = await runDoctorReport({ cwd: repo, audience: 'mcp' }, deps);
    expect(mcp.nextStep).toContain('trust_project');
    expect(mcp.nextStep).not.toContain('lexicon setup');
    // The rendered check names the file and its command whole: an ellipsis
    // cannot be run, and a deep repo path is what pushed it past the old cap.
    // Untrusted is a warn, not a fail, so the exit code stays 0.
    const io = makeIO();
    expect(await runDoctor({ cwd: repo }, io, deps)).toBe(0);
    expect(io.out).toContain('(review it, then run: lexicon trust)');
    expect(io.out).not.toContain('…');

    // Once it is trusted the terms count and the next step moves on.
    await trustProject(projectPath, { cwd: repo, globalPath });
    const after = await runDoctorReport({ cwd: repo }, deps);
    expect(after.summary).not.toContain('is not trusted');
    expect(after.checks).toContainEqual({ level: 'ok', message: 'project lexicon is trusted and merged' });
    expect(after.nextStep).not.toContain('lexicon trust');
  });
});
