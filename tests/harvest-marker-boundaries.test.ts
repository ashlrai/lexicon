import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harvestRepo } from '../src/core/harvest.js';

describe('harvest marker boundaries', () => {
  it.each(['TODO', 'FIXME', 'NOTE', 'HACK', 'XXX'])(
    'keeps whole identifiers containing %s while ignoring standalone occurrences',
    async (marker) => {
      const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-boundary-'));
      try {
        const suffix = `Quasar${marker}`;
        const middle = `Nebula${marker}Beacon`;
        await fs.writeFile(path.join(repo, 'markers.ts'), [
          `// ${marker}: (${marker}) [${marker}]`,
          `// ${suffix} ${middle}`,
          `const text = '${suffix} ${middle}';`,
          // ASCII word characters prevent a separate match at Quasar/Nebula.
          `x${suffix} _${suffix} 2${suffix}`,
          `x${middle} _${middle} 2${middle}`,
          // The scan has a boundary after punctuation and non-ASCII letters.
          `-${suffix} é${middle}`,
        ].join('\n'));

        const candidates = await harvestRepo(repo, { git: false, symbols: true, minCount: 1 });
        const identifiers = candidates.filter((candidate) => candidate.category === 'identifier');
        expect(identifiers.map(({ canonical, count, evidence }) => ({ canonical, count, evidence })))
          .toEqual(expect.arrayContaining([
            { canonical: suffix, count: 3, evidence: ['markers.ts'] },
            { canonical: middle, count: 3, evidence: ['markers.ts'] },
          ]));
        expect(identifiers.map(({ canonical }) => canonical).sort()).toEqual([middle, suffix].sort());
      } finally {
        await fs.rm(repo, { recursive: true, force: true });
      }
    },
  );

  it.each(['TODO', 'FIXME', 'NOTE', 'HACK', 'XXX'])(
    'counts %s embedded in README names without counting the standalone marker',
    async (marker) => {
      const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-prose-'));
      try {
        const name = `Quasar${marker}Beacon`;
        await fs.writeFile(path.join(repo, 'README.md'), `We use ${marker}, ${name}, and ${name}.\n`);

        const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
        const brands = candidates.filter((candidate) => candidate.category === 'brand');
        expect(brands.map(({ canonical, count, evidence }) => ({ canonical, count, evidence })))
          .toEqual([{ canonical: name, count: 2, evidence: ['README.md'] }]);
      } finally {
        await fs.rm(repo, { recursive: true, force: true });
      }
    },
  );
});
