/** A new project write must be able to publish its promised trust pin. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTerm, addTerms, readLexiconFile } from '../src/core/store.js';
import { getTrustPath } from '../src/core/trust.js';
import { installPack } from '../src/core/packs.js';
import type { AddTermOptions } from '../src/core/store.js';

let dir: string;
let cwd: string;
let globalPath: string;
let projectPath: string;
let registryPath: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-project-preview-')));
  cwd = path.join(dir, 'repo');
  globalPath = path.join(dir, 'config', 'lexicon.yaml');
  projectPath = path.join(cwd, '.lexicon.yaml');
  registryPath = getTrustPath({ globalPath });
  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  vi.stubEnv('LEXICON_TRUST_ALL', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const term = { canonical: 'QuasarBridge', aliases: ['quasar bridge'] };
const writers = [
  { name: 'addTerm', run: (opts: AddTermOptions) => addTerm(term, opts) },
  { name: 'addTerms', run: (opts: AddTermOptions) => addTerms([term], opts) },
  { name: 'installPack', run: (opts: AddTermOptions) => installPack('voice-tools', opts) },
];

describe.each(writers)('new project $name trust preflight', ({ run }) => {
  it.each(['{broken json', '{"version":1,"trusted":[]}'])('refuses a corrupt registry in both preview and real writes: %s', async (original) => {
    await fs.writeFile(registryPath, original);
    const messages: string[] = [];
    for (const dryRun of [true, false]) {
      let failure: unknown;
      try {
        await run({ cwd, globalPath, scope: 'project', dryRun });
      } catch (err) {
        failure = err;
      }
      expect(failure, `dryRun=${dryRun} must refuse the unusable registry`).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ name: 'TrustRegistryUnreadableError' });
      messages.push((failure as Error).message);
      expect(await fs.readFile(registryPath, 'utf8')).toBe(original);
      await expect(fs.stat(projectPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(globalPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readdir(path.dirname(registryPath))).toEqual(['trust.json']);
      expect((await fs.readdir(cwd)).sort()).toEqual(['.git']);
    }
    expect(messages[0]).toBe(messages[1]);
  });

  it('keeps leaveUntrusted previews and writes independent of the corrupt registry', async () => {
    const original = '{broken json';
    await fs.writeFile(registryPath, original);
    await run({ cwd, globalPath, scope: 'project', leaveUntrusted: true, dryRun: true });
    await expect(fs.stat(projectPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await run({ cwd, globalPath, scope: 'project', leaveUntrusted: true });
    expect((await readLexiconFile(projectPath, 'project')).lexicon.terms.length).toBeGreaterThan(0);
    expect(await fs.readFile(registryPath, 'utf8')).toBe(original);
  });
});
