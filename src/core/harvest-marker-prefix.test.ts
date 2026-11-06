import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harvestRepo } from './harvest.js';

const markers = [
  { marker: 'TODO', prose: 'Todoquasar', identifier: 'TodoQuasar' },
  { marker: 'FIXME', prose: 'Fixmequasar', identifier: 'FixmeQuasar' },
  { marker: 'NOTE', prose: 'Notequasar', identifier: 'NoteQuasar' },
  { marker: 'HACK', prose: 'Hackquasar', identifier: 'HackQuasar' },
  { marker: 'XXX', prose: 'Xxxquasar', identifier: 'XxxQuasar' },
];

let tmp: string;
let repo: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-marker-prefix-'));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('harvest marker prefixes', () => {
  it.each(markers)('keeps README words starting with $marker, but not the standalone marker', async ({ marker, prose }) => {
    await fs.writeFile(path.join(repo, 'README.md'),
      `We use ${prose} and ${prose} connects the community.\n${marker}: revisit this.\n`);

    const candidates = await harvestRepo(repo, { git: false, minCount: 1 });
    expect(candidates.find((candidate) => candidate.canonical === prose)).toMatchObject({
      category: 'brand', source: 'harvest:repo', count: 2, evidence: ['README.md'],
    });
    expect(candidates.map((candidate) => candidate.canonical)).not.toContain(marker);
  });

  it.each(markers)('keeps PascalCase identifiers starting with $marker, but not the standalone marker', async ({ marker, identifier }) => {
    await fs.writeFile(path.join(repo, 'marker.ts'),
      `// ${marker}: revisit this\nclass ${identifier} {}\nclass ${identifier} {}\n`);

    const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
    expect(candidates.find((candidate) => candidate.canonical === identifier)).toMatchObject({
      category: 'identifier', source: 'harvest:repo', count: 2, evidence: ['marker.ts'],
    });
    expect(candidates.map((candidate) => candidate.canonical)).not.toContain(marker);
  });

  it('applies identifier casing rules to standalone markers and their prefixes', async () => {
    await fs.writeFile(path.join(repo, 'marker.ts'), [
      '// ToDo FixMe TODOQuasar FIXMEQuasar',
      '// ToDo FixMe TODOQuasar FIXMEQuasar',
    ].join('\n'));

    const candidates = await harvestRepo(repo, { git: false, minCount: 1, symbols: true });
    const names = candidates.map((candidate) => candidate.canonical);
    expect(names).not.toContain('ToDo');
    expect(names).toContain('FixMe');
    expect(names).not.toContain('TODOQuasar');
    expect(names).not.toContain('FIXMEQuasar');
  });
});
