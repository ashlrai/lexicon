/**
 * registry: the git-based community pack index. Index loading, checksum
 * verification, publish validation and the install/update/remove round trip,
 * all against fixture indexes in a temp dir (no network).
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRegistryUpdate,
  cachedPackPath,
  downloadPack,
  findRegistryEntry,
  installRegistryPack,
  installedRegistryPacks,
  isRegistryRef,
  loadPackFile,
  loadRegistryIndex,
  parseRegistryRef,
  previewRegistryUpdates,
  readLexiconFile,
  readRegistryState,
  resolvePackUrl,
  searchRegistryIndex,
  sha256Hex,
  uninstallRegistryPack,
  validateCommunityPack,
  verifyPackChecksum,
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
  // tmpdir() is ephemeral; no cleanup needed.
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
