import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTerm, loadLexicon, readLexiconFile, recordHits } from '../src/core/store.js';
import { isTrusted, trustProject } from '../src/core/trust.js';

// Both trust guarantees on one changed project file: reads never parse it
// (parseSkipped: false), and writes refuse it and never merge or re-pin it.

let tmp: string;
let repo: string;
let projectPath: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['LEXICON_PATH', 'XDG_CONFIG_HOME', 'LEXICON_TRUST_ALL'];
const TRUSTED = 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n';
// Not a valid lexicon: any parse of it throws or is skipped, so an empty
// skippedProject.lexicon proves it was never parsed.
const CHANGED = 'version: 1\nterms: [this is: not: valid\n  - canonical: rm -rf ~\n';

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-both-')));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  projectPath = path.join(repo, '.lexicon.yaml');
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.LEXICON_PATH = path.join(tmp, 'config', 'lexicon.yaml');
  await fs.writeFile(projectPath, TRUSTED);
  await trustProject(projectPath, { cwd: repo });
  await fs.writeFile(projectPath, CHANGED);
});

afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('a changed project file: skipped without a parse, and never written or re-pinned', () => {
  it('loadLexicon with parseSkipped:false leaves it out unparsed', async () => {
    const loaded = await loadLexicon({ cwd: repo, parseSkipped: false });
    expect(loaded.projectTrust).toBe('changed');
    expect(loaded.skippedProject?.lexicon.terms).toEqual([]);
    expect(loaded.merged.terms.some((t) => t.canonical.startsWith('rm -rf'))).toBe(false);
  });

  it('recordHits does not throw or trust it', async () => {
    await recordHits(['Ashlr.AI'], { cwd: repo });
    expect(await fs.readFile(projectPath, 'utf8')).toBe(CHANGED);
  });

  it('a project write refuses it, leaves the bytes alone and keeps it changed', async () => {
    await expect(addTerm({ canonical: 'Kubectl', aliases: [] }, { scope: 'project', cwd: repo })).rejects.toThrow();
    expect(await fs.readFile(projectPath, 'utf8')).toBe(CHANGED);
    let status: string | undefined;
    try {
      status = await isTrusted(await readLexiconFile(projectPath, 'project'), { cwd: repo });
    } catch {
      status = 'unparseable';
    }
    expect(status).not.toBe('trusted');
  });
});

