import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestReport, harvestRepo } from '../src/core/harvest.js';

// The HACK marker contract, per docs/harvest-markers.md: `HACK` is one
// exact uppercase literal in the generic identifier set, not a task-comment
// parse, not a substring filter, not a global ban on the spelling. A
// standalone `HACK` never matches the source identifier or README prose
// patterns, so it is never proposed; a `// HACK:` comment does not suppress
// the rest of its line; and manifest names, directory names and dot-TLD
// brands keep their own extraction paths, which the generic set does not
// consult.

async function withRepo(run: (repo: string) => Promise<void>): Promise<void> {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-hack-')));
  // `repo` is a generic root name, so only what the test writes is proposed.
  const repo = path.join(base, 'repo');
  await fs.mkdir(repo);
  try {
    await run(repo);
  } finally {
    await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe('HACK marker contract', () => {
  it('counts the name in a HACK comment as source evidence, never the marker', async () => {
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'note.ts'), '// HACK: revisit QuasarWidget\n');

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
        '// HACK: revisit this',
        '/* HACK HACK */',
        "const label = 'HACK: still not a name';",
      ].join('\n'));
      // `HACK` fails the README pattern as all caps, `hack` and `hAck` start
      // lowercase, and every four-letter spelling is short of the five
      // characters a source identifier needs. The spellings that do satisfy
      // a pattern are covered by the case test below.
      await fs.writeFile(path.join(repo, 'README.md'), 'We write HACK and hack and hAck in prose.\n');

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
        '// HACK: HackWidget QuasarHACK NebulaHACKBeacon HACKBeacon',
        "const text = 'HACK QuasarHACK NebulaHACKBeacon HACKBeacon HackWidget';",
      ].join('\n'));

      // `HACKBeacon` yields nothing at all: the marker is not stripped from
      // the token, and no PascalCase match survives inside it.
      const candidates = await harvestRepo(repo, { git: false, symbols: true, minCount: 1 });
      expect(candidates.map(({ canonical, category, source, count, evidence }) =>
        ({ canonical, category, source, count, evidence }))).toEqual(
        ['HackWidget', 'NebulaHACKBeacon', 'QuasarHACK'].map((canonical) => ({
          canonical, category: 'identifier', source: 'harvest:repo', count: 2, evidence: ['markers.ts'],
        })));
    });
  });

  it('harvests the sentence-case spellings in prose while the source pattern drops them', async () => {
    await withRepo(async (repo) => {
      // `Hack` has a single hump and `HaCk` is under five characters, so no
      // non-uppercase spelling of HACK can ever satisfy the source
      // identifier pattern; a `// Hack:` comment contributes its name only.
      await fs.writeFile(path.join(repo, 'note.ts'), '// Hack: rework QuasarWidget\n// HaCk: recheck PulsarWidget\n');
      const source = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
      expect(source.map(({ canonical, category, count }) => ({ canonical, category, count }))).toEqual([
        { canonical: 'PulsarWidget', category: 'identifier', count: 1 },
        { canonical: 'QuasarWidget', category: 'identifier', count: 1 },
      ]);

      // The same spellings satisfy the README prose pattern, so unlike `Xxx`
      // (too short) or `Todo`/`Note` (stoplisted) they are proposed. Both
      // lowercase to the same bucket, so each gets its own README.
      await fs.rm(path.join(repo, 'note.ts'));
      for (const spelling of ['Hack', 'HaCk']) {
        await fs.writeFile(path.join(repo, 'README.md'), `We use ${spelling} in prose.\n`);
        expect(await harvestRepo(repo, { git: false, minCount: 1 })).toEqual([
          expect.objectContaining({
            canonical: spelling, category: 'brand', source: 'harvest:repo', count: 1, evidence: ['README.md'],
          }),
        ]);
      }
    });
  });

  it('is not a global ban: the marker itself is harvested where the generic set is not consulted', async () => {
    // A crate literally named HACK: manifest extraction does not consult
    // the generic identifier set.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'Cargo.toml'), '[package]\nname = "HACK"\n');
      expect(await harvestRepo(repo, { git: false, minCount: 1 })).toEqual([
        expect.objectContaining({
          canonical: 'HACK', category: 'product', source: 'harvest:package',
          count: 1, evidence: ['Cargo.toml#package.name'],
        }),
      ]);
    });

    // The go.mod module tail is bumped raw too.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'go.mod'), 'module HACK\n');
      expect(await harvestRepo(repo, { git: false, minCount: 1 })).toEqual([
        expect.objectContaining({
          canonical: 'HACK', category: 'product', source: 'harvest:package',
          count: 1, evidence: ['go.mod#module'],
        }),
      ]);
    });

    // The pyproject path has no generic-name gate at all, so the marker is
    // harvested there too.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'pyproject.toml'), '[project]\nname = "HACK"\n');
      expect(await harvestRepo(repo, { git: false, minCount: 1 })).toEqual([
        expect.objectContaining({
          canonical: 'HACK', category: 'product', source: 'harvest:package',
          count: 1, evidence: ['pyproject.toml#project.name'],
        }),
      ]);
    });

    // package.json is the exception: `HACK` has no lowercase letter, so
    // the placeholder rule drops it before any marker question arises.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'package.json'), '{"name": "HACK"}\n');
      expect(await harvestRepo(repo, { git: false, minCount: 1 })).toEqual([]);
    });

    // A project directory named HACK: the directory-name bump is its own path.
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-hack-')));
    const dir = path.join(base, 'HACK');
    await fs.mkdir(dir);
    try {
      expect(await harvestRepo(dir, { git: false, minCount: 1 })).toEqual([
        expect.objectContaining({
          canonical: 'HACK', category: 'product', source: 'harvest:repo',
          count: 1, evidence: ['directory name'],
        }),
      ]);
    } finally {
      await fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }

    // HACK.sh scans as a dot-TLD brand; the bare marker is still never proposed.
    await withRepo(async (repo) => {
      await fs.writeFile(path.join(repo, 'README.md'), 'Try HACK.sh today. HACK.sh is fast.\n');
      const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
      expect(candidates.map(({ canonical }) => canonical)).toEqual(['HACK.sh']);
      expect(candidates[0]).toMatchObject({
        category: 'brand', source: 'harvest:repo', count: 2, evidence: ['README.md'],
      });
    });
  });
});
