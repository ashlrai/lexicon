/**
 * `lexicon import --guided`: the wizard flow with a scripted prompter and a
 * temp global lexicon. The github source is faked at the exec seam; nothing
 * touches the real machine.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runImportGuided } from '../src/cli/cmd-import-guided.js';
import type { ImportGuidedDeps } from '../src/cli/cmd-import-guided.js';
import { getImportSource } from '../src/core/index.js';
import type { HarvestCandidate, ImportSourceDeps } from '../src/core/index.js';
import { makeIO, scripted } from './helpers.js';

function githubExec(file: string, args: readonly string[]): string {
  if (file !== 'gh') throw new Error(`unexpected exec ${file}`);
  const api = args[1] as string;
  if (args[0] === 'auth') return 'Logged in';
  if (api === 'user') return JSON.stringify({ login: 'masonwyatt23', name: 'Mason Wyatt' });
  if (api === 'user/orgs') return JSON.stringify([{ login: 'ashlrai' }]);
  if (api === 'orgs/ashlrai/members') return JSON.stringify([{ login: 'evan-d' }]);
  if (api === 'orgs/ashlrai/repos') return JSON.stringify([{ name: 'lexicon' }]);
  if (api === 'user/repos') return JSON.stringify([{ name: 'dotfiles', owner: { login: 'masonwyatt23' } }]);
  throw new Error(`unexpected gh api ${api}`);
}

let dir: string;
let globalPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lexicon-guided-test-'));
  globalPath = path.join(dir, 'lexicon.yaml');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function fakeDeps(overrides: Partial<ImportSourceDeps & ImportGuidedDeps> = {}): ImportGuidedDeps & { isInteractive: () => boolean } {
  return {
    platform: 'linux',
    home: dir,
    exists: () => false,
    readText: () => {
      throw new Error('unexpected read');
    },
    readDir: () => [],
    isDirectory: () => false,
    fileSize: () => undefined,
    exec: githubExec,
    isInteractive: () => false,
    ...overrides,
  };
}

describe('runImportGuided', () => {
  it('refuses non-interactive use without --yes or --dry-run', async () => {
    const io = makeIO();
    const code = await runImportGuided({ globalPath }, io, fakeDeps());
    expect(code).toBe(1);
    expect(io.err).toContain('--sources');
  });

  it('refuses --yes without --sources (the privacy rule)', async () => {
    const io = makeIO();
    const code = await runImportGuided({ yes: true, globalPath }, io, fakeDeps());
    expect(code).toBe(1);
    expect(io.err).toContain('--yes needs --sources');
  });

  // Catches: --json refusals went to stderr only, leaving stdout empty for the script that asked for JSON.
  it('prints { ok: false, error } under --json when it refuses', async () => {
    const io = makeIO();
    expect(await runImportGuided({ json: true, globalPath }, io, fakeDeps())).toBe(1);
    expect(JSON.parse(io.out)).toEqual({ ok: false, error: expect.stringContaining('--yes needs --sources'), nextStep: expect.any(String) });
    const bad = makeIO();
    expect(await runImportGuided({ json: true, sources: 'carrier-pigeon', globalPath }, bad, fakeDeps())).toBe(1);
    expect(JSON.parse(bad.out)).toEqual({ ok: false, error: expect.stringContaining('unknown import source'), nextStep: expect.any(String) });
    const limit = makeIO();
    expect(await runImportGuided({ json: true, sources: 'github', limit: '-1', globalPath }, limit, fakeDeps())).toBe(1);
    expect(JSON.parse(limit.out)).toEqual({ ok: false, error: '--limit must be a non-negative integer, got "-1"', nextStep: expect.any(String) });
  });

  it('rejects an unknown source', async () => {
    const io = makeIO();
    const code = await runImportGuided({ dryRun: true, sources: 'carrier-pigeon', globalPath }, io, fakeDeps());
    expect(code).toBe(1);
    expect(io.err).toContain('unknown import source');
  });

  it('dry-run previews candidates and writes nothing', async () => {
    const io = makeIO();
    const code = await runImportGuided({ dryRun: true, sources: 'github', globalPath }, io, fakeDeps());
    expect(code).toBe(0);
    expect(io.out).toContain('Mason Wyatt');
    expect(io.out).toContain('dry run');
    expect(existsSync(globalPath)).toBe(false);
  });

  it('--json prints the candidate preview without writing', async () => {
    const io = makeIO();
    const code = await runImportGuided({ json: true, sources: 'github', globalPath }, io, fakeDeps());
    expect(code).toBe(0);
    const report = JSON.parse(io.out);
    expect(report.dryRun).toBe(true);
    expect(report.candidates.length).toBeGreaterThan(0);
    expect(report.candidates[0]).toHaveProperty('canonical');
    expect(report.candidates[0]).toHaveProperty('evidence');
    expect(existsSync(globalPath)).toBe(false);
  });

  it('--yes applies only selected ids from an unchanged preview', async () => {
    const preview = makeIO();
    expect(await runImportGuided({ json: true, sources: 'github', globalPath }, preview, fakeDeps())).toBe(0);
    const report = JSON.parse(preview.out);
    const selected = report.candidates.find((c: { canonical: string }) => c.canonical === 'Mason Wyatt');
    const io = makeIO();
    expect(await runImportGuided({ yes: true, sources: 'github', globalPath,
      previewId: report.previewId, accept: selected.id }, io, fakeDeps())).toBe(0);
    const text = readFileSync(globalPath, 'utf8');
    expect(text).toContain('Mason Wyatt');
    expect(text).toContain('import:github');
    expect(text).not.toContain('dotfiles');
  });

  it.each([{ yes: true }, { yes: true, json: true }, { dryRun: true }, { json: true }])(
    'rejects default sources before any availability probe or read: %j', async (flags) => {
      const exec = vi.fn(githubExec);
      const exists = vi.fn(() => false);
      const io = makeIO();
      expect(await runImportGuided({ ...flags, globalPath }, io, fakeDeps({ exec, exists }))).toBe(1);
      expect(exec).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
      expect(existsSync(globalPath)).toBe(false);
    });

  it('refuses a write without candidate approval', async () => {
    const exec = vi.fn(githubExec);
    const io = makeIO();
    expect(await runImportGuided({ yes: true, json: true, sources: 'github', globalPath }, io, fakeDeps({ exec }))).toBe(1);
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(globalPath)).toBe(false);
  });

  it('refuses changed source contents after preview without writing', async () => {
    const io = makeIO();
    await runImportGuided({ json: true, sources: 'github', globalPath }, io, fakeDeps());
    const preview = JSON.parse(io.out);
    const changed = fakeDeps({ exec: (file, args) => args[1] === 'user' ?
      JSON.stringify({ login: 'changed-user', name: 'Changed Person' }) : githubExec(file, args) });
    const applied = makeIO();
    expect(await runImportGuided({ yes: true, sources: 'github', globalPath,
      previewId: preview.previewId, accept: preview.candidates[0].id }, applied, changed)).toBe(1);
    expect(applied.err).toMatch(/changed since preview/);
    expect(existsSync(globalPath)).toBe(false);
  });

  it('refuses candidate ids absent from the preview', async () => {
    const io = makeIO();
    await runImportGuided({ json: true, sources: 'github', globalPath }, io, fakeDeps());
    const preview = JSON.parse(io.out);
    const applied = makeIO();
    expect(await runImportGuided({ yes: true, sources: 'github', globalPath,
      previewId: preview.previewId, accept: '00'.repeat(32) }, applied, fakeDeps())).toBe(1);
    expect(applied.err).toMatch(/absent from the preview/);
    expect(existsSync(globalPath)).toBe(false);
  });

  it.each([undefined, 'calendar'])('interactive cancellation never probes sources before consent: %s', async (sources) => {
    const exec = vi.fn(() => '{}');
    const readDir = vi.fn(() => []);
    const exists = vi.fn(() => false);
    const p = { ...scripted([]), choose: async () => {
      expect(exec).not.toHaveBeenCalled();
      expect(readDir).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
      return [];
    } };
    const code = await runImportGuided({ sources, globalPath }, makeIO(), fakeDeps({
      platform: 'darwin', exec, readDir, exists,
      isInteractive: () => true, createPrompter: () => p,
    }));
    expect(code).toBe(0);
    expect(exec).not.toHaveBeenCalled();
    expect(readDir).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(existsSync(globalPath)).toBe(false);
  });

  it('interactive: choose sources, then approve each candidate', async () => {
    const io = makeIO();
    const p = scripted([
      [3], // sources checklist: github only
      'n', // first candidate: skip
      'a', // add all remaining
    ]);
    const code = await runImportGuided(
      { globalPath },
      io,
      fakeDeps({ isInteractive: () => true, createPrompter: () => p }),
    );
    expect(code).toBe(0);
    expect(p.asked.some((q) => q.includes('sources to import from'))).toBe(true);
    const text = readFileSync(globalPath, 'utf8');
    // Five github candidates, one skipped: four terms land in the lexicon.
    expect(text).toContain('import:github');
    expect(io.out).toContain('1 skipped');
    expect(io.out).toContain('4 new');
  });

  it('interactive selection probes only the chosen source after the checklist', async () => {
    const exec = vi.fn(githubExec);
    const readDir = vi.fn(() => []);
    const exists = vi.fn(() => false);
    const p = scripted([[3]]);
    const choose = p.choose.bind(p);
    p.choose = async (...args) => {
      expect(exec).not.toHaveBeenCalled();
      expect(readDir).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
      return choose(...args);
    };
    expect(await runImportGuided({ globalPath, dryRun: true }, makeIO(), fakeDeps({
      platform: 'darwin', exec, readDir, exists,
      isInteractive: () => true, createPrompter: () => p,
    }))).toBe(0);
    expect(exec).toHaveBeenCalledWith('gh', ['auth', 'status']);
    expect(exec.mock.calls.every(([file]) => file === 'gh')).toBe(true);
    expect(readDir).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    expect(existsSync(globalPath)).toBe(false);
  });

  it('interactive: quitting writes only what was accepted', async () => {
    const io = makeIO();
    const p = scripted([
      [3], // sources checklist: github only
      'y', // first candidate: yes
      'q', // quit
    ]);
    const code = await runImportGuided(
      { globalPath },
      io,
      fakeDeps({ isInteractive: () => true, createPrompter: () => p }),
    );
    expect(code).toBe(0);
    const text = readFileSync(globalPath, 'utf8');
    expect(text).toContain('import:github');
    expect(io.out).toContain('1 new');
    expect(io.out).toContain('4 skipped');
  });

  it('shows mixed-source duplicate evidence in full before any approval', async () => {
    const candidate = (source: HarvestCandidate['source'], evidence: string[], count = 1): HarvestCandidate => ({
      canonical: 'Mason Wyatt', category: 'person', source, evidence, count,
      suggestedAliases: ['Mason Whyatt'],
    });
    vi.spyOn(getImportSource('calendar'), 'checkAvailable').mockResolvedValue({ available: true });
    vi.spyOn(getImportSource('calendar'), 'harvest').mockResolvedValue([
      candidate('import:calendar', ['calendar attendee', 'calendar organizer', 'calendar title', 'fourth calendar origin']),
    ]);
    vi.spyOn(getImportSource('github'), 'harvest').mockResolvedValue([
      candidate('import:github', ['GitHub profile name']),
      { ...candidate('import:github', ['GitHub repo']), canonical: 'Lexicon' },
    ]);
    const io = makeIO();
    const previewIO = makeIO();
    expect(await runImportGuided({ globalPath, sources: 'calendar,github', json: true }, previewIO, fakeDeps())).toBe(0);
    const preview = JSON.parse(previewIO.out);
    expect(preview.candidates).toHaveLength(2);
    expect(preview.candidates[0]).toMatchObject({
      canonical: 'Mason Wyatt', source: 'import:calendar', count: 2,
      evidence: ['calendar attendee', 'calendar organizer', 'calendar title', 'fourth calendar origin', 'GitHub profile name'],
      aliases: ['Mason Whyatt'],
    });
    const p = scripted([[2, 3], 'a']);
    const ask = p.ask.bind(p);
    p.ask = async (...args) => {
      expect(io.out).toContain('fourth calendar origin');
      expect(io.out).toContain('GitHub profile name');
      expect(io.out).toContain('Lexicon');
      expect(io.out).toContain('seen 2x');
      expect(io.out).toContain('Duplicate names are combined');
      expect(existsSync(globalPath)).toBe(false);
      return ask(...args);
    };
    expect(await runImportGuided({ globalPath }, io, fakeDeps({
      isInteractive: () => true, createPrompter: () => p,
    }))).toBe(0);
    expect(io.out).toContain('2 new');
    const text = readFileSync(globalPath, 'utf8');
    expect(text.match(/canonical: Mason Wyatt/g)).toHaveLength(1);
  });

  it.each(['q', 'n'])('declining every candidate with %s leaves an existing lexicon unchanged', async (answer) => {
    const original = '# keep this comment\nversion: 1\nterms: []\n';
    writeFileSync(globalPath, original);
    const p = scripted([[3], ...Array(5).fill(answer)]);
    expect(await runImportGuided({ globalPath }, makeIO(), fakeDeps({
      isInteractive: () => true, createPrompter: () => p,
    }))).toBe(0);
    expect(readFileSync(globalPath, 'utf8')).toBe(original);
  });

  it.each([false, true])('empty previews do not prompt for terms or write (json=%s)', async (json) => {
    vi.spyOn(getImportSource('github'), 'harvest').mockResolvedValue([]);
    const io = makeIO();
    const p = scripted([[1]]);
    expect(await runImportGuided({ globalPath, sources: 'github', json }, io, fakeDeps({
      isInteractive: () => true, createPrompter: () => p,
    }))).toBe(0);
    if (json) expect(JSON.parse(io.out).candidates).toEqual([]);
    else expect(io.out).toContain('no candidates found');
    expect(p.asked.filter((q) => q.includes('add?'))).toEqual([]);
    expect(existsSync(globalPath)).toBe(false);
  });

  it('reports unavailable sources and exits cleanly when none are usable', async () => {
    const io = makeIO();
    const code = await runImportGuided(
      { dryRun: true, sources: 'contacts,calendar', globalPath },
      io,
      fakeDeps(),
    );
    expect(code).toBe(0);
    expect(io.out).toContain('skipped');
    expect(io.out).toContain('no usable import source');
  });
});
