import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { harvestRepo, harvestReport } from '../src/core/harvest.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'xxx-marker');

// The committed fixture exercises every XXX comment style the harvester
// meets in real source: `//` line, `/* */` block, `#` hash and trailing
// comments, plus `/** */` JSDoc, `///` doc comments, glued `//XXX:`,
// attributed `XXX(maintainer):`, an XXX line between two declarations, a
// Python docstring and a lowercase `// xxx:` (the marker contract is the
// exact uppercase literal, so the lowercase form is only a comment, not a
// marker).
describe('harvest XXX marker fixture', () => {
  it('recognizes XXX comments across comment styles without proposing the marker', async () => {
    const candidates = await harvestRepo(FIXTURE, { git: false, minCount: 1, symbols: true });
    // No casing of the marker is proposed; the directory name bucket is the
    // only non-identifier candidate.
    for (const spelling of ['XXX', 'Xxx', 'xxx']) {
      expect(candidates.map((c) => c.canonical)).not.toContain(spelling);
    }
    expect(candidates.filter((c) => c.category !== 'identifier')
      .map((c) => ({ canonical: c.canonical, category: c.category, evidence: c.evidence })))
      .toEqual([{ canonical: 'xxx-marker', category: 'product', evidence: ['directory name'] }]);

    const identifiers = candidates.filter((c) => c.category === 'identifier');
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.evidence]))).toEqual({
      OrbitLoader: ['line.ts'],
      HelixPlanner: ['block.ts'],
      VectorBridge: ['hash.py'],
      PhotonRouter: ['trail.ts'],
      NebulaQueue: ['doc.ts'],
      ZenithBridge: ['triple.ts'],
      VortexParser: ['nospace.ts'],
      CobaltRelay: ['attrib.ts'],
      NovaQueue: ['mid.ts'],
      AsterRelay: ['mid.ts'],
      AuroraIndex: ['docstr.py'],
      QuarkScheduler: ['trail.py'],
      MeteorRouter: ['lower.ts'],
    });
    // An XXX comment does not alter surrounding text: the name in the
    // comment and the declaration beside it each count once, so files where
    // the name appears in both places report count 2; mid.ts brackets the
    // comment with a declaration on each side and still yields both names.
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.count]))).toEqual({
      OrbitLoader: 2,
      HelixPlanner: 2,
      VectorBridge: 2,
      PhotonRouter: 1,
      NebulaQueue: 2,
      ZenithBridge: 2,
      VortexParser: 2,
      CobaltRelay: 2,
      NovaQueue: 2,
      AsterRelay: 2,
      AuroraIndex: 2,
      QuarkScheduler: 1,
      MeteorRouter: 2,
    });
    for (const c of identifiers) {
      expect(c.source).toBe('harvest:repo');
      expect(c.suggestedAliases).toEqual([]);
    }
  });

  it('holds the comment-adjacent names as symbols-only without `symbols`', async () => {
    const held = await harvestReport(FIXTURE, { git: false, minCount: 1 });
    expect(held.candidates.map((c) => c.canonical)).toEqual(['xxx-marker']);
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
