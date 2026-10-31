import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harvestRepo } from './harvest.js';

const markers = [
  { marker: 'TODO', prose: 'Mastodon' },
  { marker: 'FIXME', prose: 'Prefixme' },
  { marker: 'NOTE', prose: 'Annoteworthy' },
  { marker: 'HACK', prose: 'Shackleton' },
  { marker: 'XXX', prose: 'Oxxxana' },
];

let tmp: string;
let repo: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-markers-'));
  repo = path.join(tmp, 'repo');
  await fs.mkdir(repo);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('harvest marker boundaries', () => {
  it('applies candidate casing rules without removing marker comments', async () => {
    await fs.writeFile(path.join(repo, 'marker.ts'), [
      '// TODO: QuasarWidget',
      '// TODO: QuasarWidget',
      '// todo: revisit this',
      '// ToDo: revisit this',
      '// ToDo: revisit this',
      '// FixMe: revisit this',
      '// FixMe: revisit this',
    ].join('\n'));

    const candidates = await harvestRepo(repo, { git: false, symbols: true });
    for (const canonical of ['QuasarWidget', 'FixMe']) {
      expect(candidates.find((candidate) => candidate.canonical === canonical)).toMatchObject({
        category: 'identifier', count: 2, evidence: ['marker.ts'],
      });
    }
    expect(candidates.map((candidate) => candidate.canonical)).not.toContain('TODO');
    expect(candidates.map((candidate) => candidate.canonical)).not.toContain('todo');
    expect(candidates.map((candidate) => candidate.canonical)).not.toContain('ToDo');
  });

  it('accepts mixed-case ToDo in README prose while filtering Todo and Note', async () => {
    await fs.writeFile(path.join(repo, 'README.md'),
      'We use ToDo and ToDo connects the community. We mention Todo and Todo, Note and Note.\n');

    const candidates = await harvestRepo(repo, { git: false });
    expect(candidates.find((candidate) => candidate.canonical === 'ToDo')).toMatchObject({
      category: 'brand', count: 2, evidence: ['README.md'],
    });
    expect(candidates.map((candidate) => candidate.canonical)).not.toContain('Todo');
    expect(candidates.map((candidate) => candidate.canonical)).not.toContain('Note');
  });

  it.each(markers)('retains README names containing $marker while excluding the complete marker', async ({ marker, prose }) => {
    await fs.writeFile(path.join(repo, 'README.md'),
      `We use ${prose} and ${prose} connects the community.\n${marker}: revisit this.\n`);

    const candidates = await harvestRepo(repo, { git: false });
    expect(candidates.find((candidate) => candidate.canonical === prose)).toMatchObject({
      category: 'brand', source: 'harvest:repo', count: 2, evidence: ['README.md'],
    });
    expect(candidates.map((candidate) => candidate.canonical)).not.toContain(marker);
  });

  it.each(markers)('retains identifiers containing $marker at each position', async ({ marker }) => {
    // PascalCase requires a lowercase run after its first capital.
    const identifiers = [
      `${marker[0]}${marker.slice(1).toLowerCase()}Quasar`,
      `Quasar${marker}Widget`,
      `Quasar${marker}`,
    ];
    await fs.writeFile(path.join(repo, 'marker.ts'),
      `// ${marker}: revisit this\n${identifiers.map((name) => `class ${name} {}\nclass ${name} {}`).join('\n')}\n`);

    const candidates = await harvestRepo(repo, { git: false, symbols: true });
    for (const canonical of identifiers) {
      expect(candidates.find((candidate) => candidate.canonical === canonical)).toMatchObject({
        category: 'identifier', source: 'harvest:repo', count: 2, evidence: ['marker.ts'],
      });
    }
    expect(candidates.map((candidate) => candidate.canonical)).not.toContain(marker);

    const withoutSymbols = await harvestRepo(repo, { git: false });
    for (const canonical of identifiers) {
      expect(withoutSymbols.map((candidate) => candidate.canonical)).not.toContain(canonical);
    }
  });
});
