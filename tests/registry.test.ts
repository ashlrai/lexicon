/**
 * registry: the git-based community pack index. Index loading, checksum
 * verification, publish validation and the install/update/remove round trip,
 * all against fixture indexes in a temp dir (no network).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_LEXICON_BYTES,
  MAX_REGISTRY_FILE_BYTES,
  applyRegistryUpdate,
  assertSecureRegistryUrl,
  assertUserRegistry,
  canonicalRegistrySource,
  userRegistrySources,
  cachedPackPath,
  downloadPack,
  findRegistryEntry,
  installPack,
  installRegistryPack,
  installedRegistryPacks,
  isRegistryRef,
  loadPackFile,
  loadRegistryIndex,
  parseRegistryRef,
  previewRegistryUpdates,
  readLexiconFile,
  readRegistryState,
  registryDir,
  resolvePackUrl,
  searchRegistryIndex,
  sha256Hex,
  uninstallPack,
  uninstallRegistryPack,
  validateCommunityPack,
  verifyPackChecksum,
  writeRegistryState,
} from '../src/core/index.js';
import type { RegistryIndex, RegistryIndexEntry } from '../src/core/index.js';

const PACK_V1 = `name: cardiology
title: Cardiology terms
description: Heart words.
version: 1
author: example
homepage: https://example.com/cardiology
terms:
  - canonical: Metoprolol
    aliases: [metoprolol, metropolol]
    category: brand
  - canonical: Echocardiogram
    aliases: [echocardiogram]
    category: product
`;

const PACK_V2 = `name: cardiology
title: Cardiology terms
description: Heart words.
version: 1
author: example
homepage: https://example.com/cardiology
terms:
  - canonical: Metoprolol
    aliases: [metoprolol, metropolol]
    category: brand
  - canonical: Echocardiogram
    aliases: [echocardiogram]
    category: product
  - canonical: Stent
    aliases: [stent]
    category: product
`;

function writeIndex(dir: string, packs: { file: string; version: string }[]): string {
  const entries = packs.map(({ file, version }) => {
    const bytes = readFileSync(path.join(dir, file));
    return [
      '  - author: example',
      '    name: cardiology',
      '    title: Cardiology terms',
      '    description: Heart words.',
      `    version: "${version}"`,
      `    terms: 2`,
      `    aliases: 3`,
      `    checksum: ${sha256Hex(bytes)}`,
      `    url: ./${file}`,
    ].join('\n');
  });
  const indexPath = path.join(dir, 'index.yaml');
  writeFileSync(indexPath, `version: 1\npacks:\n${entries.join('\n')}\n`);
  return indexPath;
}

let dir: string;
let globalPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lexicon-registry-test-'));
  globalPath = path.join(dir, 'lexicon.yaml');
  writeFileSync(path.join(dir, 'cardiology.yaml'), PACK_V1);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function entryFor(index: RegistryIndex): RegistryIndexEntry {
  return findRegistryEntry(index, 'example/cardiology');
}

describe('parseRegistryRef', () => {
  it('parses author/name and author/name@version', () => {
    expect(parseRegistryRef('example/cardiology')).toEqual({ author: 'example', name: 'cardiology', ref: 'example/cardiology' });
    expect(parseRegistryRef('example/cardiology@2').version).toBe('2');
  });

  it('rejects bad refs', () => {
    for (const bad of ['cardiology', 'Example/cardiology', 'example/', '/cardiology', 'a/b/c']) {
      expect(() => parseRegistryRef(bad)).toThrow(/invalid pack ref/);
    }
  });

  it('isRegistryRef distinguishes vendored names', () => {
    expect(isRegistryRef('example/cardiology')).toBe(true);
    expect(isRegistryRef('developer')).toBe(false);
  });
});

describe('loadRegistryIndex', () => {
  it('loads a file path index and resolves relative urls', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    expect(index.packs.length).toBe(1);
    const entry = entryFor(index);
    expect(entry.ref).toBe('example/cardiology');
    expect(entry.author).toBe('example');
    expect(resolvePackUrl(entry, base)).toBe(path.join(dir, 'cardiology.yaml'));
  });

  // Catches: an index fetched over https could name an absolute local path,
  // and downloadPack read it from this machine (`/dev/stdin` hung the MCP
  // server on its own protocol stream; any file's sha256 came back in the
  // checksum error). Here the local file even matches the checksum, so the
  // old code returned its bytes.
  it('a remote index cannot name a local file', async () => {
    const local = path.join(dir, 'cardiology.yaml');
    const checksum = sha256Hex(readFileSync(local));
    const remoteIndex = (url: string) =>
      [
        'version: 1',
        'packs:',
        '  - author: example',
        '    name: cardiology',
        '    title: Cardiology terms',
        '    terms: 2',
        '    aliases: 3',
        `    checksum: ${checksum}`,
        `    url: ${JSON.stringify(url)}`,
        '',
      ].join('\n');
    const fetchBytes = vi.fn(async () => Buffer.from(PACK_V1));
    for (const url of [local, `file://${local}`, 'C:\\Windows\\win.ini', '//other.example/x.yaml']) {
      const fetchText = vi.fn(async () => remoteIndex(url));
      const { index, base } = await loadRegistryIndex('https://registry.example/index.yaml', { fetchText });
      const entry = entryFor(index);
      expect(() => resolvePackUrl(entry, base)).toThrow(/a remote index may only name https:\/\/ URLs or paths relative to itself/);
      await expect(downloadPack(entry, base, { fetchBytes })).rejects.toThrow(/names a local file/);
    }
    expect(fetchBytes).not.toHaveBeenCalled();
    // Relative paths and https URLs still resolve against the remote index.
    const fetchText = vi.fn(async () => remoteIndex('./packs/cardiology.yaml'));
    const { index, base } = await loadRegistryIndex('https://registry.example/v1/index.yaml', { fetchText });
    expect(resolvePackUrl(entryFor(index), base)).toBe('https://registry.example/v1/packs/cardiology.yaml');
  });

  // Catches: plain http:// was accepted for an index and for pack files, and
  // the index is what vouches for each pack's checksum, so anyone on the path
  // could swap both and land any terms in the lexicon.
  it('refuses plain http:// for an index or a pack file, except from this machine', async () => {
    const fetchText = vi.fn(async () => 'version: 1\npacks: []\n');
    await expect(loadRegistryIndex('http://registry.example/index.yaml', { fetchText })).rejects.toThrow(/fetched over https:\/\/ only/);
    expect(fetchText).not.toHaveBeenCalled();
    const indexText = [
      'version: 1', 'packs:', '  - author: example', '    name: cardiology', '    title: Cardiology terms',
      '    terms: 2', '    aliases: 3', `    checksum: ${sha256Hex(PACK_V1)}`, '    url: http://cdn.example/cardiology.yaml', '',
    ].join('\n');
    const { index, base } = await loadRegistryIndex('https://registry.example/index.yaml', { fetchText: async () => indexText });
    const fetchBytes = vi.fn(async () => Buffer.from(PACK_V1));
    await expect(downloadPack(entryFor(index), base, { fetchBytes })).rejects.toThrow(/fetched over https:\/\/ only/);
    expect(fetchBytes).not.toHaveBeenCalled();
    for (const ok of ['https://registry.example/i.yaml', 'http://127.0.0.1:8080/i.yaml', 'http://localhost/i.yaml', 'http://[::1]:9/i.yaml']) {
      expect(() => assertSecureRegistryUrl(ok)).not.toThrow();
    }
    for (const bad of ['http://registry.example/i.yaml', 'http://127.0.0.1.evil.example/i.yaml', 'ftp://registry.example/i.yaml']) {
      expect(() => assertSecureRegistryUrl(bad)).toThrow(/https:\/\/ only/);
    }
  });

  it('a local index may name a file:// URL', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    const entry = { ...entryFor(index), url: `file://${path.join(dir, 'cardiology.yaml')}` };
    expect(resolvePackUrl(entry, base)).toBe(path.join(dir, 'cardiology.yaml'));
    expect((await downloadPack(entry, base)).toString('utf8')).toBe(PACK_V1);
  });

  // Catches: registry reads had no size limit. The default fetch buffered a
  // whole response (a hostile registry could stream until the process died),
  // and a local index path (MCP list_packs takes one from the model) of
  // /dev/zero read until Node gave up. Bounded by a race so a regression
  // fails instead of stalling the suite; the server stops at 32 MB.
  async function within<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still reading after ${ms}ms`)), ms); })]);
    } finally {
      clearTimeout(timer);
    }
  }

  it('caps registry files at the lexicon size limit', () => {
    expect(MAX_REGISTRY_FILE_BYTES).toBe(MAX_LEXICON_BYTES);
  });

  it('refuses a registry response over the size limit without buffering it', async () => {
    const http = await import('node:http');
    let sent = 0;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/yaml' }); // no Content-Length: chunked
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const pump = (): void => {
        while (sent < 32 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        res.end();
      };
      res.on('close', () => { sent = Number.POSITIVE_INFINITY; });
      pump();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      await expect(within(loadRegistryIndex(`http://127.0.0.1:${port}/index.yaml`), 10_000)).rejects.toThrow(/exceeds the \d+ byte limit/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.skipIf(process.platform === 'win32')('refuses a local index or pack file that is a device', async () => {
    await expect(within(loadRegistryIndex('/dev/zero'), 1_500)).rejects.toThrow(/not a regular file/);
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    await expect(within(downloadPack({ ...entryFor(index), url: '/dev/zero' }, base), 1_500)).rejects.toThrow(/not a regular file/);
  });

  it('does not quote the source of an index that fails to parse', async () => {
    const file = path.join(dir, 'secret.yaml');
    writeFileSync(file, 'api_key: sk-THIS-IS-SECRET-VALUE\n  bad: [indent\n');
    const err = await loadRegistryIndex(file).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/invalid registry index/);
    expect((err as Error).message).not.toContain('sk-THIS-IS-SECRET-VALUE');
  });

  it('loads a file:// url', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index } = await loadRegistryIndex(`file://${indexPath}`);
    expect(index.packs.length).toBe(1);
  });

  it('throws a readable error for a missing index', async () => {
    await expect(loadRegistryIndex(path.join(dir, 'nope.yaml'))).rejects.toThrow(/not found/);
  });

  it('throws a readable error for a broken index', async () => {
    const bad = path.join(dir, 'bad.yaml');
    writeFileSync(bad, 'version: 1\npacks:\n  - author: nope\n');
    await expect(loadRegistryIndex(bad)).rejects.toThrow(/invalid registry index/);
  });

  it('findRegistryEntry lists what the index holds', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index } = await loadRegistryIndex(indexPath);
    expect(() => findRegistryEntry(index, 'example/neurology')).toThrow(/example\/cardiology/);
  });
});

describe('searchRegistryIndex', () => {
  it('ranks ref matches above description matches', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index } = await loadRegistryIndex(indexPath);
    expect(searchRegistryIndex(index, 'cardio')[0].ref).toBe('example/cardiology');
    expect(searchRegistryIndex(index, 'heart')[0].ref).toBe('example/cardiology');
    expect(searchRegistryIndex(index, 'neurology')).toEqual([]);
    expect(searchRegistryIndex(index, '').length).toBe(1);
  });
});

describe('checksums', () => {
  it('sha256Hex is stable and verifyPackChecksum accepts it', () => {
    const bytes = Buffer.from(PACK_V1);
    const hex = sha256Hex(bytes);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(() => verifyPackChecksum(bytes, hex, 'example/cardiology')).not.toThrow();
  });

  it('verifyPackChecksum refuses tampered bytes', () => {
    const bytes = Buffer.from(PACK_V1);
    const tampered = Buffer.from(`${PACK_V1}\n  - canonical: Evil\n    aliases: []\n`);
    expect(() => verifyPackChecksum(tampered, sha256Hex(bytes), 'example/cardiology')).toThrow(/checksum mismatch/);
  });

  it('downloadPack verifies the checksum', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    const entry = entryFor(index);
    const bytes = await downloadPack(entry, base);
    expect(bytes.toString('utf8')).toBe(PACK_V1);
    // Tamper with the file after the index was written: the download refuses it.
    writeFileSync(path.join(dir, 'cardiology.yaml'), `${PACK_V1}# tampered\n`);
    await expect(downloadPack(entry, base)).rejects.toThrow(/checksum mismatch/);
  });
});

describe('validateCommunityPack', () => {
  it('accepts the example pack', async () => {
    const pack = await loadPackFile(path.join(dir, 'cardiology.yaml'));
    expect(pack.author).toBe('example');
    expect(pack.homepage).toBe('https://example.com/cardiology');
    const { errors, warnings } = validateCommunityPack(pack);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('requires an author and flags ordinary words', async () => {
    const file = path.join(dir, 'badpack.yaml');
    writeFileSync(
      file,
      `name: badpack
title: Bad
description: Bad pack.
version: 1
terms:
  - canonical: Sauce
    aliases: [sawce]
  - canonical: Good Term
    aliases: []
`,
    );
    const pack = await loadPackFile(file);
    const { errors, warnings } = validateCommunityPack(pack);
    expect(errors.some((e) => e.includes('author is required'))).toBe(true);
    expect(errors.some((e) => e.includes('"Sauce"') && e.includes('ordinary English word'))).toBe(true);
    expect(warnings.some((w) => w.includes('"Good Term"') && w.includes('no aliases'))).toBe(true);
  });
});

describe('install / update / remove round trip', () => {
  it('shares project registry identity across raw and OS-canonical directory aliases', async () => {
    // Windows tmp paths may contain an 8.3 user-directory spelling; async
    // realpath expands it. On macOS this also exercises /var -> /private/var.
    const cwd = path.join(dir, 'canonical-project');
    mkdirSync(path.join(cwd, '.git'), { recursive: true });
    const canonicalCwd = await fs.realpath(cwd);
    const raw = { globalPath, cwd, scope: 'project' as const };
    const canonical = { globalPath, cwd: canonicalCwd, scope: 'project' as const };
    expect(registryDir(raw)).toBe(registryDir(canonical));
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    const entry = entryFor(index);
    await installRegistryPack(entry, base, indexPath, raw);
    expect(registryDir(raw)).toBe(registryDir(canonical));
    expect(cachedPackPath(entry.ref, raw)).toBe(cachedPackPath(entry.ref, canonical));
    expect(await installedRegistryPacks(canonical)).toEqual([entry.ref]);
    expect(await readRegistryState(canonical)).toEqual(await readRegistryState(raw));
    await uninstallRegistryPack(entry.ref, undefined, canonical);
    expect(await installedRegistryPacks(raw)).toEqual([]);
  });

  it('keeps the same pack separate in two projects and global, including updates/removal', async () => {
    const a = path.join(dir, 'project-a'); const b = path.join(dir, 'project-b');
    mkdirSync(path.join(a, '.git'), { recursive: true }); mkdirSync(path.join(b, '.git'), { recursive: true });
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath); const entry = entryFor(index);
    const scopes = [{ globalPath }, { globalPath, cwd: a, scope: 'project' as const }, { globalPath, cwd: b, scope: 'project' as const }];
    for (const opts of scopes) await installRegistryPack(entry, base, indexPath, opts);
    expect(new Set(scopes.map(opts => cachedPackPath(entry.ref, opts))).size).toBe(3);
    writeFileSync(path.join(dir, 'cardiology.yaml'), PACK_V2);
    const index2 = writeIndex(dir, [{ file: 'cardiology.yaml', version: '2' }]);
    const [preview] = await previewRegistryUpdates([entry.ref], index2, scopes[1]);
    expect((await applyRegistryUpdate(preview, index2, scopes[0])).status).toBe('failed');
    expect((await applyRegistryUpdate(preview, index2, scopes[2])).status).toBe('failed');
    expect((await applyRegistryUpdate(preview, index2, scopes[1])).status).toBe('updated');
    expect((await readLexiconFile(path.join(a, '.lexicon.yaml'), 'project')).lexicon.terms.map(t => t.canonical)).toContain('Stent');
    expect((await readLexiconFile(path.join(b, '.lexicon.yaml'), 'project')).lexicon.terms.map(t => t.canonical)).not.toContain('Stent');
    expect((await readLexiconFile(globalPath, 'global')).lexicon.terms.map(t => t.canonical)).not.toContain('Stent');
    await uninstallRegistryPack(entry.ref, undefined, scopes[1]);
    expect(await installedRegistryPacks(scopes[1])).toEqual([]);
    expect(await installedRegistryPacks(scopes[0])).toEqual([entry.ref]);
    expect(await installedRegistryPacks(scopes[2])).toEqual([entry.ref]);
  });

  it('rejected replacement preserves the original cache, state and removable terms', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath); const entry = entryFor(index);
    await installRegistryPack(entry, base, indexPath, { globalPath });
    const cache = cachedPackPath(entry.ref, { globalPath }); const previousState = await readRegistryState({ globalPath });
    const bad = PACK_V2.replace('title: Cardiology terms', 'title: Unapproved replacement');
    const badEntry = { ...entry, checksum: sha256Hex(bad) };
    await expect(installRegistryPack(badEntry, base, indexPath, { globalPath, approvedBytes: Buffer.from(bad) })).rejects.toThrow(/name\/title/);
    expect(readFileSync(cache, 'utf8')).toBe(PACK_V1);
    expect(await readRegistryState({ globalPath })).toEqual(previousState);
    expect((await uninstallRegistryPack(entry.ref, undefined, { globalPath })).removed.sort()).toEqual(['Echocardiogram', 'Metoprolol']);
  });

  it('rolls back lexicon and cache when the metadata commit fails after install', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath); const entry = entryFor(index);
    await installRegistryPack(entry, base, indexPath, { globalPath });
    const previous = readFileSync(globalPath, 'utf8'); const state = await readRegistryState({ globalPath });
    const statePath = await fs.realpath(path.join(registryDir({ globalPath }), 'registry.json')); const rename = fs.rename;
    let fail = true;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === statePath && fail) { fail = false; throw new Error('synthetic metadata failure'); }
      return rename(from, to);
    });
    await expect(installRegistryPack({ ...entry, checksum: sha256Hex(PACK_V2) }, base, indexPath, { globalPath, approvedBytes: Buffer.from(PACK_V2) })).rejects.toThrow('synthetic metadata failure');
    expect(readFileSync(globalPath, 'utf8')).toBe(previous);
    expect(readFileSync(cachedPackPath(entry.ref, { globalPath }), 'utf8')).toBe(PACK_V1);
    expect(await readRegistryState({ globalPath })).toEqual(state);
  });

  it.each(['global', 'project'] as const)('rolls back %s removal when the metadata commit fails', async (scope) => {
    const cwd = path.join(dir, 'project');
    mkdirSync(path.join(cwd, '.git'), { recursive: true });
    const opts = { globalPath, cwd, scope };
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    const entry = entryFor(index);
    const installed = await installRegistryPack(entry, base, indexPath, opts);
    const previous = readFileSync(installed.path, 'utf8');
    const state = await readRegistryState(opts);
    const cache = readFileSync(cachedPackPath(entry.ref, opts), 'utf8');
    const statePath = await fs.realpath(path.join(registryDir(opts), 'registry.json'));
    const rename = fs.rename;
    let fail = true;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === statePath && fail) {
        fail = false;
        throw new Error('synthetic removal metadata failure');
      }
      return rename(from, to);
    });
    await expect(uninstallRegistryPack(entry.ref, undefined, opts))
      .rejects.toThrow('synthetic removal metadata failure');
    expect(readFileSync(installed.path, 'utf8')).toBe(previous);
    expect(readFileSync(cachedPackPath(entry.ref, opts), 'utf8')).toBe(cache);
    expect(await readRegistryState(opts)).toEqual(state);
    // The restored project must remain trusted and support a subsequent removal.
    expect((await uninstallRegistryPack(entry.ref, undefined, opts)).removed.sort())
      .toEqual(['Echocardiogram', 'Metoprolol']);
    expect(await installedRegistryPacks(opts)).toEqual([]);
  });

  it('copies approved bytes and rejects payload drift without fetching a replacement', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath); const entry = entryFor(index);
    const fetchBytes = vi.fn();
    await expect(installRegistryPack(entry, base, indexPath, { globalPath, approvedBytes: Buffer.from(PACK_V2) }, { fetchBytes })).rejects.toThrow('checksum mismatch');
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(await installedRegistryPacks({ globalPath })).toEqual([]);
  });

  it('rejects a stale update after a version pin changes without changing installed bytes', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    const entry = entryFor(index);
    await installRegistryPack(entry, base, indexPath, { globalPath });
    writeFileSync(path.join(dir, 'cardiology.yaml'), PACK_V2);
    const index2 = writeIndex(dir, [{ file: 'cardiology.yaml', version: '2' }]);
    const [preview] = await previewRegistryUpdates([entry.ref], index2, { globalPath });
    expect(preview.status).toBe('available');
    const legacyPreview = { ...preview };
    delete legacyPreview.installedStateDigest;
    expect((await applyRegistryUpdate(legacyPreview, index2, { globalPath })).status).toBe('failed');
    const state = await readRegistryState({ globalPath });
    state.packs[entry.ref].pinnedVersion = '1';
    await writeRegistryState(state, { globalPath });
    const previous = readFileSync(globalPath, 'utf8');
    const cache = readFileSync(cachedPackPath(entry.ref, { globalPath }), 'utf8');
    const applied = await applyRegistryUpdate(preview, index2, { globalPath });
    expect(applied.status).toBe('failed');
    expect(applied.error).toContain('preview and approve it again');
    expect(readFileSync(globalPath, 'utf8')).toBe(previous);
    expect(readFileSync(cachedPackPath(entry.ref, { globalPath }), 'utf8')).toBe(cache);
    expect(await readRegistryState({ globalPath })).toEqual(state);
  });

  it('shows alias-only updates and all applied note/pronunciation/case metadata', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath); const entry = entryFor(index);
    await installRegistryPack(entry, base, indexPath, { globalPath });
    const changed = PACK_V1.replace('metropolol]', 'metropolol, approved-new-alias]').replace('    category: brand', '    category: brand\n    notes: "model-visible note payload"\n    phonetic: "met-oh"\n    caseSensitive: true');
    writeFileSync(path.join(dir, 'cardiology.yaml'), changed);
    const index2 = writeIndex(dir, [{ file: 'cardiology.yaml', version: '2' }]);
    const [preview] = await previewRegistryUpdates([entry.ref], index2, { globalPath });
    expect(preview.added).toEqual([]); expect(preview.removed).toEqual([]);
    expect(preview.changed?.[0].after).toMatchObject({ notes: 'model-visible note payload', phonetic: 'met-oh', caseSensitive: true });
    expect(preview.terms?.[0].aliases).toContain('approved-new-alias');
  });

  // Catches: removing a pack took a term an installed community pack also has (and the other way round).
  it('pack removal keeps a term the other kind of installed pack still has', async () => {
    const shared = `${PACK_V1}  - canonical: Kubernetes\n    category: product\n    aliases: [cuban eats, cuban needs, cuba needs, cooper netties, kube or netties, kubernetties]\n`;
    writeFileSync(path.join(dir, 'cardiology.yaml'), shared);
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    await installPack('developer', { cwd: dir, globalPath });
    await installRegistryPack(entryFor(index), base, indexPath, { cwd: dir, globalPath });

    const vendored = await uninstallPack('developer', { cwd: dir, globalPath });
    expect(vendored.shared).toEqual(['Kubernetes']);
    expect(vendored.removed).not.toContain('Kubernetes');
    const community = await uninstallRegistryPack('example/cardiology', undefined, { cwd: dir, globalPath });
    expect(community.removed).toContain('Kubernetes');
    expect((await readLexiconFile(globalPath, 'global')).lexicon.terms).toEqual([]);

    await installRegistryPack(entryFor(index), base, indexPath, { cwd: dir, globalPath });
    await installPack('developer', { cwd: dir, globalPath });
    expect((await uninstallRegistryPack('example/cardiology', undefined, { cwd: dir, globalPath })).shared).toEqual(['Kubernetes']);
  });

  // Catches: a relative --registry was recorded as typed, so pack update from another directory read a different file and MCP never counted it.
  it('records a relative or file:// index source as the absolute path it was read from', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const relative = path.relative(process.cwd(), indexPath);
    const { index, base } = await loadRegistryIndex(relative);
    await installRegistryPack(entryFor(index), base, relative, { globalPath });
    expect((await readRegistryState({ globalPath })).packs['example/cardiology'].indexSource).toBe(indexPath);
    expect(await userRegistrySources({ globalPath, cwd: dir, env: {} })).toContain(canonicalRegistrySource(indexPath));

    await installRegistryPack(entryFor(index), base, `file://${indexPath}`, { globalPath });
    expect((await readRegistryState({ globalPath })).packs['example/cardiology'].indexSource).toBe(indexPath);
  });

  it('installs, pins the checksum, updates on checksum change, removes cleanly', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    const entry = entryFor(index);

    const installed = await installRegistryPack(entry, base, indexPath, { globalPath });
    expect(installed.ref).toBe('example/cardiology');
    expect(installed.added).toBe(2);
    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms.map((t) => t.canonical).sort()).toEqual(['Echocardiogram', 'Metoprolol']);
    expect(file.lexicon.terms[0].source).toBe('pack');
    expect(file.lexicon.settings?.packs).toContain('example/cardiology');

    const state = await readRegistryState({ globalPath });
    expect(state.packs['example/cardiology'].checksum).toBe(entry.checksum);
    expect(await installedRegistryPacks({ globalPath })).toEqual(['example/cardiology']);
    // The pack file is cached for later removal.
    expect(readFileSync(cachedPackPath('example/cardiology', { globalPath }), 'utf8')).toBe(PACK_V1);

    // Idempotent reinstall merges.
    const again = await installRegistryPack(entry, base, indexPath, { globalPath });
    expect(again.added).toBe(0);
    expect(again.merged).toBe(2);

    // Preview says current while the index is unchanged.
    const current = await previewRegistryUpdates(['example/cardiology'], indexPath, { globalPath });
    expect(current[0].status).toBe('current');

    // Publish v2: new file, new checksum, new index.
    mkdirSync(path.join(dir, 'v2'), { recursive: true });
    writeFileSync(path.join(dir, 'v2', 'cardiology.yaml'), PACK_V2);
    const index2 = writeIndex(path.join(dir, 'v2'), [{ file: 'cardiology.yaml', version: '2' }]);
    const preview = await previewRegistryUpdates(['example/cardiology'], index2, { globalPath });
    expect(preview[0].status).toBe('available');
    expect(preview[0].from).toBe('1');
    expect(preview[0].to).toBe('2');
    expect(preview[0].added).toEqual(['Stent']);

    const applied = await applyRegistryUpdate(preview[0], index2, { globalPath });
    expect(applied.status).toBe('updated');
    expect(applied.added).toBe(1);
    const after = await readLexiconFile(globalPath, 'global');
    expect(after.lexicon.terms.map((t) => t.canonical)).toContain('Stent');
    const state2 = await readRegistryState({ globalPath });
    expect(state2.packs['example/cardiology'].checksum).not.toBe(entry.checksum);

    // Removal keeps the terms file otherwise intact and clears the state.
    const removed = await uninstallRegistryPack('example/cardiology', index2, { globalPath });
    expect(removed.removed.sort()).toEqual(['Echocardiogram', 'Metoprolol', 'Stent']);
    const gone = await readRegistryState({ globalPath });
    expect(gone.packs['example/cardiology']).toBeUndefined();
  });

  it('records a version pin and never moves a pinned pack', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    const entry = entryFor(index);
    await installRegistryPack(entry, base, indexPath, { globalPath, pinnedVersion: '1' });

    mkdirSync(path.join(dir, 'v2'), { recursive: true });
    writeFileSync(path.join(dir, 'v2', 'cardiology.yaml'), PACK_V2);
    const index2 = writeIndex(path.join(dir, 'v2'), [{ file: 'cardiology.yaml', version: '2' }]);
    const preview = await previewRegistryUpdates(['example/cardiology'], index2, { globalPath });
    expect(preview[0].status).toBe('pinned');
  });

  it('keeps user-edited terms on remove', async () => {
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    const { index, base } = await loadRegistryIndex(indexPath);
    await installRegistryPack(entryFor(index), base, indexPath, { globalPath });
    // Simulate the user adding an alias to a pack term: it must survive removal.
    const { addTerm } = await import('../src/core/index.js');
    await addTerm({ canonical: 'Metoprolol', aliases: ['metoprololol'] }, { globalPath });
    const removed = await uninstallRegistryPack('example/cardiology', undefined, { globalPath });
    expect(removed.kept).toContain('Metoprolol');
    expect(removed.removed).toContain('Echocardiogram');
  });
});

describe('user-registered registries (the agent-surface gate)', () => {
  it('canonicalizes urls and absolute paths, and never matches a relative path', () => {
    expect(canonicalRegistrySource('HTTPS://Example.COM/packs/index.yaml')).toBe('https://example.com/packs/index.yaml');
    expect(canonicalRegistrySource(`file://${path.join(dir, 'a', '..', 'index.yaml')}`)).toBe(path.join(dir, 'index.yaml'));
    expect(canonicalRegistrySource('./index.yaml')).toBeUndefined();
    expect(canonicalRegistrySource('   ')).toBeUndefined();
  });

  it('refuses every index until the user installs from it or lists it in LEXICON_REGISTRIES', async () => {
    const env = {};
    const indexPath = writeIndex(dir, [{ file: 'cardiology.yaml', version: '1' }]);
    await expect(assertUserRegistry(indexPath, { globalPath, env })).rejects.toThrow(/not one the user registered.*No registry is registered.*lexicon pack add/s);
    await expect(assertUserRegistry('https://evil.example/index.yaml', { globalPath, env })).rejects.toThrow(/not one the user registered/);
    await expect(assertUserRegistry('/etc/passwd', { globalPath, env })).rejects.toThrow(/not one the user registered/);

    const { index, base } = await loadRegistryIndex(indexPath);
    await installRegistryPack(entryFor(index), base, indexPath, { globalPath });
    await expect(assertUserRegistry(indexPath, { globalPath, env })).resolves.toBeUndefined();
    await expect(assertUserRegistry(`file://${indexPath}`, { globalPath, env })).resolves.toBeUndefined();
    await expect(assertUserRegistry('/etc/passwd', { globalPath, env })).rejects.toThrow(`Registered: ${indexPath}`);

    const listed = { LEXICON_REGISTRIES: 'https://packs.example.com/index.yaml, ./relative.yaml' };
    expect(await userRegistrySources({ globalPath, env: listed })).toEqual([indexPath, 'https://packs.example.com/index.yaml'].sort());
    await expect(assertUserRegistry('https://PACKS.example.com/index.yaml', { globalPath, env: listed })).resolves.toBeUndefined();
    await expect(assertUserRegistry('./relative.yaml', { globalPath, env: listed })).rejects.toThrow(/not one the user registered/);
  });
});
