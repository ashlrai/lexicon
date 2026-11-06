import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

const dirs: string[] = [];
async function repoWith(source: string): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-hack-'));
  dirs.push(base);
  // `repo` is a generic root name, so only what the test writes is proposed.
  const dir = path.join(base, 'repo');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'marker.ts'), source);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

// HACK is a recognized comment marker: harvest reads the comment for the
// names around it but never proposes the marker word itself.
describe('harvest HACK marker', () => {
  it('counts a name found only in HACK comment text as source evidence', async () => {
    const dir = await repoWith('// HACK: retry NebulaRelay after disconnect\n');
    const options = { git: false, minCount: 1 };

    expect(await harvestRepo(dir, options)).toEqual([]);
    expect(await harvestRepo(dir, { ...options, symbols: true })).toEqual([
      expect.objectContaining({
        canonical: 'NebulaRelay', category: 'identifier', source: 'harvest:repo',
        count: 1, evidence: ['marker.ts'],
      }),
    ]);

    await fs.writeFile(path.join(dir, 'README.md'), 'We use NebulaRelay today.\n');
    const corroborated = await harvestRepo(dir, options);
    expect(corroborated).toEqual([
      expect.objectContaining({ canonical: 'NebulaRelay', count: 2 }),
    ]);
    expect(corroborated[0]?.evidence).toEqual(expect.arrayContaining(['marker.ts', 'README.md']));
    expect(await harvestRepo(dir, { ...options, identifiers: false })).toEqual([
      expect.objectContaining({ canonical: 'NebulaRelay', count: 1, evidence: ['README.md'] }),
    ]);
  });

  it('harvests the name beside a HACK comment and not the marker', async () => {
    const dir = await repoWith('// HACK: retry in QuasarWidget\nclass QuasarWidget {}\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    // The comment mention and the declaration count once each: the marker
    // does not suppress the rest of its line, and no casing of it appears.
    expect(candidates).toEqual([
      expect.objectContaining({
        canonical: 'QuasarWidget', category: 'identifier', source: 'harvest:repo',
        count: 2, evidence: ['marker.ts'],
      }),
    ]);
    const names = candidates.map((c) => c.canonical);
    for (const spelling of ['HACK', 'Hack', 'hack']) {
      expect(names).not.toContain(spelling);
    }
  });

  it('does not propose HACK even when it is the only comment word', async () => {
    const dir = await repoWith('// HACK\nexport const x = 1;\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    expect(candidates.map((c) => c.canonical)).not.toContain('HACK');
  });

  it('ignores HACK in block comments and the doc prose scan', async () => {
    const dir = await repoWith('/* HACK: drain NebulaQueue */\nclass NebulaQueue {}\n');
    await fs.writeFile(path.join(dir, 'README.md'), 'HACK: tune NebulaQueue.\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    // README corroboration promotes the name to a brand; the marker itself is
    // all caps, so neither the source nor the prose scanner picks it up.
    expect(candidates).toEqual([
      expect.objectContaining({
        canonical: 'NebulaQueue', category: 'brand', source: 'harvest:repo', count: 3,
      }),
    ]);
    expect(candidates[0]?.evidence).toEqual(expect.arrayContaining(['marker.ts', 'README.md']));
  });
});

// A marker only counts as a standalone word. HACK inside a longer ordinary
// word (Hackathon, SHORTHACKS) is part of that word: harvest keeps the whole
// word when it qualifies and never reports the embedded marker.
describe('harvest HACK embedded in a longer word', () => {
  it('keeps the whole word and never proposes the embedded marker', async () => {
    const dir = await repoWith(
      '// SHORTHACKS and HackathonSync\nconst HackathonLedger = 1;\n// HackathonLedger HackathonSync HackathonSync\n',
    );
    await fs.writeFile(path.join(dir, 'README.md'), 'We run Hackathon and Hackathon events. HACKS: none.\n');
    const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
    const names = candidates.map((c) => c.canonical);
    expect(names).toContain('Hackathon');
    expect(names).toContain('HackathonSync');
    expect(names).toContain('HackathonLedger');
    for (const embedded of ['HACK', 'Hack', 'hack', 'HACKS', 'SHORTHACKS']) {
      expect(names).not.toContain(embedded);
    }
  });
});
