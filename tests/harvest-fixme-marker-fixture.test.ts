import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { harvestRepo, harvestReport } from '../src/core/harvest.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fixme-marker');

// The committed fixture exercises every FIXME comment style the harvester
// meets in real source: `//` line, `/* */` block, `#` hash and trailing
// comments, plus `/** */` JSDoc, `///` doc comments, glued `//FIXME:`,
// attributed `FIXME(maintainer):`, a FIXME line between two declarations, a
// Python docstring, a FIXME inside a string literal, a lowercase `// fixme:`
// (the marker contract is the exact uppercase literal, so the lowercase form
// is only a comment, not a marker) and the mixed-case `// FixMe:` (a
// different string under the same contract, harvested like any other
// identifier).
describe('harvest FIXME marker fixture', () => {
  it('recognizes FIXME comments across comment styles without proposing the marker', async () => {
    const candidates = await harvestRepo(FIXTURE, { git: false, minCount: 1, symbols: true });
    // No casing of the marker literal is proposed (`FixMe` is not the marker
    // under the exact-case contract and is an identifier candidate like any
    // other); the directory name bucket is the only non-identifier candidate.
    for (const spelling of ['FIXME', 'Fixme', 'fixme']) {
      expect(candidates.map((c) => c.canonical)).not.toContain(spelling);
    }
    expect(candidates.filter((c) => c.category !== 'identifier')
      .map((c) => ({ canonical: c.canonical, category: c.category, evidence: c.evidence })))
      .toEqual([{ canonical: 'fixme-marker', category: 'product', evidence: ['directory name'] }]);

    const identifiers = candidates.filter((c) => c.category === 'identifier');
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.evidence]))).toEqual({
      TritonCache: ['line.ts'],
      SignalForge: ['block.ts'],
      CobaltEngine: ['hash.py'],
      QuartzBeacon: ['trail.ts'],
      VertexBroker: ['doc.ts'],
      PulseGateway: ['triple.ts'],
      CinderVault: ['nospace.ts'],
      LumenRelay: ['attrib.ts'],
      NovaBroker: ['mid.ts'],
      CinderIndex: ['mid.ts'],
      OrbitIndex: ['docstr.py'],
      RiftScheduler: ['trail.py'],
      OnyxRouter: ['lower.ts'],
      AmberVault: ['string.ts'],
      FixMe: ['mixed.ts'],
      OnyxCache: ['mixed.ts'],
    });
    // A FIXME comment does not alter surrounding text: the name in the
    // comment and the declaration beside it each count once, so files where
    // the name appears in both places report count 2; mid.ts brackets the
    // comment with a declaration on each side and still yields both names.
    expect(Object.fromEntries(identifiers.map((c) => [c.canonical, c.count]))).toEqual({
      TritonCache: 2,
      SignalForge: 2,
      CobaltEngine: 2,
      QuartzBeacon: 1,
      VertexBroker: 2,
      PulseGateway: 2,
      CinderVault: 2,
      LumenRelay: 2,
      NovaBroker: 2,
      CinderIndex: 2,
      OrbitIndex: 2,
      RiftScheduler: 1,
      OnyxRouter: 2,
      AmberVault: 2,
      FixMe: 1,
      OnyxCache: 2,
    });
    for (const c of identifiers) {
      expect(c.source).toBe('harvest:repo');
      expect(c.suggestedAliases).toEqual([]);
    }
  });

  it('holds the comment-adjacent names as symbols-only without `symbols`', async () => {
    const held = await harvestReport(FIXTURE, { git: false, minCount: 1 });
    expect(held.candidates.map((c) => c.canonical)).toEqual(['fixme-marker']);
    expect(held.symbolsOnly).toBe(16);
    expect(held.filesScanned).toBe(14);
    expect(held.truncated).toBe(false);
    expect(held.belowMinCount).toBe(0);

    const rep = await harvestReport(FIXTURE, { git: false, minCount: 1, symbols: true });
    expect(rep.symbolsOnly).toBe(0);
    expect(rep.belowMinCount).toBe(0);
    expect(rep.filesScanned).toBe(14);
  });
});
