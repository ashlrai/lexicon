import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestReport, harvestRepo } from '../src/core/harvest.js';

// The XXX marker contract, per docs/harvest-markers.md: `XXX` is one exact
// uppercase literal in the generic identifier set, not a task-comment parse,
// not a substring filter, not a global ban on the spelling. A standalone
// `XXX` never matches the source identifier or README prose patterns, so it
// is never proposed; a `// XXX:` comment does not suppress the rest of its
// line; and manifest names, directory names and dot-TLD brands keep their own
// extraction paths, which the generic set does not consult.

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-xxx-')));
  // `repo` is a generic root name, so only what the test writes is proposed.
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  try {
    await run(repo);
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe('XXX marker contract', () => {
  it('counts the name in an XXX comment as source evidence, never the marker', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '// XXX: revisit QuasarWidget\n');

      const options = { git: false, minCount: 1 };
      // Source-only names are held back without `symbols`: the marker's name
      // is the one bucket counted as symbols-only, and the marker is not it.
      const heldBack = await harvestReport(repo, options);
      expect(heldBack.candidates).toEqual([]);
      expect(heldBack.symbolsOnly).toBe(1);
      expect(heldBack.belowMinCount).toBe(0);
      expect(heldBack.filesScanned).toBe(1);

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
        '// XXX: revisit this',
        '/* XXX XXX */',
        "const label = 'XXX: still not a name';",
      ].join('\n'));
      // `XXX` and `xxx` fail both capitalization patterns; `Xxx` and `xXx` are
      // too short or mis-capitalized for either. No casing is a candidate.
      await fs.writeFile(path.join(repo, 'README.md'), 'We write XXX and xxx and Xxx and xXx in prose.\n');

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
        '// XXX: XxxWidget QuasarXXX NebulaXXXBeacon',
        "const text = 'XXX QuasarXXX NebulaXXXBeacon XxxWidget';",
      ].join('\n'));

      const candidates = await harvestRepo(repo, { git: false, symbols: true, minCount: 1 });
      expect(candidates.map(({ canonical, category, source, count, evidence }) =>
        ({ canonical, category, source, count, evidence }))).toEqual(
        ['NebulaXXXBeacon', 'QuasarXXX', 'XxxWidget'].map((canonical) => ({
          canonical, category: 'identifier', source: 'harvest:repo', count: 2, evidence: ['markers.ts'],
        })));
    });
  });

  it('is not a global ban: manifest names, directory names and dot-TLD brands keep their own paths', async () => {
    // A crate literally named XXX: manifest extraction does not consult the
    // generic identifier set.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'Cargo.toml'), '[package]\nname = "XXX"\n');
      expect(await harvestRepo(repo, { git: false, minCount: 1 })).toEqual([
        expect.objectContaining({
          canonical: 'XXX', category: 'product', source: 'harvest:package',
          count: 1, evidence: ['Cargo.toml#package.name'],
        }),
      ]);
    });

    // The pyproject path has no generic-name gate at all, so the marker is
    // harvested there too.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'pyproject.toml'), '[project]\nname = "XXX"\n');
      expect(await harvestRepo(repo, { git: false, minCount: 1 })).toEqual([
        expect.objectContaining({
          canonical: 'XXX', category: 'product', source: 'harvest:package',
          count: 1, evidence: ['pyproject.toml#project.name'],
        }),
      ]);
    });

    // package.json is the exception: `XXX` has no lowercase letter and is
    // under four characters, so the placeholder rule drops it before any
    // marker question arises.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'package.json'), '{"name": "XXX"}\n');
      expect(await harvestRepo(repo, { git: false, minCount: 1 })).toEqual([]);
    });

    // A project directory named XXX: the directory-name bump is its own path.
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-xxx-')));
    const dir = path.join(base, 'XXX');
    await fs.mkdir(dir);
    try {
      expect(await harvestRepo(dir, { git: false, minCount: 1 })).toEqual([
        expect.objectContaining({
          canonical: 'XXX', category: 'product', source: 'harvest:repo',
          count: 1, evidence: ['directory name'],
        }),
      ]);
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }

    // XXX.AI scans as a dot-TLD brand; the bare marker is still never proposed.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'README.md'), 'Try XXX.AI today. XXX.AI is fast.\n');
      const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
      expect(candidates.map(({ canonical }) => canonical)).toEqual(['XXX.AI']);
      expect(candidates[0]).toMatchObject({
        category: 'brand', source: 'harvest:repo', count: 2, evidence: ['README.md'],
      });
    });
  });
});
