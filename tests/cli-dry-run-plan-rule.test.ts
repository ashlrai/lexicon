import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addTerm, trustProject } from '../src/core/index.js';
import { runAdd, runInit, runRemove } from '../src/cli/commands.js';
import { runLearn } from '../src/cli/cmd-learn.js';
import { runUntrust } from '../src/cli/cmd-trust.js';
import { runPackAdd } from '../src/cli/cmd-pack.js';
import { dryRunPlan } from '../src/cli/dry-run-plan.js';
import { makeIO } from './helpers.js';

let dir: string;
let cwd: string;
let globalPath: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-plan-rule-')));
  cwd = path.join(dir, 'repo');
  globalPath = path.join(dir, 'config', 'lexicon.yaml');
  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  vi.stubEnv('LEXICON_PATH', globalPath);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(dir, 'config'));
  vi.stubEnv('LEXICON_TRUST_ALL', '');
  await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler'] }, { cwd, globalPath });
  const project = path.join(cwd, '.lexicon.yaml');
  await fs.writeFile(project, 'version: 1\nterms: []\n');
  await trustProject(project, { cwd });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

it.each([true, false, undefined])('preview markers require dryRun === true (%s)', (dryRun) => {
  expect(dryRunPlan(dryRun)).toEqual(dryRun === true ? { plan: true, dryRun: true } : {});
});

it.each(['init', 'add', 'add unchanged', 'remove', 'remove alias', 'learn', 'untrust', 'untrust absent', 'pack add', 'remove missing', 'alias missing'])(
  '%s marks successful previews, including no-ops, but never applied or failed results', async (command) => {
    if (command === 'untrust absent') await runUntrust(undefined, { cwd }, makeIO());
    let proposal: Record<string, unknown> | undefined;
    for (const dryRun of [true, false]) {
      const io = makeIO();
      const opts = { cwd, globalPath, json: true, dryRun };
      const code = command === 'init' ? await runInit(opts, io)
        : command.startsWith('add') ? await runAdd('Ashlr.AI', [command === 'add' ? 'Ashlar' : 'Ashler'], opts, io)
        : command === 'learn' ? await runLearn(['Ashlar', 'Ashlr.AI'], opts, io)
        : command.startsWith('untrust') ? await runUntrust(undefined, opts, io)
        : command === 'pack add' ? await runPackAdd(['voice-tools'], opts, io)
        : await runRemove(command === 'remove missing' ? 'Missing' : 'Ashlr.AI', {
          ...opts, ...(command.includes('alias') ? { alias: command === 'alias missing' ? 'Missing' : 'Ashler' } : {}),
        }, io);
      const failed = command.endsWith('missing');
      expect(code, io.err).toBe(failed ? 1 : 0);
      const output = JSON.parse(io.out);
      const result = Array.isArray(output) ? output[0] : output;
      if (dryRun && !failed) expect(result).toMatchObject({ ok: true, plan: true, dryRun: true });
      else expect(result).not.toHaveProperty('plan');
      if (!dryRun) expect(result).not.toHaveProperty('dryRun');
      if (failed) expect(result).toMatchObject({ ok: false, removed: false });
      if (dryRun) proposal = result;
      else if (command === 'pack add') {
        const { ok, plan, dryRun: mode, ...expected } = proposal!;
        expect({ ok, plan, dryRun: mode }).toEqual({ ok: true, plan: true, dryRun: true });
        expect(result).toEqual(expected);
      }
    }
  },
);
