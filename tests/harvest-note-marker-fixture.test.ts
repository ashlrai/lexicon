import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { harvestRepo, harvestReport } from '../src/core/harvest.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'note-marker');

// The committed fixture exercises every NOTE comment style the harvester
// meets in real source: `//` line, `/* */` block, `#` hash and trailing
// comments, plus `/** */` JSDoc, `///` doc comments, glued `//NOTE:`,
// attributed `NOTE(name):`, a NOTE line between two declarations, a Python
// docstring and a lowercase `// note:` (the marker contract is the exact
// uppercase literal, so the lowercase form is only a comment, not a marker).
describe('harvest NOTE marker fixture', () => {
  it('really contains the NOTE marker, so recognition is not vacuous', async () => {
    const files = (await fs.readdir(FIXTURE)).sort();
    expect(files).toHaveLength(12);
    const withMarker: string[] = [];
    for (const f of files) {
      if (/\bNOTE\b/.test(await fs.readFile(path.join(FIXTURE, f), 'utf8'))) withMarker.push(f);
    }
    // Only lower.ts is deliberately lowercase (`// note:`).
    expect(withMarker).toEqual(files.filter((f) => f !== 'lower.ts'));
  });

  it('recognizes NOTE comments across comment styles without proposing the marker', async () => {
    const candidates = await harvestRepo(FIXTURE, { git: false, minCount: 1, symbols: true });
    // No casing of the marker is proposed; the directory name bucket is the
    // only non-identifier candidate.
    for (const spelling of ['NOTE', 'Note', 'note', 'Notes']) {
      expect(candidates.map((c) => c.canonical)).not.toContain(spelling);
    }
    expect(candidates.filter((c) => c.category !== 'identifier')
      .map((c) => ({ canonical: c.canonical, category: c.category, evidence: c.evidence })))
      .toEqual([{ canonical: 'note-marker', category: 'product', evidence: ['directory name'] }]);

    const identifiers = candidates.filter((c) => c.category === 'identifier');
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.evidence]))).toEqual({
      OrbitBridge: ['line.ts'],
      PulsarLoader: ['block.ts'],
      VectorPlanner: ['hash.py'],
      QuartzRouter: ['trail.ts'],
      MeridianQueue: ['doc.ts'],
      SolarBridge: ['triple.ts'],
      CinderParser: ['nospace.ts'],
      LatticeRelay: ['attrib.ts'],
      EmberQueue: ['mid.ts'],
      CinderRelay: ['mid.ts'],
      EmberIndex: ['docstr.py'],
      CometScheduler: ['trail.py'],
      CraterRouter: ['lower.ts'],
    });
    // A NOTE comment does not alter surrounding text: the name in the
    // comment and the declaration beside it each count once, so files where
    // the name appears in both places report count 2; mid.ts brackets the
    // comment with a declaration on each side and still yields both names.
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.count]))).toEqual({
      OrbitBridge: 2,
      PulsarLoader: 2,
      VectorPlanner: 2,
      QuartzRouter: 1,
      MeridianQueue: 2,
      SolarBridge: 2,
      CinderParser: 2,
      LatticeRelay: 2,
      EmberQueue: 2,
      CinderRelay: 2,
      EmberIndex: 2,
      CometScheduler: 1,
      CraterRouter: 2,
    });
    for (const c of identifiers) {
      expect(c.source).toBe('harvest:repo');
      expect(c.suggestedAliases).toEqual([]);
    }
  });

  it('holds the comment-adjacent names as symbols-only without `symbols`', async () => {
    const held = await harvestReport(FIXTURE, { git: false, minCount: 1 });
    expect(held.candidates.map((c) => c.canonical)).toEqual(['note-marker']);
    expect(held.symbolsOnly).toBe(13);
    expect(held.filesScanned).toBe(12);
    expect(held.truncated).toBe(false);
    expect(held.belowMinCount).toBe(0);

    const rep = await harvestReport(FIXTURE, { git: false, minCount: 1, symbols: true });
    expect(rep.symbolsOnly).toBe(0);
    expect(rep.belowMinCount).toBe(0);
    expect(rep.filesScanned).toBe(12);
  });
});
