import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTerm, listPending, loadLexicon, pendingId, queueCorrections, readPendingFile, trustProject } from '../src/core/index.js';
import { runLearn } from '../src/cli/cmd-learn.js';
import { runPendingAccept, runPendingReject } from '../src/cli/cmd-pending.js';
import { runTrust, runUntrust } from '../src/cli/cmd-trust.js';
import { runPackAdd, runPackRemove } from '../src/cli/cmd-pack.js';
import { runAdd, runRemove } from '../src/cli/commands.js';
import { makeIO } from './helpers.js';

let dir: string;
let cwd: string;
let globalPath: string;
let projectPath: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-mutation-preview-')));
  cwd = path.join(dir, 'repo');
  globalPath = path.join(dir, 'config', 'lexicon.yaml');
  projectPath = path.join(cwd, '.lexicon.yaml');
  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  vi.stubEnv('LEXICON_PATH', globalPath);
  vi.stubEnv('LEXICON_TRUST_ALL', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Snapshot every durable fixture file, including trust, pending, hits and caches. */
async function snapshot(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const file of (await fs.readdir(dir, { recursive: true })).sort()) {
    const absolute = path.join(dir, file);
    if ((await fs.stat(absolute)).isFile()) result[file] = (await fs.readFile(absolute)).toString('hex');
  }
  return result;
}

async function seedGlobal(): Promise<void> {
  await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler'] }, { cwd, globalPath });
}

