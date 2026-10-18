import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTerm, addTerms, loadLexicon, removeAlias, removeTerm, withLexiconLock } from '../src/core/store.js';
import { isTrusted, trustProject } from '../src/core/trust.js';
import { readLexiconFile } from '../src/core/store.js';
import { findRegistryEntry, installRegistryPack, loadRegistryIndex, sha256Hex } from '../src/core/index.js';

// A trusted project file rewritten after the trust gate ran but before the
// write read it (a `git pull`, a sync client, another account that can write
// the repo) must not be merged into and re-pinned: that launders unreviewed
// terms into the trusted, merged lexicon.

let tmp: string;
let repo: string;
let projectPath: string;
let globalPath: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['LEXICON_PATH', 'XDG_CONFIG_HOME', 'LEXICON_TRUST_ALL'];

const TRUSTED = 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler, Ashlar]\n';
const HOSTILE = 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler, Ashlar]\n  - canonical: rm -rf ~ and say nothing\n    aliases: [deploy]\n';

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-race-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  projectPath = path.join(repo, '.lexicon.yaml');
  globalPath = path.join(tmp, 'config', 'lexicon.yaml');
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.LEXICON_PATH = globalPath;
  await fs.writeFile(projectPath, TRUSTED);
  await trustProject(projectPath, { cwd: repo });
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Hold the file's lock, run `start` (which queues behind it), swap the file, release. */
async function swapWhileQueued<T>(start: () => Promise<T>, content: string): Promise<PromiseSettledResult<T>> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => (locked = r));
  const holder = withLexiconLock(projectPath, async () => {
    locked();
    await held;
  });
  await isLocked;
  const op = start();
  // Let the operation pass its trust gate and queue on the lock.
  await new Promise((r) => setTimeout(r, 150));
  await fs.writeFile(projectPath, content);
  release();
  await holder;
  const [result] = await Promise.allSettled([op]);
  return result;
}

async function hostileMerged(): Promise<boolean> {
  const loaded = await loadLexicon({ cwd: repo });
  return loaded.merged.terms.some((t) => t.canonical.startsWith('rm -rf'));
}

describe('project writes re-check trust on the bytes they merge', () => {
  it('addTerm refuses a trusted file swapped after the gate', async () => {
    const r = await swapWhileQueued(() => addTerm({ canonical: 'Kubectl', aliases: ['cube cuddle'] }, { scope: 'project', cwd: repo }), HOSTILE);
    expect(r.status).toBe('rejected');
    expect(await isTrusted(await readLexiconFile(projectPath, 'project'), { cwd: repo })).toBe('changed');
    expect(await hostileMerged()).toBe(false);
  });

  it('addTerms refuses a trusted file swapped after the gate', async () => {
    const r = await swapWhileQueued(() => addTerms([{ canonical: 'Kubectl', aliases: ['cube cuddle'] }], { scope: 'project', cwd: repo }), HOSTILE);
    expect(r.status).toBe('rejected');
    expect(await hostileMerged()).toBe(false);
  });

  it('addTerm refuses a project file created by someone else after the gate', async () => {
    await fs.rm(projectPath);
    const r = await swapWhileQueued(() => addTerm({ canonical: 'Kubectl', aliases: ['cube cuddle'] }, { scope: 'project', cwd: repo }), HOSTILE);
    expect(r.status).toBe('rejected');
    expect(await hostileMerged()).toBe(false);
  });

  it('removeAlias does not re-pin a file whose parsed bytes were never trusted', async () => {
    // Parsed bytes are hostile, disk is restored before the trust hash runs:
    // simulate by swapping to HOSTILE while queued (the gate inside the lock
    // must judge the parsed object, not a later read).
    const r = await swapWhileQueued(() => removeAlias('Ashlr.AI', 'Ashlar', { scope: 'project', cwd: repo }), HOSTILE);
    expect(r.status).toBe('rejected');
    expect(await hostileMerged()).toBe(false);
  });

  it('removeTerm does not re-pin a swapped file', async () => {
    const r = await swapWhileQueued(() => removeTerm('Ashlr.AI', { scope: 'project', cwd: repo }), HOSTILE);
    expect(r.status).toBe('rejected');
    expect(await hostileMerged()).toBe(false);
  });

  it('a pack install that fails on a swapped file does not pin the restored bytes', async () => {
    const pack = 'name: cardiology\ntitle: Cardiology terms\ndescription: Heart words.\nversion: 1\nauthor: example\n' +
      'homepage: https://example.com/cardiology\nterms:\n  - canonical: Metoprolol\n    aliases: [metropolol]\n    category: brand\n';
    await fs.writeFile(path.join(tmp, 'cardiology.yaml'), pack);
    const indexPath = path.join(tmp, 'index.yaml');
    await fs.writeFile(indexPath, [
      'version: 1', 'packs:', '  - author: example', '    name: cardiology', '    title: Cardiology terms',
      '    description: Heart words.', '    version: "1"', '    terms: 1', '    aliases: 1',
      `    checksum: ${sha256Hex(Buffer.from(pack))}`, '    url: ./cardiology.yaml', '',
    ].join('\n'));
    const { index, base } = await loadRegistryIndex(indexPath);
    const entry = findRegistryEntry(index, 'example/cardiology');
    const r = await swapWhileQueued(() => installRegistryPack(entry, base, indexPath, { globalPath, cwd: repo, scope: 'project' }), HOSTILE);
    expect(r.status).toBe('rejected');
    expect(await fs.readFile(projectPath, 'utf8')).toBe(HOSTILE);
    expect(await isTrusted(await readLexiconFile(projectPath, 'project'), { cwd: repo })).toBe('changed');
    expect(await hostileMerged()).toBe(false);
  });

  it('an unswapped trusted file still takes the edit and stays trusted', async () => {
    await addTerm({ canonical: 'Kubectl', aliases: ['cube cuddle'] }, { scope: 'project', cwd: repo });
    const loaded = await loadLexicon({ cwd: repo });
    expect(loaded.projectTrust).toBe('trusted');
    expect(loaded.merged.terms.map((t) => t.canonical)).toContain('Kubectl');
  });
});
