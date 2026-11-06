import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addTerm, trustProject } from '../src/core/index.js';
import { runAdd, runInit, runRemove } from '../src/cli/commands.js';
import { runLearn } from '../src/cli/cmd-learn.js';
import { runUntrust } from '../src/cli/cmd-trust.js';
import { runPackAdd } from '../src/cli/cmd-pack.js';
import { makeIO } from './helpers.js';

let dir: string;
let cwd: string;
let globalPath: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-plans-')));
  cwd = path.join(dir, 'repo');
  globalPath = path.join(dir, 'config', 'lexicon.yaml');
  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  vi.stubEnv('LEXICON_PATH', globalPath);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(dir, 'config'));
  vi.stubEnv('LEXICON_TRUST_ALL', '');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const file of await fs.readdir(dir, { recursive: true })) {
    const absolute = path.join(dir, file);
    if ((await fs.stat(absolute)).isFile()) files[file] = (await fs.readFile(absolute)).toString('hex');
  }
  return files;
}

it.each(['add', 'remove', 'learn', 'init', 'untrust', 'pack add'] as const)(
  '%s prints a setup-compatible plan and leaves every file unchanged', async (command) => {
    await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler'] }, { cwd, globalPath });
    const projectPath = path.join(cwd, '.lexicon.yaml');
    await fs.writeFile(projectPath, 'version: 1\nterms: []\n');
    await trustProject(projectPath, { cwd });
    // Preview creation as well as mutation of an existing file.
    if (command === 'init') await fs.rm(globalPath);
    const before = await snapshot();
    for (const json of [true, false]) {
      const io = makeIO();
      const opts = { cwd, globalPath, dryRun: true, json };
      const code = command === 'add' ? await runAdd('Ashlr.AI', ['Ashlar'], opts, io)
        : command === 'remove' ? await runRemove('Ashlr.AI', opts, io)
        : command === 'learn' ? await runLearn(['Ashlar', 'Ashlr.AI'], opts, io)
        : command === 'init' ? await runInit(opts, io)
        : command === 'untrust' ? await runUntrust(undefined, opts, io)
        : await runPackAdd(['voice-tools'], opts, io);
      expect(code).toBe(0);
      if (json) {
        const output: unknown = JSON.parse(io.out);
        // Pack add returns one result per requested pack; setup and the other
        // previews expose their plan marker on the top-level object instead.
        expect(Array.isArray(output)).toBe(command === 'pack add');
        const plan = Array.isArray(output) ? output[0] : output;
        expect(plan).toMatchObject({ ok: true, plan: true, dryRun: true });
        if (command === 'remove') expect(plan).toMatchObject({ canonical: 'Ashlr.AI', removed: true });
        else expect(plan).toHaveProperty('path', command === 'untrust' ? projectPath : globalPath);
      } else {
        expect(io.out).toContain('would');
      }
      expect(await snapshot()).toEqual(before);
    }
  },
);