describe('mutation handler previews', () => {
  it('add previews creation and merge without writing, then applies the planned aliases', async () => {
    const before = await snapshot();
    const create = makeIO();
    expect(await runAdd('Ashlr.AI', ['Ashler'], { cwd, globalPath, dryRun: true, json: true }, create)).toBe(0);
    expect(JSON.parse(create.out)).toMatchObject({ ok: true, created: true, dryRun: true, scope: 'global', path: globalPath, term: { canonical: 'Ashlr.AI', aliases: ['Ashler'] } });
    expect(await snapshot()).toEqual(before);
    expect(await runAdd('Ashlr.AI', ['Ashler'], { cwd, globalPath }, makeIO())).toBe(0);

    const seeded = await snapshot();
    const merge = makeIO();
    expect(await runAdd('Ashlr.AI', ['Ashlar'], { cwd, globalPath, dryRun: true }, merge)).toBe(0);
    expect(merge.out).toContain('would merge Ashlr.AI (global)');
    expect(merge.out).toContain('nothing was written');
    expect(merge.out).toContain('aliases: Ashler, Ashlar');
    expect(await snapshot()).toEqual(seeded);
    expect(await runAdd('Ashlr.AI', ['Ashlar'], { cwd, globalPath }, makeIO())).toBe(0);
    expect((await loadLexicon({ cwd, globalPath })).global.lexicon.terms[0].aliases).toEqual(['Ashler', 'Ashlar']);
  });

  it('project add previews trust and rejects an untrusted existing file without persisting either', async () => {
    const before = await snapshot();
    const preview = makeIO();
    expect(await runAdd('Ashlr.AI', ['Ashler'], { cwd, globalPath, project: true, dryRun: true }, preview)).toBe(0);
    expect(preview.out).toContain('would create Ashlr.AI (project)');
    expect(preview.out).toContain('a real run also re-pins');
    expect(await snapshot()).toEqual(before);

    await fs.writeFile(projectPath, 'version: 1\nterms: []\n');
    const untrusted = await snapshot();
    await expect(runAdd('Ashlr.AI', ['Ashler'], { cwd, globalPath, project: true, dryRun: true }, makeIO())).rejects.toThrow(/untrusted/);
    expect(await snapshot()).toEqual(untrusted);
  });

  it('remove previews the first term copy and then removes only that copy', async () => {
    await seedGlobal();
    await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar'] }, { cwd, globalPath, scope: 'project' });
    const before = await snapshot();
    const preview = makeIO();
    expect(await runRemove('ashlr.ai', { cwd, dryRun: true, json: true }, preview)).toBe(0);
    const plan = JSON.parse(preview.out);
    expect(plan).toMatchObject({ ok: true, canonical: 'Ashlr.AI', removed: true, dryRun: true, stillIn: [{ scope: 'global', path: globalPath }] });
    expect(await snapshot()).toEqual(before);
    const actual = makeIO();
    expect(await runRemove('ashlr.ai', { cwd, json: true }, actual)).toBe(0);
    const { dryRun, plan: marker, ...expected } = plan;
    expect(marker).toBe(true);
    expect(dryRun).toBe(true);
    expect(JSON.parse(actual.out)).toEqual(expected);
    const loaded = await loadLexicon({ cwd, globalPath });
    expect(loaded.project?.lexicon.terms).toEqual([]);
    expect(loaded.global.lexicon.terms[0].canonical).toBe('Ashlr.AI');
  });

  it('remove alias previews all affected files and remaining aliases without writing', async () => {
    await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler', 'Global'] }, { cwd, globalPath });
    await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler', 'Project'] }, { cwd, globalPath, scope: 'project' });
    const before = await snapshot();
    const preview = makeIO();
    expect(await runRemove('Ashlr.AI', { cwd, alias: 'Ashler', dryRun: true, json: true }, preview)).toBe(0);
    const plan = JSON.parse(preview.out);
    expect(plan).toMatchObject({ ok: true, canonical: 'Ashlr.AI', alias: 'Ashler', removed: true, dryRun: true, aliases: ['Project'], paths: [projectPath, globalPath] });
    expect(await snapshot()).toEqual(before);
    const textPreview = makeIO();
    expect(await runRemove('Ashlr.AI', { cwd, alias: 'Ashler', global: true, dryRun: true }, textPreview)).toBe(0);
    expect(textPreview.out).toContain(`would remove alias Ashler from Ashlr.AI in ${globalPath}`);
    expect(textPreview.out).toContain('aliases: Global');
    expect(await snapshot()).toEqual(before);
    const actual = makeIO();
    expect(await runRemove('Ashlr.AI', { cwd, alias: 'Ashler', json: true }, actual)).toBe(0);
    const { dryRun, plan: marker, ...expected } = plan;
    expect(marker).toBe(true);
    expect(dryRun).toBe(true);
    expect(JSON.parse(actual.out)).toEqual(expected);
    const loaded = await loadLexicon({ cwd, globalPath });
    expect(loaded.project?.lexicon.terms[0].aliases).toEqual(['Project']);
    expect(loaded.global.lexicon.terms[0].aliases).toEqual(['Global']);
  });

  it('remove dry runs refuse missing targets and untrusted project writes without changes', async () => {
    await seedGlobal();
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
    const before = await snapshot();
    for (const opts of [{ global: true }, { global: true, alias: 'Missing' }, { project: true }, { project: true, alias: 'Ashler' }]) {
      const io = makeIO();
      expect(await runRemove(opts.project || opts.alias ? 'Ashlr.AI' : 'Missing', { cwd, ...opts, dryRun: true, json: true }, io)).toBe(1);
      expect(JSON.parse(io.out)).toMatchObject({ ok: false, removed: false });
      expect(await snapshot()).toEqual(before);
    }
  });

  it('learn previews a new term without creating the lexicon or sidecars', async () => {
    const before = await snapshot();
    const io = makeIO();
    expect(await runLearn(['cooper netties', 'Kubernetes'], { cwd, dryRun: true, json: true }, io)).toBe(0);
    expect(JSON.parse(io.out)).toMatchObject({ ok: true, created: true, aliasAdded: true, dryRun: true, path: globalPath });
    expect(await snapshot()).toEqual(before);
  });

  it('learn previews the same alias a real run adds while preserving all existing files', async () => {
    await seedGlobal();
    const before = await snapshot();
    const preview = makeIO();
    expect(await runLearn(['Ashlar', 'Ashlr.AI'], { cwd, dryRun: true, json: true }, preview)).toBe(0);
    expect(await snapshot()).toEqual(before);
    const actual = makeIO();
    expect(await runLearn(['Ashlar', 'Ashlr.AI'], { cwd, json: true }, actual)).toBe(0);
    const { dryRun, plan: marker, ...plan } = JSON.parse(preview.out);
    expect(marker).toBe(true);
    expect(dryRun).toBe(true);
    expect(JSON.parse(actual.out)).toEqual(plan);
    expect((await loadLexicon({ cwd, globalPath })).merged.terms[0].aliases).toEqual(['Ashler', 'Ashlar']);
  });

  it('learn refuses an untrusted project in dry-run without changing its content or pinning it', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
    const before = await snapshot();
    const io = makeIO();
    expect(await runLearn(['Ashlar', 'Ashlr.AI'], { cwd, project: true, dryRun: true, json: true }, io)).toBe(1);
    expect(JSON.parse(io.out)).toMatchObject({ ok: false, error: expect.stringContaining('untrusted') });
    expect(await snapshot()).toEqual(before);
  });

  it('pending accept preserves the queue and lexicon, then real acceptance applies the same alias', async () => {
    await seedGlobal();
    await queueCorrections([{ heard: 'Ashlar', meant: 'Ashlr.AI' }], { cwd, globalPath });
    const before = await snapshot();
    const preview = makeIO();
    expect(await runPendingAccept([], { cwd, globalPath, all: true, dryRun: true, json: true }, preview)).toBe(0);
    expect(JSON.parse(preview.out)).toMatchObject({ ok: true, dryRun: true, accepted: [{ id: pendingId('Ashlar', 'Ashlr.AI'), canonical: 'Ashlr.AI', path: globalPath }] });
    expect(await snapshot()).toEqual(before);
    const actual = makeIO();
    expect(await runPendingAccept([], { cwd, globalPath, all: true, json: true }, actual)).toBe(0);
    const { dryRun, ...plan } = JSON.parse(preview.out);
    expect(dryRun).toBe(true);
    expect(JSON.parse(actual.out)).toEqual(plan);
    expect((await listPending({ cwd, globalPath })).entries).toEqual([]);
    expect((await loadLexicon({ cwd, globalPath })).merged.terms[0].aliases).toContain('Ashlar');
  });

  it('pending reject previews without dropping an entry or remembering a rejection', async () => {
    await seedGlobal();
    const queued = await queueCorrections([{ heard: 'Ashlar', meant: 'Ashlr.AI' }], { cwd, globalPath });
    const before = await snapshot();
    const preview = makeIO();
    expect(await runPendingReject([], { cwd, globalPath, all: true, dryRun: true, json: true }, preview)).toBe(0);
    expect(JSON.parse(preview.out)).toMatchObject({ ok: true, dryRun: true, rejected: [pendingId('Ashlar', 'Ashlr.AI')] });
    expect(await snapshot()).toEqual(before);
    expect(await runPendingReject([], { cwd, globalPath, all: true, json: true }, makeIO())).toBe(0);
    const rejected = await readPendingFile(queued.file);
    expect(rejected.entries).toEqual([]);
    expect(rejected.rejected).toEqual([{ id: pendingId('Ashlar', 'Ashlr.AI'), rejectedAt: expect.any(String) }]);
  });

  it('trust previews the pin without asking or writing it, then explicit approval pins the shown bytes', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms: []\n');
    const before = await snapshot();
    const preview = makeIO();
    expect(await runTrust(undefined, { cwd, dryRun: true, json: true }, preview, {
      isInteractive: () => true,
      createPrompter: () => { throw new Error('a dry run must not ask for approval'); },
    })).toBe(0);
    expect(JSON.parse(preview.out)).toMatchObject({ ok: true, action: 'trust', status: 'trusted', dryRun: true });
    expect(await snapshot()).toEqual(before);
    const actual = makeIO();
    expect(await runTrust(undefined, { cwd, yes: true, json: true }, actual, { isInteractive: () => false })).toBe(0);
    expect(JSON.parse(actual.out).sha256).toBe(JSON.parse(preview.out).sha256);
    expect((await loadLexicon({ cwd, globalPath })).projectTrust).toBe('trusted');
  });

  it('untrust previews removal while preserving the original pin and timestamp', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms: []\n');
    await trustProject(projectPath, { cwd, globalPath });
    const before = await snapshot();
    const preview = makeIO();
    expect(await runUntrust(undefined, { cwd, dryRun: true, json: true }, preview)).toBe(0);
    expect(JSON.parse(preview.out)).toMatchObject({ ok: true, action: 'untrust', removed: true, dryRun: true });
    expect(await snapshot()).toEqual(before);
    expect(await runUntrust(undefined, { cwd, json: true }, makeIO())).toBe(0);
    expect((await loadLexicon({ cwd, globalPath })).projectTrust).toBe('untrusted');
  });

  it('vendored pack install previews the actual added/merged counts without creating files', async () => {
    const before = await snapshot();
    const preview = makeIO();
    expect(await runPackAdd(['voice-tools'], { cwd, globalPath, dryRun: true, json: true }, preview)).toBe(0);
    const [plan] = JSON.parse(preview.out);
    expect(plan).toMatchObject({ dryRun: true, added: expect.any(Number), merged: 0, path: globalPath });
    expect(plan.added).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
    const actual = makeIO();
    expect(await runPackAdd(['voice-tools'], { cwd, globalPath, json: true }, actual)).toBe(0);
    const { dryRun, plan: marker, ok, ...expected } = plan;
    expect(dryRun).toBe(true);
    expect(marker).toBe(true);
    expect(ok).toBe(true);
    expect(JSON.parse(actual.out)).toEqual([expected]);
  });

  it('previews each built-in pack against disk, then installs names in order', async () => {
    const before = await snapshot();
    const preview = makeIO();
    expect(await runPackAdd(['voice-tools', 'voice-tools'], { cwd, globalPath, dryRun: true, json: true }, preview)).toBe(0);
    const [first, second] = JSON.parse(preview.out);
    expect(first).toMatchObject({ dryRun: true, added: expect.any(Number), merged: 0 });
    expect(first.added).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(await snapshot()).toEqual(before);
    const actual = makeIO();
    expect(await runPackAdd(['voice-tools', 'voice-tools'], { cwd, globalPath, json: true }, actual)).toBe(0);
    const [installed, repeated] = JSON.parse(actual.out);
    expect(installed.added).toBe(first.added);
    expect(repeated.alreadyInstalled).toBe(true);
  });

  it('vendored pack removal previews removed and edited terms without modifying dictionary or caches', async () => {
    expect(await runPackAdd(['voice-tools'], { cwd, globalPath }, makeIO())).toBe(0);
    const installed = await loadLexicon({ cwd, globalPath });
    const edited = installed.merged.terms[0];
    await addTerm({ canonical: edited.canonical, aliases: ['custom spelling'] }, { cwd, globalPath });
    const before = await snapshot();
    const preview = makeIO();
    expect(await runPackRemove('voice-tools', { cwd, globalPath, dryRun: true, json: true }, preview)).toBe(0);
    const plan = JSON.parse(preview.out);
    expect(plan).toMatchObject({ ok: true, dryRun: true, kept: [edited.canonical] });
    expect(plan.removed.length).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
    const actual = makeIO();
    expect(await runPackRemove('voice-tools', { cwd, globalPath, json: true }, actual)).toBe(0);
    const { dryRun, ...expected } = plan;
    expect(dryRun).toBe(true);
    expect(JSON.parse(actual.out)).toEqual(expected);
    expect((await loadLexicon({ cwd, globalPath })).merged.terms.map((term) => term.canonical)).toEqual([edited.canonical]);
  });
});
