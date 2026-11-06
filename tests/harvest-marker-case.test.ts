import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

describe('harvest marker case', () => {
  it.each(['TODO', 'FIXME', 'NOTE', 'HACK', 'XXX'])(
    'scans names beside uppercase and lowercase %s without changing the source',
    async (marker) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-case-'));
      const file = path.join(dir, 'markers.ts');
      const source = `// ${marker}: QuasarWidget\n// ${marker.toLowerCase()}: QuasarWidget\n// FixMe: OrbitWidget\n`;
      try {
        await fs.writeFile(file, source);
        const candidates = await harvestRepo(dir, { git: false, minCount: 1, symbols: true });
        const identifiers = candidates.filter((candidate) => candidate.category === 'identifier');
        expect(identifiers.map(({ canonical, count, evidence }) => ({ canonical, count, evidence })))
          .toEqual([
            { canonical: 'QuasarWidget', count: 2, evidence: ['markers.ts'] },
            { canonical: 'FixMe', count: 1, evidence: ['markers.ts'] },
            { canonical: 'OrbitWidget', count: 1, evidence: ['markers.ts'] },
          ]);
        // Lowercase text is not an exact marker; it also fails the identifier pattern.
        expect(identifiers.map((candidate) => candidate.canonical)).not.toContain(marker.toLowerCase());
        expect(await fs.readFile(file, 'utf8')).toBe(source);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
