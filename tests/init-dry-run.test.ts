import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../src/cli/commands.js';
import { makeIO } from './helpers.js';

let dir: string;
let repo: string;
let registry: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-init-preview-'));
  repo = path.join(dir, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  registry = path.join(dir, 'trust.json');
  vi.stubEnv('LEXICON_PATH', path.join(dir, 'global.yaml'));
  vi.stubEnv('LEXICON_TRUST_ALL', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('project init trust preflight', () => {
  it.each([false, true])('refuses a malformed registry before creating a file (dry-run: %s)', async (dryRun) => {
    await fs.writeFile(registry, '{broken');
    await expect(runInit({ cwd: repo, project: true, dryRun }, makeIO())).rejects.toThrow(/trust registry.*not valid JSON/i);
    expect(await fs.readFile(registry, 'utf8')).toBe('{broken');
    await expect(fs.stat(path.join(repo, '.lexicon.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a pending project initialization in text and preserves existing files', async () => {
    const project = path.join(repo, '.lexicon.yaml');
    const missing = makeIO();
    expect(await runInit({ cwd: repo, project: true, dryRun: true }, missing)).toBe(0);
    expect(missing.out).toContain(`would create project lexicon: ${project} (and trust it)`);
    expect(await fs.readdir(repo)).toEqual(['.git']);
    await expect(fs.stat(registry)).rejects.toMatchObject({ code: 'ENOENT' });

    const content = 'version: 1\nterms: []\n';
    await fs.writeFile(project, content);
    const before = await fs.stat(project);
    const existing = makeIO();
    expect(await runInit({ cwd: repo, project: true, dryRun: true }, existing)).toBe(0);
    expect(existing.out).toContain(`project lexicon already exists: ${project}`);
    expect(existing.out).toContain('it is not trusted yet');
    expect(await fs.readFile(project, 'utf8')).toBe(content);
    expect((await fs.stat(project)).mtimeMs).toBe(before.mtimeMs);
    await expect(fs.stat(registry)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('previews creating and trusting a missing project without writing either file', async () => {
    const io = makeIO();
    expect(await runInit({ cwd: repo, project: true, dryRun: true, json: true }, io)).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ ok: true, created: true, dryRun: true, trust: 'trusted' });
    await expect(fs.stat(path.join(repo, '.lexicon.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(registry)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
