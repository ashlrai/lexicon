import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { harvestRepo, harvestReport } from '../src/core/harvest.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hack-marker');

// The committed fixture exercises every HACK comment style the harvester
// meets in real source: `//` line, `/* */` block, `#` hash and trailing
// comments, plus `/** */` JSDoc, `///` doc comments, glued `//HACK:`,
// attributed `HACK(maintainer):`, a HACK line between two declarations, a
// Python docstring, a HACK inside a string literal, a bare `// HACK:` line
// with no declaration under it, a lowercase `// hack:` and the sentence-case
// `// Hack:` (both are only comments: the marker contract is the exact
// uppercase literal, and neither spelling satisfies the source identifier
// pattern, so nothing is proposed for them).
describe('harvest HACK marker fixture', () => {
  it('recognizes HACK comments across comment styles without proposing the marker', async () => {
    const candidates = await harvestRepo(FIXTURE, { git: false, minCount: 1, symbols: true });
    // No casing of the marker is proposed; the directory name bucket is the
    // only non-identifier candidate. `Hack` has a single hump, so unlike
    // `FixMe` it is not an identifier candidate either.
    for (const spelling of ['HACK', 'Hack', 'hack']) {
      expect(candidates.map((c) => c.canonical)).not.toContain(spelling);
    }
    expect(candidates.filter((c) => c.category !== 'identifier')
      .map((c) => ({ canonical: c.canonical, category: c.category, evidence: c.evidence })))
      .toEqual([{ canonical: 'hack-marker', category: 'product', evidence: ['directory name'] }]);

    const identifiers = candidates.filter((c) => c.category === 'identifier');
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.evidence]))).toEqual({
      CobaltCache: ['line.ts'],
      ZenithForge: ['block.ts'],
      SignalPlanner: ['hash.py'],
      PhotonBeacon: ['trail.ts'],
      VertexQueue: ['doc.ts'],
      CinderGateway: ['triple.ts'],
      QuartzVault: ['nospace.ts'],
      LumenBroker: ['attrib.ts'],
      EmberBroker: ['mid.ts'],
      AsterQueue: ['mid.ts'],
      MeteorCache: ['lower.ts'],
      CraterRelay: ['mixed.ts'],
      AmberForge: ['string.ts'],
      SolarIndex: ['docstr.py'],
      CometPlanner: ['trail.py'],
      NebulaGateway: ['workaround.ts'],
    });
    // A HACK comment does not alter surrounding text: the name in the
    // comment and the declaration beside it each count once, so files where
    // the name appears in both places report count 2; mid.ts brackets the
    // comment with a declaration on each side and still yields both names.
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.count]))).toEqual({
      CobaltCache: 2,
      ZenithForge: 2,
      SignalPlanner: 2,
      PhotonBeacon: 1,
      VertexQueue: 2,
      CinderGateway: 2,
      QuartzVault: 2,
      LumenBroker: 2,
      EmberBroker: 2,
      AsterQueue: 2,
      MeteorCache: 2,
      CraterRelay: 2,
      AmberForge: 2,
      SolarIndex: 2,
      CometPlanner: 1,
      NebulaGateway: 1,
    });
    for (const c of identifiers) {
      expect(c.source).toBe('harvest:repo');
      expect(c.suggestedAliases).toEqual([]);
    }
  });

  it('holds the comment-adjacent names as symbols-only without `symbols`', async () => {
    const held = await harvestReport(FIXTURE, { git: false, minCount: 1 });
    expect(held.candidates.map((c) => c.canonical)).toEqual(['hack-marker']);
    expect(held.symbolsOnly).toBe(16);
    expect(held.filesScanned).toBe(15);
    expect(held.truncated).toBe(false);
    expect(held.belowMinCount).toBe(0);

    const rep = await harvestReport(FIXTURE, { git: false, minCount: 1, symbols: true });
    expect(rep.symbolsOnly).toBe(0);
    expect(rep.belowMinCount).toBe(0);
    expect(rep.filesScanned).toBe(15);
  });
});
