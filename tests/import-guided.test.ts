/**
 * `lexicon import --guided`: the wizard flow with a scripted prompter and a
 * temp global lexicon. The github source is faked at the exec seam; nothing
 * touches the real machine.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runImportGuided } from '../src/cli/cmd-import-guided.js';
import type { ImportGuidedDeps } from '../src/cli/cmd-import-guided.js';
import type { ImportSourceDeps } from '../src/core/index.js';
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

  it('--yes --sources writes every candidate with the import source tag', async () => {
    const io = makeIO();
    const code = await runImportGuided({ yes: true, sources: 'github', globalPath }, io, fakeDeps());
    expect(code).toBe(0);
    expect(io.out).toContain('new');
    const text = readFileSync(globalPath, 'utf8');
    expect(text).toContain('Mason Wyatt');
    expect(text).toContain('import:github');
  });

  it('interactive: choose sources, then approve each candidate', async () => {
    const io = makeIO();
    const p = scripted([
      [1], // sources checklist: github only
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

  it('interactive: quitting writes only what was accepted', async () => {
    const io = makeIO();
    const p = scripted([
      [1], // sources checklist: github only
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
