/**
 * `lexicon review --project` and `lexicon edit --project` re-pin trust only
 * over the bytes they wrote or checked. A writer that takes no lock (a git
 * pull, a hand edit) landing between that write and the re-pin must leave the
 * file 'changed', not have its bytes pinned as the user's edit.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LexiconFile, TermScope } from '../src/core/index.js';
import { makeIO, scripted } from './helpers.js';

/** Set by a test: runs once, right after the next matching core call. */
const after: { write?: (file: LexiconFile) => Promise<void>; read?: (filePath: string) => Promise<void> } = {};

vi.mock('../src/core/index.js', async (importOriginal) => {
  const core = await importOriginal<typeof import('../src/core/index.js')>();
  return {
    ...core,
    writeLexiconFile: async (file: LexiconFile): Promise<void> => {
      await core.writeLexiconFile(file);
      const hook = after.write;
      after.write = undefined;
      if (hook) await hook(file);
    },
    readLexiconFile: async (filePath: string, scope: TermScope): Promise<LexiconFile> => {
      const file = await core.readLexiconFile(filePath, scope);
      const hook = after.read;
      after.read = undefined;
      if (hook) await hook(filePath);
      return file;
    },
  };
});

const { runEdit, runReview } = await import('../src/cli/cmd-review.js');
const { isTrusted, trustProject } = await import('../src/core/index.js');

let tmp: string;
let globalPath: string;
let repo: string;
let projectPath: string;
let savedTrustAll: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-review-pin-'));
  globalPath = path.join(tmp, 'config', 'lexicon.yaml');
  repo = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  projectPath = path.join(repo, '.lexicon.yaml');
  savedTrustAll = process.env.LEXICON_TRUST_ALL;
  delete process.env.LEXICON_TRUST_ALL;
  after.write = undefined;
  after.read = undefined;
});

afterEach(async () => {
  if (savedTrustAll === undefined) delete process.env.LEXICON_TRUST_ALL;
  else process.env.LEXICON_TRUST_ALL = savedTrustAll;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const planted = '  - canonical: Planted\n    aliases: [the]\n';

function status(): Promise<string> {
  return isTrusted({ path: projectPath, scope: 'project', lexicon: { version: 1, terms: [] }, exists: true }, { globalPath });
}

describe('re-pinning trust after a project write', () => {
  it('review --project does not pin bytes another writer added after its write', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Proj\n    aliases: [prodge]\n  - canonical: Old\n    aliases: [olde]\n', 'utf8');
    await trustProject(projectPath, { globalPath });
    after.write = async (file) => {
      if (file.path === projectPath) await fs.appendFile(projectPath, planted, 'utf8');
    };
    const io = makeIO();
    expect(await runReview({ cwd: repo, project: true, globalPath }, io, scripted(['d', 'k']))).toBe(0);
    expect(await fs.readFile(projectPath, 'utf8')).toContain('Planted');
    expect(await status()).toBe('changed');
  });

  it('edit --project does not pin bytes another writer added after the edit was checked, and says so', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Seed\n    aliases: [seed]\n', 'utf8');
    await trustProject(projectPath, { globalPath });
    const spawnEditor = async (_cmd: string, _args: readonly string[], file: string): Promise<number> => {
      await fs.appendFile(file, '  - canonical: Proj\n    aliases: [prodge]\n', 'utf8');
      after.read = async (filePath) => {
        if (filePath === projectPath) await fs.appendFile(projectPath, planted, 'utf8');
      };
      return 0;
    };
    const io = makeIO();
    expect(await runEdit({ cwd: repo, project: true, globalPath }, io, spawnEditor, { VISUAL: 'code --wait' })).toBe(0);
    expect(await status()).toBe('changed');
    expect(io.out).not.toContain('re-trusted');
    expect(io.err).toContain('changed again after the edit was checked, so it was not re-trusted');
  });
});
