import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestReport, harvestRepo } from '../src/core/harvest.js';

// The NOTE marker contract, per docs/harvest-markers.md: `NOTE` is one exact
// uppercase literal in the generic identifier set, not a task-comment parse,
// not a substring filter, not a global ban on the spelling. A standalone
// `NOTE` never matches the source identifier or README prose patterns, so it
// is never proposed; a `// NOTE:` comment does not suppress the rest of its
// line; and manifest names, directory names and dot-TLD brands keep their own
// extraction paths, which the generic set does not consult.

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-note-')));
  // `repo` is a generic root name, so only what the test writes is proposed.
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  try {
    await run(repo);
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe('NOTE marker contract', () => {
  it('counts the name in a NOTE comment as source evidence, never the marker', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '// NOTE: revisit QuasarWidget\n');

      const options = { git: false, minCount: 1 };
      // Source-only names are held back without `symbols`: the marker's name
      // is the one bucket counted as symbols-only, and the marker is not it.
      const heldBack = await harvestReport(repo, options);
      expect(heldBack.candidates).toEqual([]);
      expect(heldBack.symbolsOnly).toBe(1);

      const report = await harvestReport(repo, { ...options, symbols: true });
      expect(report.symbolsOnly).toBe(0);
      expect(report.candidates).toHaveLength(1);
      expect(report.candidates[0]).toMatchObject({
        canonical: 'QuasarWidget', category: 'identifier', source: 'harvest:repo',
        count: 1, evidence: ['note.ts'], suggestedAliases: [],
      });

      // README corroboration promotes the bucket to a brand and merges evidence.
      await fs.writeFile(path.join(repo, 'README.md'), 'We use QuasarWidget today.\n');
      const corroborated = await harvestRepo(repo, options);
      expect(corroborated).toHaveLength(1);
      expect(corroborated[0]).toMatchObject({
        canonical: 'QuasarWidget', category: 'brand', source: 'harvest:repo', count: 2,
      });
      expect(corroborated[0].evidence).toEqual(expect.arrayContaining(['note.ts', 'README.md']));

      const withoutIdentifiers = await harvestRepo(repo, { ...options, identifiers: false });
      expect(withoutIdentifiers).toHaveLength(1);
      expect(withoutIdentifiers[0]).toMatchObject({ canonical: 'QuasarWidget', count: 1, evidence: ['README.md'] });
    });
  });

  it('never proposes the marker itself from comments, strings or prose', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), [
        '// NOTE: revisit this',
        '/* NOTE NOTE */',
        "const label = 'NOTE: still not a name';",
      ].join('\n'));
      // `NOTE` and `note` fail the prose capitalization pattern; `Note` and
      // `Notes` are stoplisted. No casing of the marker is a candidate.
      await fs.writeFile(path.join(repo, 'README.md'), 'We write NOTE and note and Note and Notes in prose.\n');

      for (const options of [
        { git: false, minCount: 1 },
        { git: false, minCount: 1, symbols: true },
      ]) {
        const candidates = await harvestRepo(repo, options);
        expect(candidates.map(({ canonical }) => canonical)).toEqual([]);
      }
    });
  });

  it('keeps identifiers containing the marker while excluding the standalone literal', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'markers.ts'), [
        '// NOTE: NoteWidget QuasarNOTE NebulaNOTEBeacon',
        "const text = 'NOTE QuasarNOTE NebulaNOTEBeacon NoteWidget';",
      ].join('\n'));

      const candidates = await harvestRepo(repo, { git: false, symbols: true, minCount: 1 });
      expect(candidates.map(({ canonical, category, source, count, evidence }) =>
        ({ canonical, category, source, count, evidence }))).toEqual(
        ['NebulaNOTEBeacon', 'NoteWidget', 'QuasarNOTE'].map((canonical) => ({
          canonical, category: 'identifier', source: 'harvest:repo', count: 2, evidence: ['markers.ts'],
        })));
    });
  });

  it('proposes the mixed-case NoTe in prose under the exact-case set lookup', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'README.md'), 'We use NoTe today.\n');

      expect(await harvestRepo(repo, { git: false, minCount: 1 })).toEqual([
        expect.objectContaining({
          canonical: 'NoTe', category: 'brand', source: 'harvest:repo', count: 1, evidence: ['README.md'],
        }),
      ]);
    });
  });

  it('is not a global ban: manifest names, directory names and dot-TLD brands keep their own paths', async () => {
    // A crate literally named NOTE: manifest extraction does not consult the
    // generic identifier set.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'Cargo.toml'), '[package]\nname = "NOTE"\n');
      expect(await harvestRepo(repo, { git: false, minCount: 1 })).toEqual([
        expect.objectContaining({
          canonical: 'NOTE', category: 'product', source: 'harvest:package',
          count: 1, evidence: ['Cargo.toml#package.name'],
        }),
      ]);
    });

    // A project directory named NOTE: the directory-name bump is its own path.
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-note-')));
    const dir = path.join(base, 'NOTE');
    await fs.mkdir(dir);
    try {
      expect(await harvestRepo(dir, { git: false, minCount: 1 })).toEqual([
        expect.objectContaining({
          canonical: 'NOTE', category: 'product', source: 'harvest:repo',
          count: 1, evidence: ['directory name'],
        }),
      ]);
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }

    // NOTE.AI scans as a dot-TLD brand; the bare marker is still never proposed.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'README.md'), 'Try NOTE.AI today. NOTE.AI is fast.\n');
      const names = (await harvestRepo(repo, { git: false, minCount: 1 })).map(({ canonical }) => canonical);
      expect(names).toEqual(['NOTE.AI']);
    });
  });
});
